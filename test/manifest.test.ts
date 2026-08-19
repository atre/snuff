import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDefaults, expandEach, filterByTags, loadManifest, parseManifestYaml, selectGates, validateGraph } from '../src/manifest.js';
import { renderManifestYaml } from '../src/init.js';
import type { Gate } from '../src/types.js';

test('parses the constrained gates yaml', () => {
  const { gates } = parseManifestYaml(`# comment
gates:
  - name: lint
    run: npm run lint
  - name: opsec
    run: peep check example.com  # inline comment
    timeout: 120
    allowFail: true
`);

  assert.equal(gates.length, 2);
  assert.deepEqual(gates[0], { name: 'lint', run: 'npm run lint' });
  assert.deepEqual(gates[1], {
    name: 'opsec',
    run: 'peep check example.com',
    timeout: 120,
    allowFail: true,
  });
});

test('rejects a gate missing name or run', () => {
  assert.throws(() => parseManifestYaml('gates:\n  - name: lonely\n'), /needs "name" and "run"/);
});

test('round-trips through renderManifestYaml', () => {
  const gates = [
    { name: 'test', run: 'npm test' },
    { name: 'build', run: 'make build', timeout: 60, allowFail: true },
  ];
  const { gates: parsed } = parseManifestYaml(renderManifestYaml(gates));
  assert.deepEqual(parsed, gates);
});

test('comments: full-line and trailing stripped, # inside quotes kept', () => {
  const { gates } = parseManifestYaml(`gates:
  # leading comment
  - name: a
    run: "grep '#TODO' src"  # trailing
  - name: b
    run: echo hi   # trailing
  - name: c
    run: 'x # y'
`);
  assert.deepEqual(
    gates.map((g) => g.run),
    ["grep '#TODO' src", 'echo hi', 'x # y'],
  );
});

test('needs/paths/env/cwd: flow list, block list, block map', () => {
  const { gates } = parseManifestYaml(`gates:
  - name: typecheck
    run: npm run lint
  - name: test
    run: npm test
    needs: [typecheck]
    paths:
      - src/**
      - "test/**/*.{ts,tsx}"
    env:
      CI: "1"
      NODE_OPTIONS: --max-old-space-size=4096
    cwd: packages/web
  - name: flowglob
    run: x
    paths: [src/**/*.{ts,tsx}, docs/]
`);
  assert.deepEqual(gates[1], {
    name: 'test',
    run: 'npm test',
    needs: ['typecheck'],
    paths: ['src/**', 'test/**/*.{ts,tsx}'],
    env: { CI: '1', NODE_OPTIONS: '--max-old-space-size=4096' },
    cwd: 'packages/web',
  });
  assert.deepEqual(gates[2].paths, ['src/**/*.{ts,tsx}', 'docs/']);
});

test('round-trips the extended shape', () => {
  const gates = [
    { name: 'a', run: 'echo "# not a comment"' },
    { name: 'q1', run: 'echo "x" # y' },
    { name: 'q2', run: 'a " # b' },
    {
      name: 'b',
      run: 'make b',
      fix: 'eslint --fix .',
      when: 'test -f .env',
      needs: ['a'],
      requires: ['tofu', 'tflint'],
      tags: ['fast', 'unit'],
      match: ['^ERR:', '\\[FAIL\\]'],
      ignore: ['^DEBUG:', 'a,b(c)'],
      paths: ['src/**/*.{ts,tsx}', 'lib/'],
      env: { CI: '1', X: 'a, b' },
      cwd: 'pkg',
      timeout: 5,
      excerptLines: 5,
      retries: 2,
      allowFail: true,
    },
  ];
  assert.deepEqual(parseManifestYaml(renderManifestYaml(gates)).gates, gates);
});

test('quoted scalars: double-quoted honours YAML escapes, single-quoted is literal', () => {
  const { gates } = parseManifestYaml(`gates:
  - name: a
    run: "test -n \\"$X\\""
    when: "test -n \\"$X\\""   # trailing comment
    match: ["\\\\d+", "tab\\there"]
    ignore:
      - "^\\\\s*at "
  - name: b
    run: 'it''s literal \\d+'
`);
  assert.equal(gates[0].run, 'test -n "$X"');
  assert.equal(gates[0].when, 'test -n "$X"');
  assert.deepEqual(gates[0].match, ['\\d+', 'tab\there']);
  assert.deepEqual(gates[0].ignore, ['^\\s*at ']);
  assert.ok(new RegExp(gates[0].match![0]).test('42'));
  assert.equal(gates[1].run, "it's literal \\d+");
});

