import test from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, parsePorcelain, skipsForChanged } from '../src/changed.js';

const m = (glob: string, path: string) => globToRegExp(glob).test(path);

test('globToRegExp', () => {
  assert.ok(m('src/**', 'src/a/b.ts'));
  assert.ok(m('src/**', 'src/a.ts'));
  assert.ok(!m('src/**', 'test/a.ts'));
  assert.ok(m('**/*.ts', 'a.ts'));
  assert.ok(m('**/*.ts', 'x/y/a.ts'));
  assert.ok(m('*.md', 'README.md'));
  assert.ok(!m('*.md', 'docs/README.md'));
  assert.ok(m('src/**/*.{ts,tsx}', 'src/ui/App.tsx'));
  assert.ok(!m('src/**/*.{ts,tsx}', 'src/ui/App.css'));
  assert.ok(m('docs/', 'docs/x/y.md'));
  assert.ok(m('src', 'src/x.ts'));
  assert.ok(m('package.json', 'package.json'));
  assert.ok(!m('package.json', 'package.json.bak'));
});

test('skipsForChanged', () => {
  const gates = [
    { name: 'always', run: 'x' },
    { name: 'src', run: 'x', paths: ['src/**'] },
    { name: 'docs', run: 'x', paths: ['docs/**', '*.md'] },
  ];
  const skip = skipsForChanged(gates, () => ['src/a.ts']);
  assert.deepEqual([...skip.keys()], ['docs']);
  assert.equal(skipsForChanged(gates, () => []).size, 2);
});

test('parsePorcelain: NUL-separated, unquoted paths', () => {
  assert.deepEqual(parsePorcelain('?? a b.txt\0 M src/x.ts\0'), ['a b.txt', 'src/x.ts']);
  assert.deepEqual(parsePorcelain(''), []);
});

test('--hook baseline: a gate is skipped when its files are older than its own last run, re-run when newer or when it was red', async () => {
  const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { skipsForHook } = await import('../src/changed.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-hook-'));
  writeFileSync(join(dir, 'a.ts'), 'a');
  writeFileSync(join(dir, 'b.ts'), 'b');
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(join(dir, 'a.ts'), old, old);
  const gates = [
    { name: 'ga', run: 'true', paths: ['a.ts'] },
    { name: 'gb', run: 'true', paths: ['b.ts'] },
    { name: 'gr', run: 'true', paths: ['a.ts'] },
    { name: 'gn', run: 'true', paths: ['a.ts'] },
  ] as unknown as import('../src/types.js').Gate[];
  const baseline = { ranAt: new Map([['ga', Date.now() - 30_000], ['gb', Date.now() - 30_000], ['gr', Date.now() - 30_000]]), red: new Set(['gr']) };
  const skip = skipsForHook(gates, () => ['a.ts', 'b.ts'], dir, baseline);
  assert.equal(skip.get('ga'), 'unchanged since last run'); // dirty vs HEAD but older than its last run
  assert.equal(skip.has('gb'), false); // touched after its last run
  assert.equal(skip.has('gr'), false); // was red → always re-run
  assert.equal(skip.has('gn'), false); // no baseline for this gate → runs (vs-HEAD rule: a.ts is dirty)
  // no previous run at all → plain vs-HEAD behaviour
  assert.equal(skipsForHook(gates, () => [], dir, undefined).size, 4);
});
