import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStopHook, mergeClaudeMdNote, ensureGitignore, cmdInit, writeGitHook, gitHooksDir } from '../src/init.js';

test('creates the hook structure from nothing', () => {
  const { text, changed } = mergeStopHook(undefined);
  assert.equal(changed, true);
  const parsed = JSON.parse(text) as {
    hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> };
  };
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'snuff --hook');
  assert.equal(parsed.hooks.Stop[0].hooks[0].type, 'command');
});

test('preserves existing settings and other hooks', () => {
  const existing = JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
  });
  const { text, changed } = mergeStopHook(existing);
  assert.equal(changed, true);
  const parsed = JSON.parse(text) as {
    permissions: { allow: string[] };
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  };
  assert.deepEqual(parsed.permissions.allow, ['Bash(npm test)']);
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[1].hooks[0].command, 'snuff --hook');
});

test('is idempotent when a snuff hook is already wired', () => {
  const first = mergeStopHook(undefined);
  const second = mergeStopHook(first.text);
  assert.equal(second.changed, false);
  assert.deepEqual(JSON.parse(second.text), JSON.parse(first.text));
});

test('a snuff Stop hook without timeout is upgraded to 600 in place; one with a timeout is left alone', () => {
  const legacy = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'snuff --hook' }] }] },
  });
  const up = mergeStopHook(legacy);
  assert.equal(up.changed, true);
  assert.equal(up.upgraded, true);
  const parsed = JSON.parse(up.text) as { hooks: { Stop: Array<{ hooks: Array<{ timeout?: number }> }> } };
  assert.equal(parsed.hooks.Stop.length, 1);
  assert.equal(parsed.hooks.Stop[0].hooks[0].timeout, 600);

  const custom = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'snuff --hook', timeout: 120 }] }] } });
  const same = mergeStopHook(custom);
  assert.equal(same.changed, false);
  assert.equal((JSON.parse(same.text) as typeof parsed).hooks.Stop[0].hooks[0].timeout, 120);
});

test('throws on invalid JSON instead of clobbering', () => {
  assert.throws(() => mergeStopHook('{not json'));
});

test('mergeStopHook({timeout}) scales the hook timeout for slow suites', () => {
  const { text } = mergeStopHook(undefined, { timeout: 900 });
  const parsed = JSON.parse(text) as { hooks: { Stop: Array<{ hooks: Array<{ timeout: number }> }> } };
  assert.equal(parsed.hooks.Stop[0].hooks[0].timeout, 900);

  // upgrading a legacy hook (no timeout) also honors the override
  const legacy = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'snuff --hook' }] }] } });
  const up = mergeStopHook(legacy, { timeout: 128 });
  assert.equal(up.upgraded, true);
  assert.equal((JSON.parse(up.text) as typeof parsed).hooks.Stop[0].hooks[0].timeout, 128);
});

test('mergeStopHook({timeout}) overwrites an existing (non-default) timeout when explicitly passed', () => {
  const existing = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'snuff --hook', timeout: 600 }] }] } });
  const up = mergeStopHook(existing, { timeout: 900 });
  assert.equal(up.changed, true);
  const parsed = JSON.parse(up.text) as { hooks: { Stop: Array<{ hooks: Array<{ timeout: number }> }> } };
  assert.equal(parsed.hooks.Stop[0].hooks[0].timeout, 900);

  // without an explicit override, an existing custom timeout is left alone
  const same = mergeStopHook(existing);
  assert.equal(same.changed, false);
  assert.equal((JSON.parse(same.text) as typeof parsed).hooks.Stop[0].hooks[0].timeout, 600);
});

