import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTimeoutS, runAll, runGate } from '../src/runner.js';

const cwd = process.cwd();

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `snuff-fix-${tag}-`));
}

test('passing gate', async () => {
  const r = await runGate({ name: 'ok', run: 'echo hi' }, cwd);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /hi/);
});

test('failing gate captures stderr and exit code', async () => {
  const r = await runGate({ name: 'bad', run: 'echo boom >&2; exit 3' }, cwd);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.output, /boom/);
});

test('timeout kills the whole process tree', { skip: process.platform === 'win32' }, async () => {
  // grandchild sleep in the background of a shell — killing only `sh` would leave it alive
  const r = await runGate({ name: 'slow', run: 'sleep 30 & wait', timeout: 0.3 }, cwd);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 5000, `took ${r.durationMs}ms`);
});

test('defaultTimeoutS: SNUFF_TIMEOUT overrides; invalid or unset falls back to 600', () => {
  assert.equal(defaultTimeoutS({ SNUFF_TIMEOUT: '0.3' }), 0.3);
  assert.equal(defaultTimeoutS({ SNUFF_TIMEOUT: 'x' }), 600);
  assert.equal(defaultTimeoutS({ SNUFF_TIMEOUT: '0' }), 600);
  assert.equal(defaultTimeoutS({}), 600);
});

test('SNUFF_TIMEOUT: makes a gate with no own timeout time out early', { skip: process.platform === 'win32' }, async () => {
  const prev = process.env.SNUFF_TIMEOUT;
  process.env.SNUFF_TIMEOUT = '0.3';
  try {
    const r = await runGate({ name: 'slow', run: 'sleep 5' }, cwd);
    assert.equal(r.timedOut, true);
    assert.ok(r.durationMs < 3000, `took ${r.durationMs}ms`);
  } finally {
    if (prev === undefined) delete process.env.SNUFF_TIMEOUT;
    else process.env.SNUFF_TIMEOUT = prev;
  }
});

test('requires: a missing tool short-circuits without spawning', async () => {
  const r = await runGate({ name: 'r', run: 'echo hi', requires: ['definitely-not-a-tool-xyz'] }, cwd);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, null);
  assert.equal(r.timedOut, false);
  assert.equal(r.output, 'missing: definitely-not-a-tool-xyz');
  assert.ok(r.durationMs < 50, `took ${r.durationMs}ms`);
});

test('requires: two missing tools are both named', async () => {
  const r = await runGate(
    { name: 'r', run: 'echo hi', requires: ['definitely-not-a-tool-xyz', 'also-not-a-tool'] },
    cwd,
  );
  assert.equal(r.output, 'missing: definitely-not-a-tool-xyz, also-not-a-tool');
});

test('requires: a resolvable tool runs normally', async () => {
  const r = await runGate({ name: 'r', run: 'echo hi', requires: ['sh'] }, cwd);
  assert.equal(r.ok, true);
  assert.match(r.output, /hi/);
});

test('fix: with --fix runs the fixer on failure, then re-checks once', async () => {
  const dir = tmp('ok');
  const r = await runGate({ name: 'g', run: 'test -f m', fix: 'touch m' }, dir, { fix: true });
  assert.equal(r.ok, true);
  assert.equal(r.fixed, true);
  rmSync(dir, { recursive: true, force: true });
});

