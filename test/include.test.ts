import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from '../src/manifest.js';
import { runAll } from '../src/runner.js';
import { isRunOk, renderText } from '../src/render.js';

// repo A includes repo B; B's own gate command is overridable per test.
function twoRepoFixture(bGateRun = 'echo b-ok'): { root: string; a: string; b: string } {
  const root = mkdtempSync(join(tmpdir(), 'snuff-include-'));
  const a = join(root, 'A');
  const b = join(root, 'B');
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, 'snuff.yaml'), 'include: [../B]\ngates:\n  - name: deploy\n    run: echo deploy-ok\n');
  writeFileSync(join(b, 'snuff.yaml'), `gates:\n  - name: check\n    run: ${bGateRun}\n`);
  return { root, a, b };
}

test('loadManifest: include merges the other repo\'s gates, prefixed <label>/<name>', () => {
  const { root, a } = twoRepoFixture();
  const manifest = loadManifest(a);
  assert.deepEqual(manifest.gates.map((g) => g.name), ['deploy', 'B/check']);
  rmSync(root, { recursive: true, force: true });
});

test('runAll: a red gate in the included repo fails the including run', async () => {
  const { root, a } = twoRepoFixture('exit 1');
  const manifest = loadManifest(a);
  const results = await runAll(manifest.gates, a);
  assert.equal(isRunOk(results), false);
  const deploy = results.find((r) => r.gate.name === 'deploy')!;
  const included = results.find((r) => r.gate.name === 'B/check')!;
  assert.equal(deploy.ok, true);
  assert.equal(included.ok, false);
  rmSync(root, { recursive: true, force: true });
});

test('renderText: the matrix shows the included gate under its prefixed name', async () => {
  const { root, a } = twoRepoFixture();
  const manifest = loadManifest(a);
  const results = await runAll(manifest.gates, a);
  const text = renderText(results);
  assert.match(text.split('\n')[0], /\bB\/check\b/);
  rmSync(root, { recursive: true, force: true });
});

test('runAll: an included gate with no explicit cwd runs in the included repo\'s dir, not the including one', async () => {
  const { root, a, b } = twoRepoFixture();
  writeFileSync(join(b, 'marker.txt'), 'here');
  writeFileSync(join(b, 'snuff.yaml'), 'gates:\n  - name: check\n    run: test -f marker.txt\n');
  const manifest = loadManifest(a);
  const results = await runAll(manifest.gates, a);
  const included = results.find((r) => r.gate.name === 'B/check')!;
  assert.equal(included.ok, true, included.output);
  rmSync(root, { recursive: true, force: true });
});

test('runAll: an included gate\'s own cwd: resolves relative to its repo, not the including one', async () => {
  const { root, a, b } = twoRepoFixture();
  mkdirSync(join(b, 'sub'));
  writeFileSync(join(b, 'sub', 'marker.txt'), 'here');
  writeFileSync(join(b, 'snuff.yaml'), 'gates:\n  - name: check\n    run: test -f marker.txt\n    cwd: sub\n');
  const manifest = loadManifest(a);
  const results = await runAll(manifest.gates, a);
  const included = results.find((r) => r.gate.name === 'B/check')!;
  assert.equal(included.ok, true, included.output);
  rmSync(root, { recursive: true, force: true });
});

test('loadManifest: an included gate\'s needs are remapped to the prefixed name', () => {
  const root = mkdtempSync(join(tmpdir(), 'snuff-include-needs-'));
  const a = join(root, 'A');
  const b = join(root, 'B');
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, 'snuff.yaml'), 'include: [../B]\ngates:\n  - name: x\n    run: echo x\n');
  writeFileSync(
    join(b, 'snuff.yaml'),
    'gates:\n  - name: lint\n    run: echo lint\n  - name: test\n    run: echo test\n    needs: [lint]\n',
  );
  const manifest = loadManifest(a);
  const testGate = manifest.gates.find((g) => g.name === 'B/test')!;
  assert.deepEqual(testGate.needs, ['B/lint']);
  rmSync(root, { recursive: true, force: true });
});