test('yamlScalar escapes symmetrically: regex/quote/newline values round-trip', () => {
  const gates: Gate[] = [
    {
      name: 'a',
      run: 'test -n "$X" && echo it\'s',
      when: 'test -n "$X"',
      match: ['\\d+', '^ERR:', 'a"b\'c'],
      ignore: ['tab\there', 'nl\nhere'],
      env: { MSG: 'say "hi"' },
    },
  ];
  const text = renderManifestYaml(gates);
  assert.deepEqual(parseManifestYaml(text).gates, gates);
});

test('fix: must be a non-empty command string', () => {
  const { gates } = parseManifestYaml('gates:\n  - name: a\n    run: x\n    fix: prettier -w .\n');
  assert.equal(gates[0].fix, 'prettier -w .');
});

test('when: parses; if: is accepted as an alias and stored as when', () => {
  const { gates: whenGates } = parseManifestYaml('gates:\n  - name: a\n    run: x\n    when: test -f .env\n');
  assert.equal(whenGates[0].when, 'test -f .env');

  const { gates: ifGates } = parseManifestYaml('gates:\n  - name: a\n    run: x\n    if: test -f .env\n');
  assert.equal(ifGates[0].when, 'test -f .env');
  assert.equal('if' in ifGates[0], false);

  // when: renders back as when:, never if: — round-trip through renderManifestYaml confirms this
  assert.equal(renderManifestYaml(ifGates).includes('    when: test -f .env'), true);
  assert.equal(renderManifestYaml(ifGates).includes('if:'), false);
});

test('retries: non-negative integer, 0 is valid', () => {
  const { gates } = parseManifestYaml('gates:\n  - name: a\n    run: x\n    retries: 0\n');
  assert.equal(gates[0].retries, 0);
  assert.throws(
    () => parseManifestYaml('gates:\n  - name: a\n    run: x\n    retries: -1\n'),
    /gate a: bad retries "-1"/,
  );
  assert.throws(
    () => parseManifestYaml('gates:\n  - name: a\n    run: x\n    retries: abc\n'),
    /gate a: bad retries "abc"/,
  );
});

test('excerptLines: validated like timeout, positive integer only', () => {
  const { gates } = parseManifestYaml('gates:\n  - name: a\n    run: x\n    excerptLines: 3\n');
  assert.equal(gates[0].excerptLines, 3);
  assert.throws(
    () => parseManifestYaml('gates:\n  - name: a\n    run: x\n    excerptLines: 0\n'),
    /gate a: bad excerptLines "0"/,
  );
  assert.throws(
    () => parseManifestYaml('gates:\n  - name: a\n    run: x\n    excerptLines: abc\n'),
    /gate a: bad excerptLines "abc"/,
  );
});

test('match/ignore: bad regex throws a gate-scoped error', () => {
  assert.throws(
    () => parseManifestYaml('gates:\n  - name: a\n    run: x\n    match: ["("]\n'),
    /gate a: bad match regex "\("/,
  );
  assert.throws(
    () => parseManifestYaml('gates:\n  - name: a\n    run: x\n    ignore: ["("]\n'),
    /gate a: bad ignore regex "\("/,
  );
});

test('validateGraph: unknown need, cycle, duplicate', () => {
  assert.throws(() => validateGraph([{ name: 'a', run: 'x', needs: ['zzz'] }]), /unknown gate "zzz"/);
  assert.throws(
    () =>
      validateGraph([
        { name: 'a', run: 'x', needs: ['b'] },
        { name: 'b', run: 'x', needs: ['a'] },
      ]),
    /cycle: a → b → a/,
  );
  assert.throws(() => validateGraph([{ name: 'a', run: 'x' }, { name: 'a', run: 'y' }]), /duplicate/);
});

test('selectGates pulls in transitive needs, keeps manifest order', () => {
  const gates = [
    { name: 'a', run: 'x' },
    { name: 'b', run: 'x', needs: ['a'] },
    { name: 'c', run: 'x', needs: ['b'] },
    { name: 'd', run: 'x' },
  ];
  assert.deepEqual(selectGates(gates, ['c']).map((g) => g.name), ['a', 'b', 'c']);
  assert.throws(() => selectGates(gates, ['nope']), /unknown gate\(s\): nope/);
});