test('mergeClaudeMdNote appends a Definition of done heading + bullet when missing', () => {
  const md = mergeClaudeMdNote('# repo\n\nsome notes.\n');
  assert.match(md, /## Definition of done\n\n- `snuff` is the definition-of-done gate/);
  assert.ok(md.trimEnd().endsWith('automatically).'));
});

test('mergeClaudeMdNote appends the bullet under an existing heading instead of a new one', () => {
  const md = mergeClaudeMdNote('# repo\n\n## Definition of done\n\n- tests must pass\n');
  const headingCount = md.match(/## Definition of done/g)?.length;
  assert.equal(headingCount, 1);
  assert.match(md, /## Definition of done\n\n- `snuff` is the definition-of-done gate[\s\S]*- tests must pass/);
});

test('seeds python gates from pyproject.toml (uv prefix when uv.lock present)', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-py-'));
  writeFileSync(
    join(dir, 'pyproject.toml'),
    '[project]\nname="x"\n[tool.ruff]\nline-length=100\n[tool.mypy]\nstrict=true\n',
  );
  writeFileSync(join(dir, 'uv.lock'), '');
  mkdirSync(join(dir, 'tests'));
  const gates = seedGates(dir);
  assert.deepEqual(
    gates.map((g) => [g.name, g.run]),
    [
      ['typecheck', 'uv run mypy .'],
      ['lint', 'uv run ruff check . --output-format concise'],
      ['format', 'uv run ruff format --check .'],
      ['test', 'uv run pytest -q'],
    ],
  );
  assert.deepEqual(gates.find((g) => g.name === 'test')?.needs, ['typecheck']);
  assert.deepEqual(gates[0].paths, ['**/*.py', 'pyproject.toml']);
});

test('mypy target from [tool.hatch.build.targets.wheel] packages, paths from packages + testpaths', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-hatch-'));
  writeFileSync(
    join(dir, 'pyproject.toml'),
    [
      '[project]',
      'name = "helper"',
      '',
      '[tool.hatch.build.targets.wheel]',
      'packages = ["src/helper"]',
      '',
      '[tool.mypy]',
      'strict = true',
      '',
      '[tool.ruff]',
      'line-length = 100',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'uv.lock'), '');
  const gates = seedGates(dir);
  const byName = new Map(gates.map((g) => [g.name, g]));
  assert.equal(byName.get('typecheck')?.run, 'uv run mypy src/helper');
  assert.equal(byName.get('format')?.run, 'uv run ruff format --check .');
  assert.deepEqual(byName.get('typecheck')?.paths, ['src/helper/**', 'tests/**', 'pyproject.toml']);
});

test('mypy target covers all hatch packages, not just the first', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-hatch-multi-'));
  writeFileSync(
    join(dir, 'pyproject.toml'),
    [
      '[tool.hatch.build.targets.wheel]',
      'packages = ["src/foo", "src/bar"]',
      '',
      '[tool.mypy]',
      'strict = true',
      '',
    ].join('\n'),
  );
  const gates = seedGates(dir);
  const typecheck = gates.find((g) => g.name === 'typecheck');
  assert.equal(typecheck?.run, 'mypy src/foo src/bar');
});

test('seeds pnpm scripts with default paths and needs', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-pnpm-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run', typecheck: 'tsc --noEmit' } }),
  );
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  const gates = seedGates(dir);
  assert.deepEqual(
    gates.map((g) => [g.name, g.run, g.needs ?? null]),
    [
      ['typecheck', 'pnpm run typecheck', null],
      ['test', 'pnpm run test', ['typecheck']],
      ['build', 'pnpm run build', ['typecheck']],
    ],
  );
});

test('honors [tool.ruff] src', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-ruff-'));
  writeFileSync(join(dir, 'pyproject.toml'), '[tool.ruff]\nsrc = ["src", "tests"]\nline-length = 100\n');
  assert.equal(seedGates(dir)[0].run, 'ruff check src tests --output-format concise');
});

test('honors [tool.ruff] src even when it comes after a different array field in the same table', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-ruff-order-'));
  writeFileSync(
    join(dir, 'pyproject.toml'),
    '[tool.ruff]\nextend-select = ["E", "F"]\nsrc = ["src", "tests"]\nline-length = 100\n',
  );
  assert.equal(seedGates(dir)[0].run, 'ruff check src tests --output-format concise');
});

test('ensureGitignore adds .snuff/ once, no-op without a .gitignore', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const bare = mkdtempSync(join(tmpdir(), 'snuff-noignore-'));
  assert.equal(ensureGitignore(bare), false);
  assert.equal(existsSync(join(bare, '.gitignore')), false);

  const dir = mkdtempSync(join(tmpdir(), 'snuff-gitignore-'));
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  assert.equal(ensureGitignore(dir), true);
  const text = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.equal(text, 'node_modules/\n.snuff/\n');
  assert.equal(ensureGitignore(dir), false);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), text);
});

test('seeds go gates from go.mod', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-go-'));
  writeFileSync(join(dir, 'go.mod'), 'module x\n');
  const gates = seedGates(dir);
  assert.deepEqual(
    gates.map((g) => [g.name, g.run]),
    [
      ['lint', 'go vet ./...'],
      ['test', 'go test ./...'],
    ],
  );
});