test('fix: without the --fix option, the fixer never runs', async () => {
  const dir = tmp('nooption');
  const r = await runGate({ name: 'g', run: 'test -f m', fix: 'touch m' }, dir);
  assert.equal(r.ok, false);
  assert.equal(r.fixed, undefined);
  assert.equal(existsSync(join(dir, 'm')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('fix: a fixer that runs but does not actually fix it is recorded, not silent', async () => {
  const dir = tmp('failstill');
  const r = await runGate({ name: 'g', run: 'exit 1', fix: 'true' }, dir, { fix: true });
  assert.equal(r.ok, false);
  assert.equal(r.fixed, false);
  rmSync(dir, { recursive: true, force: true });
});

test('no fix: on a gate with no fix:, --fix is a no-op — unaffected, single spawn', async () => {
  const r = await runGate({ name: 'ok', run: 'echo hi' }, cwd, { fix: true });
  assert.equal(r.ok, true);
  assert.equal(r.fixed, undefined);
});

test('retries: a gate that fails once then passes succeeds on the retry', async () => {
  const dir = tmp('retry-ok');
  const r = await runGate(
    { name: 'f', run: 'test -f flag || { touch flag; exit 1; }', retries: 1 },
    dir,
  );
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('retries: 0 (or absent) behaves identically to today — no attempts key, single spawn', async () => {
  const r0 = await runGate({ name: 'ok', run: 'echo hi', retries: 0 }, cwd);
  assert.equal(r0.attempts, undefined);
  const rAbsent = await runGate({ name: 'ok', run: 'echo hi' }, cwd);
  assert.equal(rAbsent.attempts, undefined);
});

test('retries: exhausted and still red — attempts is the max, no crash', async () => {
  const r = await runGate({ name: 'always-red', run: 'exit 1', retries: 2 }, cwd);
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
});

test('retries: a timeout on the first attempt is not retried', { skip: process.platform === 'win32' }, async () => {
  const r = await runGate({ name: 'slow', run: 'sleep 30 & wait', timeout: 0.3, retries: 3 }, cwd);
  assert.equal(r.timedOut, true);
  assert.equal(r.attempts, 1);
});

test('when: false skips the gate with a "when: <cond> false" reason, run: never spawns', async () => {
  const r = await runGate({ name: 'a', run: 'echo x', when: 'false' }, cwd);
  assert.equal(r.skipped, 'when: false false');
  assert.equal(r.output, '');
});

test('when: does not block a dependent gate', async () => {
  const gates = [
    { name: 'a', run: 'echo x', when: 'false' },
    { name: 'b', run: 'echo b', needs: ['a'] },
  ];
  const rs = await runAll(gates, cwd);
  const by = Object.fromEntries(rs.map((r) => [r.gate.name, r]));
  assert.equal(by.a.skipped, 'when: false false');
  assert.equal(by.b.ok, true);
});

test('when: true (via env) runs the gate normally', async () => {
  const r = await runGate({ name: 'a', run: 'echo x', when: 'test -n "$CI"', env: { CI: '1' } }, cwd);
  assert.equal(r.skipped, undefined);
  assert.equal(r.ok, true);
  assert.match(r.output, /x/);
});

test('when: same condition without the env var present skips', async () => {
  const r = await runGate({ name: 'a', run: 'echo x', when: 'test -n "$CI"' }, cwd);
  assert.equal(r.skipped, 'when: test -n "$CI" false');
});

test('a real hard failure still blocks its dependents (blocking-condition fix does not loosen this)', async () => {
  const gates = [
    { name: 'a', run: 'exit 1' },
    { name: 'b', run: 'echo b', needs: ['a'] },
  ];
  const rs = await runAll(gates, cwd);
  const by = Object.fromEntries(rs.map((r) => [r.gate.name, r]));
  assert.equal(by.a.ok, false);
  assert.equal(by.a.skipped, undefined);
  assert.equal(by.b.skipped, 'needs a');
});

test('env and cwd are applied', async () => {
  const r = await runGate({ name: 'e', run: 'echo $SNUFF_X && pwd', env: { SNUFF_X: 'hello' }, cwd: 'src' }, cwd);
  assert.match(r.output, /hello/);
  assert.match(r.output, /\/src\s*$/);
});

test('runAll: needs ordering, failure cascades to skip, results in manifest order', async () => {
  const gates = [
    { name: 'c', run: 'echo c', needs: ['b'] },
    { name: 'a', run: 'exit 1' },
    { name: 'b', run: 'echo b', needs: ['a'] },
    { name: 'd', run: 'echo d' },
    { name: 'w', run: 'exit 1', allowFail: true },
    { name: 'e', run: 'echo e', needs: ['w'] },
  ];
  const rs = await runAll(gates, cwd, { jobs: 4 });
  assert.deepEqual(rs.map((r) => r.gate.name), ['c', 'a', 'b', 'd', 'w', 'e']);
  const by = Object.fromEntries(rs.map((r) => [r.gate.name, r]));
  assert.equal(by.a.ok, false);
  assert.equal(by.b.skipped, 'needs a');
  assert.equal(by.c.skipped, 'needs b');
  assert.equal(by.d.ok, true);
  assert.equal(by.w.ok, false);
  assert.equal(by.e.ok, true, 'allowFail need must not block');
});

test('runAll: pre-skip (--changed) does not block dependents; jobs cap respected', async () => {
  const gates = [
    { name: 'a', run: 'sleep 0.2; echo a' },
    { name: 'b', run: 'sleep 0.2; echo b' },
    { name: 'c', run: 'echo c', needs: ['a'] },
  ];
  const t0 = Date.now();
  const rs = await runAll(gates, cwd, { jobs: 1, skip: new Map([['a', 'no changes in paths']]) });
  const by = Object.fromEntries(rs.map((r) => [r.gate.name, r]));
  assert.equal(by.a.skipped, 'no changes in paths');
  assert.equal(by.c.ok, true);
  assert.ok(Date.now() - t0 < 2000);
  // parallel: two 0.2s sleeps finish well under 0.4s
  const t1 = Date.now();
  await runAll(gates.slice(0, 2), cwd, { jobs: 2 });
  assert.ok(Date.now() - t1 < 380, `parallel took ${Date.now() - t1}ms`);
});

test('--fail-fast: stops launching after the first hard failure', async () => {
  const gates = [
    { name: 'a', run: 'exit 1' },
    { name: 'b', run: 'sleep 0.5; echo b' },
  ];
  const t0 = Date.now();
  const rs = await runAll(gates, cwd, { jobs: 1, failFast: true });
  const by = Object.fromEntries(rs.map((r) => [r.gate.name, r]));
  assert.equal(by.b.skipped, 'fail-fast');
  assert.ok(Date.now() - t0 < 400, `took ${Date.now() - t0}ms`);
});

test('without --fail-fast, pending gates still launch normally', async () => {
  const gates = [
    { name: 'a', run: 'exit 1' },
    { name: 'b', run: 'sleep 0.5; echo b' },
  ];
  const rs = await runAll(gates, cwd, { jobs: 1 });
  const by = Object.fromEntries(rs.map((r) => [r.gate.name, r]));
  assert.equal(by.b.ok, true);
});

test('--fail-fast: a gate already running when the failure lands finishes normally', async () => {
  const gates = [
    { name: 'a', run: 'exit 1' },
    { name: 'b', run: 'sleep 0.3; echo b' },
    { name: 'c', run: 'echo c' },
  ];
  const rs = await runAll(gates, cwd, { jobs: 2, failFast: true });
  const by = Object.fromEntries(rs.map((r) => [r.gate.name, r]));
  assert.equal(by.b.ok, true, 'b was already running — must finish, not be skipped');
  assert.equal(by.b.skipped, undefined);
  assert.equal(by.c.skipped, 'fail-fast', 'c never started — swept');
});

test('--fail-fast: an allowFail failure does not trigger the sweep', async () => {
  const gates = [
    { name: 'a', run: 'exit 1', allowFail: true },
    { name: 'b', run: 'echo b' },
  ];
  const rs = await runAll(gates, cwd, { jobs: 1, failFast: true });
  const by = Object.fromEntries(rs.map((r) => [r.gate.name, r]));
  assert.equal(by.b.ok, true);
  assert.equal(by.b.skipped, undefined);
});
