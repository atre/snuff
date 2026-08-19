import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGha, renderProgress, renderStepSummary, renderText, toJson } from '../src/render.js';
import type { GateResult } from '../src/types.js';

test('renderText: a missing-tool result shows "missing: x" as the why-line, no duplicate excerpt', () => {
  const result: GateResult = {
    gate: { name: 'tf-validate', run: 'tofu validate', requires: ['tofu'] },
    ok: false,
    exitCode: null,
    timedOut: false,
    durationMs: 2,
    output: 'missing: tofu',
  };
  const text = renderText([result]);
  assert.match(text, /✗ tf-validate → missing: tofu/);
  assert.equal(text.split('\n').filter((l) => l.includes('missing: tofu')).length, 1);
});

test('renderText: a spawn error (not a requires: miss) keeps the "exit ?" why-line', () => {
  const result: GateResult = {
    gate: { name: 'g', run: 'nonexistent-cmd-xyz' },
    ok: false,
    exitCode: null,
    timedOut: false,
    durationMs: 2,
    output: 'Error: spawn nonexistent-cmd-xyz ENOENT',
  };
  const text = renderText([result]);
  assert.match(text, /✗ g → exit \?/);
  assert.match(text, /Error: spawn nonexistent-cmd-xyz ENOENT/);
});

function passing(name: string, durationMs: number): GateResult {
  return { gate: { name, run: 'x' }, ok: true, exitCode: 0, timedOut: false, durationMs, output: '' };
}

test('renderText: (fixed) shown when fixed is true, absent otherwise', () => {
  const fixedResult: GateResult = { ...passing('lint', 1200), fixed: true };
  assert.match(renderText([fixedResult]), /✓ lint 1\.2s \(fixed\)/);

  const failedFixAttempt: GateResult = {
    gate: { name: 'lint', run: 'x' },
    ok: false,
    exitCode: 1,
    timedOut: false,
    durationMs: 1200,
    output: 'error: still broken',
    fixed: false,
  };
  assert.doesNotMatch(renderText([failedFixAttempt]).split('\n')[0], /\(fixed\)/);

  assert.doesNotMatch(renderText([passing('lint', 1200)]), /\(fixed\)/);
});

test('renderText: (passed on retry N) shown only when ok and attempts > 1', () => {
  const retried: GateResult = { ...passing('flaky', 800), attempts: 2 };
  assert.match(renderText([retried]), /✓ flaky 0\.8s \(passed on retry 1\)/);

  assert.doesNotMatch(renderText([passing('flaky', 800)]), /passed on retry/);
  assert.doesNotMatch(renderText([{ ...passing('flaky', 800), attempts: 1 }]), /passed on retry/);

  const stillRed: GateResult = {
    gate: { name: 'flaky', run: 'x' },
    ok: false,
    exitCode: 1,
    timedOut: false,
    durationMs: 800,
    output: 'error: nope',
    attempts: 3,
  };
  assert.doesNotMatch(renderText([stillRed]).split('\n')[0], /passed on retry/);
});

test('toJson: attempts defaults to 1, real count when retried', () => {
  const json = toJson([passing('a', 100), { ...passing('b', 100), attempts: 3 }]) as {
    gates: Array<{ name: string; attempts: number }>;
  };
  assert.equal(json.gates[0].attempts, 1);
  assert.equal(json.gates[1].attempts, 3);
});

test('renderText: a gate ≥2s and ≥50% slower than its previous run gets a (+N.Ns) suffix', () => {
  const text = renderText([passing('test', 14300)], { previous: new Map([['test', 5000]]) });
  assert.match(text, /✓ test 14s \(\+9\.3s\)/);
});

