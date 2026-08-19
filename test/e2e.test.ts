import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// the compiled CLI next to this compiled test: test-dist/test/e2e.test.js → test-dist/src/index.js
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function snuff(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function repo(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'snuff-e2e-'));
  writeFileSync(join(dir, 'snuff.yaml'), manifest);
  return dir;
}

test('--hook outside a git repo: full run with a one-line stderr note, not exit 1', () => {
  const dir = repo('gates:\n  - name: a\n    run: echo ok\n    paths: [src/**]\n');
  const r = snuff(dir, '--hook');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^snuff: --hook: not a git repo — running all gates$/m);
  // the gate really ran (a --changed skip would have left no log)
  const shown = snuff(dir, '--show', 'a');
  assert.equal(shown.out.trim(), 'ok');
  // an explicit --changed still refuses outside git
  const changed = snuff(dir, '--changed');
  assert.equal(changed.code, 1);
  assert.match(changed.err, /--changed needs git/);
  rmSync(dir, { recursive: true, force: true });
});

test('leading "which manifest" line: first stdout line on a normal run, absent from --json, present on stderr before a --hook red matrix', () => {
  const dir = repo('gates:\n  - name: a\n    run: echo ok\n');
  // process.cwd() in the spawned CLI resolves symlinks (e.g. macOS /var -> /private/var) — match that.
  const manifestPath = join(realpathSync(dir), 'snuff.yaml');
  const r = snuff(dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n')[0], `snuff.yaml: ${manifestPath}`);

  const j = snuff(dir, '--json');
  assert.equal(j.code, 0, j.err);
  assert.doesNotMatch(j.out, /^snuff\.yaml:/m);
  assert.deepEqual(JSON.parse(j.out).ok, true);

  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'snuff.yaml'), 'gates:\n  - name: red\n    run: exit 1\n');
  const h = snuff(dir, '--hook');
  assert.equal(h.code, 2);
  const errLines = h.err.split('\n');
  assert.equal(errLines[0], `snuff.yaml: ${manifestPath}`);
  rmSync(dir, { recursive: true, force: true });
});

test('--rerun-failed with --tag is rejected instead of one silently winning', () => {
  const dir = repo('gates:\n  - name: a\n    run: exit 1\n    tags: [t]\n');
  snuff(dir);
  const r = snuff(dir, '--rerun-failed', '--tag', 't');
  assert.equal(r.code, 1);
  assert.match(r.err, /--rerun-failed cannot be combined with --tag/);
  rmSync(dir, { recursive: true, force: true });
});

test('--all <nonexistent> → `snuff: --all: no such dir <p>`, exit 1', () => {
  const r = snuff(tmpdir(), '--all', '/no/such/fleet');
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'snuff: --all: no such dir /no/such/fleet');
});

test('--hook blocks once per distinct red: same red → exit 0 "still red"; stop_hook_active → exit 0; new red blocks again; green clears', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snuff-loop-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const manifest = (msg: string, ok = false) =>
    writeFileSync(join(dir, 'snuff.yaml'), `gates:\n  - name: red\n    run: ${ok ? 'true' : `echo ${msg}; exit 1`}\n`);
  const hook = (input: string) => spawnSync(process.execPath, [CLI, '--hook'], { cwd: dir, input, encoding: 'utf8' });
  manifest('boom');
  let r = hook('{"stop_hook_active":false}');
  assert.equal(r.status, 2);
  r = hook('{"stop_hook_active":false}');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /still red \(red\) — same as the last blocked Stop/);
  r = hook('{"stop_hook_active":true}');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /already blocked this turn/);
  manifest('boom2');
  r = hook('{}');
  assert.equal(r.status, 2, 'a different red blocks again');
  manifest('', true);
  r = hook('{}');
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(dir, '.snuff', 'last-block.json')), false);
});