test('seeds cargo gates, cheap to expensive, test needs nothing', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-cargo-'));
  writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
  const gates = seedGates(dir);
  assert.deepEqual(
    gates.map((g) => [g.name, g.run]),
    [
      ['lint', 'cargo fmt --check'],
      ['check', 'cargo clippy -- -D warnings'],
      ['test', 'cargo test'],
    ],
  );
  assert.equal(gates.find((g) => g.name === 'test')?.needs, undefined);
});

test('seeds Justfile recipes and deno.json tasks', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');

  const justDir = mkdtempSync(join(tmpdir(), 'snuff-just-'));
  writeFileSync(join(justDir, 'Justfile'), 'lint:\n  eslint .\n\ntest *ARGS:\n  vitest run\n');
  assert.deepEqual(
    seedGates(justDir).map((g) => [g.name, g.run]),
    [
      ['lint', 'just lint'],
      ['test', 'just test'],
    ],
  );

  const denoDir = mkdtempSync(join(tmpdir(), 'snuff-deno-'));
  writeFileSync(join(denoDir, 'deno.json'), JSON.stringify({ tasks: { lint: 'deno lint', test: 'deno test' } }));
  assert.deepEqual(
    seedGates(denoDir).map((g) => [g.name, g.run]),
    [
      ['lint', 'deno task lint'],
      ['test', 'deno task test'],
    ],
  );
});

test('seeds terraform gates, preferring tofu over terraform, tflint only on PATH', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-tf-'));
  writeFileSync(join(dir, 'main.tf'), 'resource "x" "y" {}\n');

  const withTofu = seedGates(dir, { onPath: (t) => t === 'tofu' });
  assert.deepEqual(
    withTofu.map((g) => [g.name, g.run, g.requires]),
    [
      ['tf-fmt', 'tofu fmt -check -recursive', ['tofu']],
      ['tf-validate', 'tofu validate', ['tofu']],
    ],
  );

  const withTerraformOnly = seedGates(dir, { onPath: (t) => t === 'terraform' });
  assert.equal(withTerraformOnly[0].run, 'terraform fmt -check -recursive');
  assert.deepEqual(withTerraformOnly[0].requires, ['terraform']);

  const withTflint = seedGates(dir, { onPath: (t) => t === 'tofu' || t === 'tflint' });
  assert.deepEqual(
    withTflint.map((g) => [g.name, g.requires]),
    [
      ['tf-fmt', ['tofu']],
      ['tf-validate', ['tofu']],
      ['tflint', ['tflint']],
    ],
  );

  // no tofu/terraform on PATH → falls back to tofu (the house default), still requires it
  const withNeither = seedGates(dir, { onPath: () => false });
  assert.deepEqual(withNeither[0].requires, ['tofu']);
});

test('infra shapes: kustomize dirs, shellcheck (on PATH), nested package.json', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-infra-'));

  mkdirSync(join(dir, 'k8s', 'app'), { recursive: true });
  writeFileSync(join(dir, 'k8s', 'app', 'kustomization.yaml'), 'resources: []\n');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'x.sh'), '#!/bin/sh\necho hi\n');
  mkdirSync(join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  // build-only nested package.json (astro/vite site dirs — no lint/test script) must still seed.
  mkdirSync(join(dir, 'sites', 'pm'), { recursive: true });
  writeFileSync(join(dir, 'sites', 'pm', 'package.json'), JSON.stringify({ scripts: { build: 'astro build' } }));

  const gates = seedGates(dir, { onPath: (t) => t === 'shellcheck' });
  const byName = new Map(gates.map((g) => [g.name, g]));
  assert.deepEqual(byName.get('kustomize-app'), {
    name: 'kustomize-app',
    run: 'kubectl kustomize k8s/app > /dev/null',
    paths: ['k8s/app/**'],
    requires: ['kubectl'],
  });
  assert.deepEqual(byName.get('shellcheck'), {
    name: 'shellcheck',
    run: 'shellcheck bin/x.sh',
    paths: ['bin/x.sh'],
    requires: ['shellcheck'],
  });
  assert.deepEqual(byName.get('web-test'), {
    name: 'web-test',
    run: 'npm test',
    cwd: 'web',
    paths: ['web/**'],
  });
  assert.deepEqual(byName.get('sites/pm-build'), {
    name: 'sites/pm-build',
    run: 'npm run build',
    cwd: 'sites/pm',
    paths: ['sites/pm/**'],
  });

  // no shellcheck on PATH → no gate, even though bin/x.sh exists
  assert.equal(seedGates(dir, { onPath: () => false }).find((g) => g.name === 'shellcheck'), undefined);
});

