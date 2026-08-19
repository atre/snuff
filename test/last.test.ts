import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failedNames, previousDurations, readLast, readLog, saveLast, writeLastResult } from '../src/last.js';
import { renderJson, renderText, toJson } from '../src/render.js';
import { runAll } from '../src/runner.js';
import type { GateResult } from '../src/types.js';

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `snuff-last-${tag}-`));
}

test('saveLast writes a log per gate and a last.json that round-trips', async () => {
  const dir = tmp('roundtrip');
  const results = await runAll([{ name: 'bad', run: 'echo boom; exit 1' }], dir);
  saveLast(dir, results);

  assert.equal(readFileSync(join(dir, '.snuff', 'last', 'bad.log'), 'utf8').trim(), 'boom');
  const parsed = JSON.parse(readFileSync(join(dir, '.snuff', 'last.json'), 'utf8')) as {
    gates: Array<{ gate: { name: string } }>;
  };
  assert.equal(parsed.gates[0].gate.name, 'bad');

  const last = readLast(dir);
  assert.ok(last);
  assert.equal(renderText(last.results), renderText(results));
  rmSync(dir, { recursive: true, force: true });
});

test('fixed/attempts markers survive the round-trip — --last renders byte-identical', async () => {
  const dir = tmp('markers');
  const results = await runAll(
    [
      { name: 'lint', run: 'test -f ok', fix: 'touch ok' },
      { name: 'flaky', run: 'test -f seen || { touch seen; exit 1; }', retries: 2 },
    ],
    dir,
    { fix: true },
  );
  assert.equal(results.find((r) => r.gate.name === 'lint')?.fixed, true);
  assert.equal(results.find((r) => r.gate.name === 'flaky')?.attempts, 2);
  saveLast(dir, results);

  const last = readLast(dir);
  assert.ok(last);
  const live = renderText(results);
  assert.match(live, /lint \S+ \(fixed\)/);
  assert.match(live, /flaky \S+ \(passed on retry 1\)/);
  assert.equal(renderText(last.results), live);
  assert.equal(renderJson(last.results), renderJson(results));
  const json = toJson(last.results).gates;
  assert.equal(json.find((g) => g.name === 'lint')?.fixed, true);
  assert.equal(json.find((g) => g.name === 'flaky')?.attempts, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('readLog returns verbatim output, undefined for an unknown gate', async () => {
  const dir = tmp('readlog');
  const results = await runAll([{ name: 'bad', run: 'echo boom; exit 1' }], dir);
  saveLast(dir, results);

  assert.equal(readLog(dir, 'bad')?.trim(), 'boom');
  assert.equal(readLog(dir, 'nope'), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('sanitizes gate names with path separators for the log filename', async () => {
  const dir = tmp('sanitize');
  const results = await runAll([{ name: 'web/lint', run: 'echo x' }], dir);
  saveLast(dir, results);

  assert.ok(readFileSync(join(dir, '.snuff', 'last', 'web_lint.log'), 'utf8').includes('x'));
  assert.equal(readLog(dir, 'web/lint')?.trim(), 'x');
  rmSync(dir, { recursive: true, force: true });
});

test('skipped gates get no log', async () => {
  const dir = tmp('skipped');
  const results = await runAll(
    [
      { name: 'a', run: 'exit 1' },
      { name: 'b', run: 'echo b', needs: ['a'] },
    ],
    dir,
  );
  saveLast(dir, results);

  assert.equal(readLog(dir, 'b'), undefined);
  const last = readLast(dir);
  const b = last?.results.find((r) => r.gate.name === 'b');
  assert.equal(b?.skipped, 'needs a');
  rmSync(dir, { recursive: true, force: true });
});

test('a partial run merges into the previous last.json instead of erasing it', async () => {
  const dir = tmp('merge');
  const full = await runAll(
    [
      { name: 'lint', run: 'exit 1' },
      { name: 'build', run: 'echo ok' },
    ],
    dir,
  );
  saveLast(dir, full);

  const partial = await runAll([{ name: 'lint', run: 'echo fixed' }], dir);
  saveLast(dir, partial);

  const last = readLast(dir);
  const names = last?.results.map((r) => r.gate.name).sort();
  assert.deepEqual(names, ['build', 'lint']);
  assert.equal(last?.results.find((r) => r.gate.name === 'lint')?.ok, true);
  assert.equal(last?.results.find((r) => r.gate.name === 'build')?.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test('previousDurations: no last.json → empty map', () => {
  const dir = tmp('no-last');
  assert.deepEqual(previousDurations(dir), new Map());
  rmSync(dir, { recursive: true, force: true });
});

test('previousDurations: reads durationMs per gate, excludes skipped gates', async () => {
  const dir = tmp('durations');
  const results = await runAll(
    [
      { name: 'a', run: 'exit 1' },
      { name: 'b', run: 'echo b', needs: ['a'] },
      { name: 'c', run: 'echo c' },
    ],
    dir,
  );
  saveLast(dir, results);

  const durations = previousDurations(dir);
  assert.ok(durations.has('a'));
  assert.ok(durations.has('c'));
  assert.equal(durations.has('b'), false, 'skipped gate must be excluded');
  rmSync(dir, { recursive: true, force: true });
});

test('previousDurations: must be read before saveLast overwrites the file', async () => {
  const dir = tmp('before-overwrite');
  const first = await runAll([{ name: 'x', run: 'sleep 0.01' }], dir);
  saveLast(dir, first);

  const previous = previousDurations(dir);
  const firstMs = previous.get('x');
  assert.ok(typeof firstMs === 'number' && firstMs >= 0);

  const second = await runAll([{ name: 'x', run: 'sleep 0.05' }], dir);
  saveLast(dir, second);

  // the map captured before the second saveLast still reflects the first run
  assert.equal(previous.get('x'), firstMs);
  rmSync(dir, { recursive: true, force: true });
});

test('previousDurations: corrupt last.json degrades to an empty map, no throw', () => {
  const dir = tmp('corrupt');
  mkdirSync(join(dir, '.snuff'), { recursive: true });
  writeFileSync(join(dir, '.snuff', 'last.json'), '{not json');
  assert.deepEqual(previousDurations(dir), new Map());
  rmSync(dir, { recursive: true, force: true });
});

test('failedNames: red not-allowFail gates, filtered to gates that still exist', () => {
  const mk = (over: Partial<GateResult> & { gate: GateResult['gate'] }): GateResult => ({
    ok: true,
    exitCode: 0,
    timedOut: false,
    durationMs: 0,
    output: '',
    ...over,
  });
  const results: GateResult[] = [
    mk({ gate: { name: 'lint', run: 'x' }, ok: false }),
    mk({ gate: { name: 'mypy', run: 'x', allowFail: true }, ok: false }),
    mk({ gate: { name: 'gone', run: 'x' }, ok: false }),
    mk({ gate: { name: 'build', run: 'x' }, ok: true }),
  ];
  const known = new Set(['lint', 'mypy', 'build']);
  assert.deepEqual(failedNames({ results }, known), ['lint']);
});

test('writeLastResult: slug is the absolute repo path with / and . turned into -, gates carry name/ok/skipped/allowFail/durationMs', async () => {
  const home = tmp('home');
  const results = await runAll(
    [
      { name: 'lint', run: 'exit 1' },
      { name: 'mypy', run: 'exit 1', allowFail: true },
      { name: 'build', run: 'echo ok', needs: ['lint'] },
    ],
    home,
  );
  writeLastResult('/Users/me/git/x', results, home);

  const path = join(home, '-Users-me-git-x.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    ts: number;
    head: string | null;
    cwd: string;
    ok: boolean;
    gates: Array<{ name: string; ok: boolean; skipped: string | null; allowFail: boolean; durationMs: number }>;
  };
  assert.equal(parsed.gates[0].name, 'lint');
  assert.equal(typeof parsed.ts, 'number');
  assert.ok(parsed.head === null || /^[0-9a-f]{40}$/.test(parsed.head));
  assert.equal(parsed.cwd, '/Users/me/git/x');
  assert.equal(parsed.ok, false);
  assert.deepEqual(
    parsed.gates.map((g) => g.name),
    ['lint', 'mypy', 'build'],
  );
  assert.equal(parsed.gates[0].ok, false);
  assert.equal(parsed.gates[0].skipped, null);
  assert.equal(parsed.gates[0].allowFail, false);
  assert.equal(parsed.gates[1].allowFail, true);
  assert.equal(parsed.gates[2].skipped, 'needs lint');
  assert.equal(typeof parsed.gates[0].durationMs, 'number');
  rmSync(home, { recursive: true, force: true });
});

test('writeLastResult: default home is SNUFF_HOME, errors are swallowed', async () => {
  const results = await runAll([{ name: 'x', run: 'echo ok' }], tmp('unused'));
  const bogusFile = join(tmpdir(), `snuff-not-a-dir-${Date.now()}`);
  writeFileSync(bogusFile, 'not a directory');
  // home points at a path that can't be mkdir'd (it's a file) — must not throw
  assert.doesNotThrow(() => writeLastResult('/repo', results, bogusFile));
  rmSync(bogusFile, { force: true });
});