test('filterByTags: gates carrying any requested tag, needs pulled in only via selectGates', () => {
  const gates = [
    { name: 'typecheck', run: 'x' },
    { name: 'lint', run: 'x', tags: ['fast'], needs: ['typecheck'] },
    { name: 'test', run: 'x', needs: ['lint'] },
    { name: 'build', run: 'x' },
  ];
  assert.deepEqual(filterByTags(gates, ['fast']).map((g) => g.name), ['lint']);
  // feeding filterByTags' names into selectGates pulls lint's own needs (typecheck),
  // but not test — even though test needs lint, test itself isn't tagged
  const names = filterByTags(gates, ['fast']).map((g) => g.name);
  assert.deepEqual(selectGates(gates, names).map((g) => g.name), ['typecheck', 'lint']);
  assert.deepEqual(filterByTags(gates, ['nope']), []);
  assert.deepEqual(filterByTags(gates, ['fast', 'slow']).map((g) => g.name), ['lint']);
});

test('include: flow list, block list, and absent all parse correctly', () => {
  const flow = parseManifestYaml('include: [../a, ../b]\ngates:\n  - name: x\n    run: y\n');
  assert.deepEqual(flow.include, ['../a', '../b']);

  const block = parseManifestYaml('include:\n  - ../a\n  - ../b\ngates:\n  - name: x\n    run: y\n');
  assert.deepEqual(block.include, ['../a', '../b']);

  const single = parseManifestYaml('include: [../only]\ngates:\n  - name: x\n    run: y\n');
  assert.deepEqual(single.include, ['../only']);

  const none = parseManifestYaml('gates:\n  - name: x\n    run: y\n');
  assert.equal(none.include, undefined);

  const empty = parseManifestYaml('include: []\ngates:\n  - name: x\n    run: y\n');
  assert.equal(empty.include, undefined);
});

test('include: round-trips through renderManifestYaml', () => {
  const gates = [{ name: 'deploy', run: './deploy.sh' }];
  const text = renderManifestYaml(gates, undefined, ['../streamer', '../other']);
  const parsed = parseManifestYaml(text);
  assert.deepEqual(parsed.include, ['../streamer', '../other']);
  assert.deepEqual(parsed.gates, gates);
});

test('defaults: parses at the top level, raw (pre-merge) on the returned manifest', () => {
  const manifest = parseManifestYaml(`defaults:
  timeout: 30
  jobs: 2
  env:
    CI: "1"
gates:
  - name: a
    run: echo
  - name: b
    run: echo
    timeout: 5
`);
  assert.equal(manifest.defaults?.jobs, 2);
  assert.equal(manifest.defaults?.timeout, 30);
  assert.deepEqual(manifest.defaults?.env, { CI: '1' });
  // pre-merge: gate a has no timeout/env of its own yet
  assert.equal(manifest.gates[0].timeout, undefined);
  assert.equal(manifest.gates[0].env, undefined);
});

test('applyDefaults: timeout/env applied to gates lacking them, gate value wins per key', () => {
  const manifest = parseManifestYaml(`defaults:
  timeout: 30
  jobs: 2
  env:
    CI: "1"
gates:
  - name: a
    run: echo
  - name: b
    run: echo
    timeout: 5
  - name: c
    run: echo
    env:
      CI: "0"
`);
  const applied = applyDefaults(manifest);
  const byName = Object.fromEntries(applied.gates.map((g) => [g.name, g]));
  assert.equal(byName.a.timeout, 30);
  assert.deepEqual(byName.a.env, { CI: '1' });
  assert.equal(byName.b.timeout, 5, "gate's own timeout wins");
  assert.deepEqual(byName.c.env, { CI: '0' }, "gate's own env key wins per key, not whole-field");
});

test('applyDefaults: no defaults block is a no-op, identity', () => {
  const manifest = parseManifestYaml('gates:\n  - name: a\n    run: echo\n');
  assert.equal(manifest.defaults, undefined);
  assert.equal(applyDefaults(manifest), manifest);
});

test('defaults: bad timeout/jobs/env throw a defaults-scoped error', () => {
  assert.throws(
    () => parseManifestYaml('defaults:\n  timeout: 0\ngates:\n  - name: a\n    run: x\n'),
    /defaults: bad timeout "0"/,
  );
  assert.throws(
    () => parseManifestYaml('defaults:\n  jobs: 0\ngates:\n  - name: a\n    run: x\n'),
    /defaults: bad jobs "0"/,
  );
});