test('walk skips node_modules/.git/.snuff/dist', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-skip-'));
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  mkdirSync(join(dir, 'node_modules', 'kdir'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'kdir', 'kustomization.yaml'), 'resources: []\n');

  assert.deepEqual(seedGates(dir), []);
});

test('seeds an ansible gate with requires: [ansible-playbook]', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-ansible-'));
  mkdirSync(join(dir, 'ansible', 'playbooks'), { recursive: true });
  writeFileSync(join(dir, 'ansible', 'playbooks', 'site.yml'), '- hosts: all\n');

  assert.deepEqual(seedGates(dir), [
    {
      name: 'ansible',
      run: 'ansible-playbook --syntax-check ansible/playbooks/site.yml',
      paths: ['ansible/playbooks/*.yml', 'ansible/playbooks/*.yaml'],
      requires: ['ansible-playbook'],
    },
  ]);
});

test('seeds a gitleaks gate only when it is on PATH', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-gitleaks-'));

  assert.equal(seedGates(dir, { onPath: () => false }).length, 0);
  assert.deepEqual(seedGates(dir, { onPath: (t) => t === 'gitleaks' }), [
    { name: 'secrets', run: 'gitleaks detect --no-git -s . --redact', paths: ['**'], requires: ['gitleaks'] },
  ]);
});

test('sort ranks a known name before an unranked per-dir name (regression: -1 sorted first)', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { seedGates } = await import('../src/init.js');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-sort-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
  mkdirSync(join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));

  const gates = seedGates(dir);
  assert.deepEqual(
    gates.map((g) => g.name),
    ['typecheck', 'web-test'],
  );
});

test('init --suggest prints the manifest and writes nothing', async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-suggest-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));

  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = cmdInit(dir, { suggest: true });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  assert.ok(out.includes('gates:'));
  assert.equal(existsSync(join(dir, 'snuff.yaml')), false);
});

async function gitRepo(tag: string): Promise<string> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), `snuff-githook-${tag}-`));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('writeGitHook: writes an executable shim, content includes the command', async () => {
  const { statSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = await gitRepo('write');
  const result = writeGitHook(dir, 'pre-commit', 'snuff --changed');
  assert.equal(result, 'written');
  const path = join(dir, '.git', 'hooks', 'pre-commit');
  assert.ok(statSync(path).mode & 0o111, 'must be executable');
  assert.match(readFileSync(path, 'utf8'), /snuff --changed/);
});

test('writeGitHook: a second identical call is a no-op, file byte-unchanged', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = await gitRepo('idempotent');
  writeGitHook(dir, 'pre-commit', 'snuff --changed');
  const before = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
  const result = writeGitHook(dir, 'pre-commit', 'snuff --changed');
  assert.equal(result, 'present');
  assert.equal(readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'), before);
});

test('writeGitHook: a foreign hook (no "snuff" mention) is left untouched without --force', async () => {
  const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = await gitRepo('foreign');
  const path = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nnpm test\n');
  const result = writeGitHook(dir, 'pre-commit', 'snuff --changed');
  assert.equal(result, 'foreign');
  assert.equal(readFileSync(path, 'utf8'), '#!/bin/sh\nnpm test\n');

  const forced = writeGitHook(dir, 'pre-commit', 'snuff --changed', { force: true });
  assert.equal(forced, 'written');
  assert.match(readFileSync(path, 'utf8'), /snuff --changed/);
});

test('writeGitHook: throws when the directory is not a git repo', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-notgit-'));
  assert.throws(() => writeGitHook(dir, 'pre-commit', 'snuff --changed'), /not a git repository/);
});