test('loadManifest: missing included manifest is a load error naming the include path', () => {
  const root = mkdtempSync(join(tmpdir(), 'snuff-include-missing-'));
  const a = join(root, 'A');
  mkdirSync(a);
  writeFileSync(join(a, 'snuff.yaml'), 'include: [../nope]\ngates:\n  - name: deploy\n    run: echo ok\n');
  assert.throws(() => loadManifest(a), /include "\.\.\/nope"/);
  rmSync(root, { recursive: true, force: true });
});

test('loadManifest: an include cycle throws instead of recursing forever', () => {
  const root = mkdtempSync(join(tmpdir(), 'snuff-include-cycle-'));
  const a = join(root, 'A');
  const b = join(root, 'B');
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, 'snuff.yaml'), 'include: [../B]\ngates:\n  - name: x\n    run: echo x\n');
  writeFileSync(join(b, 'snuff.yaml'), 'include: [../A]\ngates:\n  - name: y\n    run: echo y\n');
  assert.throws(() => loadManifest(a), /include cycle/);
  rmSync(root, { recursive: true, force: true });
});

test('changedLookup + skipsForChanged: an included gate\'s `paths:` are checked against its own repo\'s git status, not the including repo\'s', async () => {
  const { execFileSync } = await import('node:child_process');
  const { changedLookup, skipsForChanged } = await import('../src/changed.js');
  const { root, a, b } = twoRepoFixture();
  execFileSync('git', ['init', '-q'], { cwd: a });
  execFileSync('git', ['init', '-q'], { cwd: b });
  writeFileSync(join(b, 'snuff.yaml'), 'gates:\n  - name: check\n    run: echo ok\n    paths: [src/**]\n');
  mkdirSync(join(b, 'src'));
  writeFileSync(join(b, 'src', 'x.ts'), 'x');
  const manifest = loadManifest(a);
  const changedFor = changedLookup(a);
  const skip = skipsForChanged(manifest.gates, changedFor);
  // src/x.ts is untracked inside B's own tree — the included gate must see it as
  // changed even though `git status` in A (the including repo) knows nothing about it.
  assert.equal(skip.has('B/check'), false);
  rmSync(root, { recursive: true, force: true });
});

test('loadManifest: two includes whose basenames collide throw a clear error naming both paths and the label', () => {
  const root = mkdtempSync(join(tmpdir(), 'snuff-include-collide-'));
  const a = join(root, 'A');
  const shared = join(root, 'shared');
  const vendorShared = join(root, 'vendor', 'shared');
  mkdirSync(a);
  mkdirSync(shared);
  mkdirSync(vendorShared, { recursive: true });
  writeFileSync(join(a, 'snuff.yaml'), 'include: [../shared, ../vendor/shared]\ngates:\n  - name: x\n    run: echo x\n');
  writeFileSync(join(shared, 'snuff.yaml'), 'gates:\n  - name: check\n    run: echo shared-ok\n');
  writeFileSync(join(vendorShared, 'snuff.yaml'), 'gates:\n  - name: check\n    run: echo vendor-ok\n');
  assert.throws(
    () => loadManifest(a),
    /include "\.\.\/vendor\/shared" and "\.\.\/shared" both resolve to label "shared"/,
  );
  rmSync(root, { recursive: true, force: true });
});

test('loadManifest: an include-only manifest (no native gates) is legal', () => {
  const root = mkdtempSync(join(tmpdir(), 'snuff-include-only-'));
  const a = join(root, 'A');
  const b = join(root, 'B');
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, 'snuff.yaml'), 'include: [../B]\n');
  writeFileSync(join(b, 'snuff.yaml'), 'gates:\n  - name: check\n    run: echo ok\n');
  const manifest = loadManifest(a);
  assert.deepEqual(manifest.gates.map((g) => g.name), ['B/check']);
  rmSync(root, { recursive: true, force: true });
});