test('defaults: round-trips through renderManifestYaml, written before gates:', () => {
  const gates = [{ name: 'a', run: 'echo' }];
  const defaults = { timeout: 30, jobs: 2, env: { CI: '1' } };
  const yaml = renderManifestYaml(gates, defaults);
  assert.ok(yaml.indexOf('defaults:') < yaml.indexOf('gates:'));
  const parsed = parseManifestYaml(yaml);
  assert.deepEqual(parsed.defaults, defaults);
  assert.deepEqual(parsed.gates, gates);
});

test('renderManifestYaml without defaults is byte-identical to before this feature', () => {
  const gates = [{ name: 'a', run: 'echo' }];
  assert.equal(renderManifestYaml(gates), renderManifestYaml(gates, undefined));
  assert.ok(!renderManifestYaml(gates).includes('defaults:'));
});

test('defaults: JSON manifests validate through the same coerceDefaults, and get merged by loadManifest', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'snuff-defaults-json-'));
  writeFileSync(
    join(dir, 'snuff.json'),
    JSON.stringify({
      defaults: { timeout: 30, env: { CI: '1' } },
      gates: [{ name: 'a', run: 'echo' }],
    }),
  );
  const manifest = loadManifest(dir);
  assert.equal(manifest.gates[0].timeout, 30);
  assert.deepEqual(manifest.gates[0].env, { CI: '1' });

  const badDir = mkdtempSync(join(tmpdir(), 'snuff-defaults-json-bad-'));
  writeFileSync(
    join(badDir, 'snuff.json'),
    JSON.stringify({ defaults: { timeout: 0 }, gates: [{ name: 'a', run: 'echo' }] }),
  );
  assert.throws(() => loadManifest(badDir), /defaults: bad timeout "0"/);
});

test('expandEach: sites/* interpolates {dir}/{name}, defaults cwd/paths, drops "each"', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'snuff-each-'));
  mkdirSync(join(dir, 'sites', 'a'), { recursive: true });
  mkdirSync(join(dir, 'sites', 'b'), { recursive: true });

  const gates: Gate[] = [{ name: 'build-{name}', run: 'npm run build', each: 'sites/*' }];
  const expanded = expandEach(gates, dir);
  assert.deepEqual(expanded.map((g) => g.name), ['build-a', 'build-b']);
  assert.equal(expanded[0].cwd, 'sites/a');
  assert.deepEqual(expanded[0].paths, ['sites/a/**']);
  assert.equal(expanded[1].cwd, 'sites/b');
  assert.deepEqual(expanded[1].paths, ['sites/b/**']);
  assert.ok(expanded.every((g) => !('each' in g)));
});

test('expandEach: zero matches throws "each: <glob> matched no directories"', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'snuff-each-empty-'));
  const gates: Gate[] = [{ name: 'build-{name}', run: 'npm run build', each: 'sites/*' }];
  assert.throws(() => expandEach(gates, dir), /each: sites\/\* matched no directories/);
});

test('each: a name missing {name} with ≥2 matches hits validateGraph\'s duplicate-name error via loadManifest', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'snuff-each-dup-'));
  mkdirSync(join(dir, 'sites', 'a'), { recursive: true });
  mkdirSync(join(dir, 'sites', 'b'), { recursive: true });
  writeFileSync(join(dir, 'snuff.yaml'), 'gates:\n  - name: build\n    run: npm run build\n    each: sites/*\n');
  assert.throws(() => loadManifest(dir), /duplicate gate name "build"/);
});

test('each: loadManifest end-to-end — expands, still applies defaults/validateGraph, "each" gone', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'snuff-each-load-'));
  mkdirSync(join(dir, 'sites', 'a'), { recursive: true });
  mkdirSync(join(dir, 'sites', 'b'), { recursive: true });
  writeFileSync(join(dir, 'snuff.yaml'), 'gates:\n  - name: build-{name}\n    run: npm run build\n    each: sites/*\n');
  const manifest = loadManifest(dir);
  assert.deepEqual(manifest.gates.map((g) => g.name), ['build-a', 'build-b']);
  assert.equal(manifest.gates[0].cwd, 'sites/a');
  assert.deepEqual(manifest.gates[0].paths, ['sites/a/**']);
  assert.ok(manifest.gates.every((g) => !('each' in g)));
});

test('each: round-trips through renderManifestYaml', () => {
  const gates: Gate[] = [{ name: 'build-{name}', run: 'npm run build', each: 'sites/*' }];
  const yaml = renderManifestYaml(gates);
  assert.ok(yaml.includes('each: sites/*'));
  const parsed = parseManifestYaml(yaml);
  assert.equal(parsed.gates[0].each, 'sites/*');
});