test('cmdInit --pre-commit: an existing manifest is left alone, hook still gets wired', async () => {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = await gitRepo('cmdinit');
  writeFileSync(join(dir, 'snuff.yaml'), 'gates:\n  - name: existing\n    run: echo hi\n');
  const code = cmdInit(dir, { preCommit: true });
  assert.equal(code, 0);
  // manifest untouched
  assert.equal(readFileSync(join(dir, 'snuff.yaml'), 'utf8'), 'gates:\n  - name: existing\n    run: echo hi\n');
  // hook wired
  assert.match(readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'), /snuff --changed/);
});

test('cmdInit --pre-commit --force: foreign hook replaced, existing manifest NOT reseeded', async () => {
  const { writeFileSync, readFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = await gitRepo('force-decoupled');
  const manifest = 'gates:\n  - name: existing\n    run: echo hi\n';
  writeFileSync(join(dir, 'snuff.yaml'), manifest);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm test\n');

  // foreign hook without --force → left alone, exit 1 so the caller knows
  assert.equal(cmdInit(dir, { preCommit: true }), 1);
  assert.equal(readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'), '#!/bin/sh\nnpm test\n');

  assert.equal(cmdInit(dir, { preCommit: true, force: true }), 0);
  assert.match(readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'), /snuff --changed/);
  assert.equal(readFileSync(join(dir, 'snuff.yaml'), 'utf8'), manifest, '--force must not touch the manifest');

  // --reseed is what overwrites the manifest; plain init on an existing one points at it
  assert.equal(cmdInit(dir, {}), 1);
  assert.equal(cmdInit(dir, { reseed: true }), 0);
  assert.match(readFileSync(join(dir, 'snuff.yaml'), 'utf8'), /name: test/);
});

test('writeGitHook: resolves the hooks dir via git (worktree: .git is a file)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, realpathSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = realpathSync(await gitRepo('worktree'));
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  const wt = `${dir}-wt`;
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'wt'], { cwd: dir });
  assert.ok(statSync(join(wt, '.git')).isFile(), 'worktree .git is a file');

  assert.equal(writeGitHook(wt, 'pre-push', 'snuff'), 'written');
  const hooksDir = gitHooksDir(wt);
  assert.ok(hooksDir.startsWith(dir), `hooks dir lives under the main repo, got ${hooksDir}`);
  assert.match(readFileSync(join(hooksDir, 'pre-push'), 'utf8'), /exec snuff/);
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir });
});

test('cmdInit --claude: CLAUDE.md lacking the heading gets one appended, bullet under it (tmp dir)', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-claudemd-'));
  writeFileSync(join(dir, 'snuff.yaml'), 'gates:\n  - name: existing\n    run: echo hi\n');
  writeFileSync(join(dir, 'CLAUDE.md'), '# repo\n\nsome context, no done-heading here.\n');
  const code = cmdInit(dir, { claude: true });
  assert.equal(code, 0);
  const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /## Definition of done\n\n- `snuff` is the definition-of-done gate/);
});

test('cmdInit --claude: an existing manifest logs "already exists — left untouched" and is not reseeded', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-claude-untouched-'));
  const manifest = 'gates:\n  - name: existing\n    run: echo hi\n';
  writeFileSync(join(dir, 'snuff.yaml'), manifest);

  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  let code: number;
  try {
    code = cmdInit(dir, { claude: true });
  } finally {
    console.log = original;
  }

  assert.equal(code, 0);
  assert.ok(
    logs.some((l) => l.includes(join(dir, 'snuff.yaml')) && l.includes('already exists — left untouched')),
    `expected an "already exists — left untouched" log, got: ${JSON.stringify(logs)}`,
  );
  assert.equal(readFileSync(join(dir, 'snuff.yaml'), 'utf8'), manifest, 'manifest must not be reseeded');
});

test('cmdInit --claude --hook-timeout N sets the Stop hook timeout', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-hooktimeout-'));
  writeFileSync(join(dir, 'snuff.yaml'), 'gates:\n  - name: existing\n    run: echo hi\n');
  const code = cmdInit(dir, { claude: true, hookTimeout: 128 });
  assert.equal(code, 0);
  const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as {
    hooks: { Stop: Array<{ hooks: Array<{ timeout: number }> }> };
  };
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 128);
});

test('cmdInit --claude --hook-timeout N re-runs to update an already-wired hook\'s existing timeout', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'snuff-hooktimeout-bump-'));
  writeFileSync(join(dir, 'snuff.yaml'), 'gates:\n  - name: existing\n    run: echo hi\n');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'snuff --hook', timeout: 600 }] }] } }),
  );
  const code = cmdInit(dir, { claude: true, hookTimeout: 900 });
  assert.equal(code, 0);
  const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as {
    hooks: { Stop: Array<{ hooks: Array<{ timeout: number }> }> };
  };
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 900);
});