test('renderText: 10% slower (under the 50% threshold) shows no suffix', () => {
  const text = renderText([passing('test', 5500)], { previous: new Map([['test', 5000]]) });
  assert.doesNotMatch(text, /\(\+/);
});

test('renderText: 25% slower but under the 2s floor shows no suffix', () => {
  const text = renderText([passing('test', 2500)], { previous: new Map([['test', 2000]]) });
  assert.doesNotMatch(text, /\(\+/);
});

test('renderText: 3x slower but under the 2s floor shows no suffix', () => {
  const text = renderText([passing('test', 1500)], { previous: new Map([['test', 500]]) });
  assert.doesNotMatch(text, /\(\+/);
});

test('renderText: no previous map, or gate absent from it, is byte-identical to no-opts', () => {
  const results = [passing('test', 14300)];
  assert.equal(renderText(results), renderText(results, {}));
  assert.equal(renderText(results), renderText(results, { previous: new Map([['other', 1]]) }));
});

test('renderText: a skipped gate never gets a suffix', () => {
  const result: GateResult = {
    gate: { name: 'test', run: 'x' },
    ok: false,
    skipped: 'needs lint',
    exitCode: null,
    timedOut: false,
    durationMs: 9999,
    output: '',
  };
  const text = renderText([result], { previous: new Map([['test', 1]]) });
  assert.doesNotMatch(text, /\(\+/);
});

function failing(name: string, output: string, excerptLines?: number): GateResult {
  return {
    gate: { name, run: 'x', excerptLines },
    ok: false,
    exitCode: 1,
    timedOut: false,
    durationMs: 1,
    output,
  };
}

function excerptLinesOf(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('  '))
    .filter((l) => !l.includes('→'));
}

test('--lines N caps the excerpt at N lines', () => {
  const output = Array.from({ length: 10 }, (_, i) => `error: line ${i}`).join('\n');
  const text = renderText([failing('test', output)], { lines: 3 });
  assert.equal(excerptLinesOf(text).length, 3);
});

test('a gate excerptLines: wins over the global --lines', () => {
  const output = Array.from({ length: 10 }, (_, i) => `error: line ${i}`).join('\n');
  const text = renderText([failing('test', output, 2)], { lines: 10 });
  assert.equal(excerptLinesOf(text).length, 2);
});

test('no lines opt defaults to 15, byte-identical to today', () => {
  const output = Array.from({ length: 3 }, (_, i) => `error: line ${i}`).join('\n');
  const result = failing('test', output);
  assert.equal(renderText([result]), renderText([result], {}));
  assert.equal(renderText([result], {}), renderText([result], { lines: 15 }));
});

test('color: true wraps only the glyph, reset with \\x1b[0m', () => {
  const text = renderText([failing('test', 'error: boom')], { color: true });
  assert.match(text, /\x1b\[31m✗\x1b\[0m test/);
});

function skipped(name: string): GateResult {
  return { gate: { name, run: 'x' }, ok: false, skipped: 'needs lint', exitCode: null, timedOut: false, durationMs: 0, output: '' };
}

test('color: true — green for pass, yellow for allowFail, dim for skipped', () => {
  const allowFailGate: GateResult = {
    gate: { name: 'mypy', run: 'x', allowFail: true },
    ok: false,
    exitCode: 1,
    timedOut: false,
    durationMs: 1,
    output: '',
  };
  const text = renderText([passing('build', 100), allowFailGate, skipped('test')], { color: true });
  assert.match(text, /\x1b\[32m✓\x1b\[0m build/);
  assert.match(text, /\x1b\[33m⚠\x1b\[0m mypy/);
  assert.match(text, /\x1b\[2m–\x1b\[0m test/);
});

test('color defaults to false — no opts, or color: false, is byte-identical', () => {
  const results = [failing('test', 'error: boom'), skipped('other')];
  assert.equal(renderText(results), renderText(results, {}));
  assert.equal(renderText(results), renderText(results, { color: false }));
  assert.doesNotMatch(renderText(results), /\x1b\[/);
});

test('renderProgress: color wraps a done cell, leaves pending/running placeholders alone', () => {
  const gates = [{ name: 'a', run: 'x' }, { name: 'b', run: 'x' }, { name: 'c', run: 'x' }];
  const done = new Map([['a', passing('a', 100)]]);
  const running = new Set(['b']);
  const line = renderProgress(gates, done, running, true);
  assert.match(line, /\x1b\[32m✓\x1b\[0m a/);
  assert.match(line, /… b/);
  assert.match(line, /· c/);
  assert.equal(renderProgress(gates, done, running), renderProgress(gates, done, running, false));
});

test('renderGha: tsc-shaped excerpt line becomes a file/line/col annotation', () => {
  const result = failing('test', 'src/a.ts(3,5): error TS2322: x');
  assert.deepEqual(renderGha([result]), ['::error file=src/a.ts,line=3,col=5::error TS2322: x']);
});

test('renderGha: generic file:line[:col]: msg shape', () => {
  const result = failing('test', 'path/to/file.py:42: something broke');
  assert.deepEqual(renderGha([result]), ['::error file=path/to/file.py,line=42::something broke']);
});

test('renderGha: a line with no location shape falls back to a title-only annotation', () => {
  const result = failing('test', 'assertion failed, no location here');
  assert.deepEqual(renderGha([result]), ['::error title=test::assertion failed, no location here']);
});

test('renderGha: passing and skipped gates produce no annotations', () => {
  assert.deepEqual(renderGha([passing('a', 100), skipped('b')]), []);
});

test('renderStepSummary: one row per gate, failing gate shows ✗', () => {
  const summary = renderStepSummary([failing('test', 'error: boom')]);
  assert.ok(summary.includes('| test | ✗ |'));
  assert.ok(summary.startsWith('| gate | result | time |'));
});

test('renderStepSummary: passing gate shows ✓ with a duration', () => {
  const summary = renderStepSummary([passing('build', 1200)]);
  assert.match(summary, /\| build \| ✓ \| 1\.2s \|/);
});

test('renderText: trailing summary line is N/M gates Ts, using the slowest non-skipped gate as duration proxy', () => {
  const text = renderText([passing('a', 100), passing('b', 2200)]);
  assert.equal(text.split('\n').at(-1), '2/2 gates 2.2s');
});

test('renderText: an explicit durationMs opt wins over the proxy', () => {
  const text = renderText([passing('a', 100)], { durationMs: 5000 });
  assert.equal(text.split('\n').at(-1), '1/1 gates 5.0s');
});

test('renderText: summary counts skipped/allowFail gates as passed, a true red is not, skipped gates excluded from the duration proxy', () => {
  const allowFailRed: GateResult = {
    gate: { name: 'mypy', run: 'x', allowFail: true },
    ok: false,
    exitCode: 1,
    timedOut: false,
    durationMs: 50,
    output: '',
  };
  const text = renderText([passing('a', 100), failing('b', 'err'), skipped('c'), allowFailRed]);
  assert.equal(text.split('\n').at(-1), '3/4 gates 0.1s');
});

test('toJson: summary field mirrors renderText\'s N/M/duration logic, existing top-level keys untouched', () => {
  const json = toJson([passing('a', 100), passing('b', 3000)]) as {
    ok: boolean;
    gates: unknown[];
    summary: { passed: number; total: number; durationMs: number };
  };
  assert.deepEqual(json.summary, { passed: 2, total: 2, durationMs: 3000 });
  assert.equal(json.ok, true);
  assert.equal(json.gates.length, 2);
});

test('toJson: an explicit durationMs opt wins over the proxy', () => {
  const json = toJson([passing('a', 100)], { durationMs: 7000 }) as { summary: { durationMs: number } };
  assert.equal(json.summary.durationMs, 7000);
});
