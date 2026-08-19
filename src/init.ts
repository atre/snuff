import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { findManifest } from './manifest.js';
import { onPath } from './path.js';
import type { Gate, Manifest } from './types.js';

const NPM_CANDIDATES = ['typecheck', 'lint', 'test', 'build', 'check'];
const MAKE_CANDIDATES = ['lint', 'test', 'build', 'check', 'verify'];
const WALK_SKIP = new Set(['node_modules', '.git', '.snuff', 'dist', 'test-dist']);

/** Recursive file listing, skipping node_modules/.git/.snuff/dist/test-dist. Returns `/`-joined relative paths. */
function walkFiles(root: string, match: (name: string, relPath: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (WALK_SKIP.has(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), relPath);
      else if (e.isFile() && match(e.name, relPath)) out.push(relPath);
    }
  };
  walk(root, '');
  return out;
}

function dirOf(relPath: string): string {
  const parts = relPath.split('/');
  parts.pop();
  return parts.join('/') || '.';
}

function baseOf(path: string): string {
  return path.split('/').pop() ?? path;
}

interface SeedCtx {
  dir: string;
  onPath: (tool: string) => boolean;
  taken: Set<string>;
}

type Seeder = (ctx: SeedCtx) => Gate[];

function seedNpm(ctx: SeedCtx): Gate[] {
  const pkgPath = join(ctx.dir, 'package.json');
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
  const pm = existsSync(join(ctx.dir, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(ctx.dir, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(ctx.dir, 'bun.lockb')) || existsSync(join(ctx.dir, 'bun.lock'))
        ? 'bun'
        : 'npm';
  const gates: Gate[] = [];
  for (const name of NPM_CANDIDATES) {
    if (pkg.scripts?.[name]) {
      const run = pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} run ${name}`;
      gates.push({ name, run, paths: ['src/**', 'test/**', 'tests/**', 'package.json', 'tsconfig*.json'] });
    }
  }
  return gates;
}

function seedMake(ctx: SeedCtx): Gate[] {
  const makePath = join(ctx.dir, 'Makefile');
  if (!existsSync(makePath)) return [];
  const targets = new Set([...readFileSync(makePath, 'utf8').matchAll(/^([A-Za-z][\w-]*):/gm)].map((m) => m[1]));
  const gates: Gate[] = [];
  for (const name of MAKE_CANDIDATES) {
    if (targets.has(name)) {
      gates.push({ name, run: `make ${name}`, paths: ['**/*.go', 'go.mod', 'go.sum', 'src/**', 'Makefile'] });
    }
  }
  return gates;
}

/** Pull `key = ["a", "b"]` out of a `[table]`'s body (up to the next top-level `[...]` header, or EOF), same lightweight scan for every TOML list field this file reads. */
function tomlListField(py: string, table: string, key: string): string[] {
  const headerRe = new RegExp(`\\[${table.replace(/\./g, '\\.')}\\]`);
  const headerMatch = headerRe.exec(py);
  if (!headerMatch) return [];
  const rest = py.slice(headerMatch.index + headerMatch[0].length);
  // isolate this table's own block first, so a key can be found regardless of
  // where it sits relative to any other array field in the same table
  const nextHeaderMatch = /^\[[^[][^\n]*\]/m.exec(rest);
  const body = nextHeaderMatch ? rest.slice(0, nextHeaderMatch.index) : rest;
  const raw = new RegExp(`\\b${key}\\s*=\\s*\\[([^\\]]*)\\]`).exec(body)?.[1];
  return raw
    ? raw
        .replace(/["'\s]/g, '')
        .split(',')
        .filter(Boolean)
    : [];
}

function seedPyproject(ctx: SeedCtx): Gate[] {
  const pyPath = join(ctx.dir, 'pyproject.toml');
  if (!existsSync(pyPath)) return [];
  const py = readFileSync(pyPath, 'utf8');
  const prefix = existsSync(join(ctx.dir, 'uv.lock')) ? 'uv run ' : '';
  const has = (re: RegExp) => re.test(py);

  // honor [tool.ruff] src = ["src", "tests"]; concise output is what the trimmer surfaces best
  const ruffSrcList = tomlListField(py, 'tool.ruff', 'src');
  const ruffDirs = ruffSrcList.length ? ruffSrcList.join(' ') : '.';

  // [tool.hatch.build.targets.wheel] packages = ["src/x", ...] → mypy target = all entries
  const hatchPackages = tomlListField(py, 'tool.hatch.build.targets.wheel', 'packages');
  const mypyTarget = hatchPackages.length ? hatchPackages.join(' ') : '.';

  // [tool.pytest.ini_options] testpaths = ["tests", ...]
  const testpaths = tomlListField(py, 'tool.pytest.ini_options', 'testpaths');

  // paths: hatch package dir(s) + ruff src dir(s) + pytest testpaths, always + pyproject.toml
  // itself; falls back to a blanket **/*.py when none of those fields are set.
  const dirGlobs = [...new Set([...hatchPackages, ...ruffSrcList, ...testpaths])].map((d) => `${d}/**`);
  const paths = dirGlobs.length ? [...dirGlobs, 'pyproject.toml'] : ['**/*.py', 'pyproject.toml'];

  const gates: Gate[] = [];
  if (has(/\bruff\b/)) {
    gates.push({ name: 'lint', run: `${prefix}ruff check ${ruffDirs} --output-format concise`, paths });
    gates.push({ name: 'format', run: `${prefix}ruff format --check ${ruffDirs}`, paths });
  }
  if (has(/\[tool\.mypy\]|\bmypy\b/)) gates.push({ name: 'typecheck', run: `${prefix}mypy ${mypyTarget}`, paths });
  if (has(/\[tool\.pyright\]|\bpyright\b/)) gates.push({ name: 'typecheck', run: `${prefix}pyright`, paths });
  if (has(/\bpytest\b/) || existsSync(join(ctx.dir, 'tests'))) gates.push({ name: 'test', run: `${prefix}pytest -q`, paths });
  return gates;
}

function seedGo(ctx: SeedCtx): Gate[] {
  if (!existsSync(join(ctx.dir, 'go.mod'))) return [];
  const paths = ['**/*.go', 'go.mod', 'go.sum'];
  return [
    { name: 'lint', run: 'go vet ./...', paths },
    { name: 'test', run: 'go test ./...', paths },
  ];
}

function seedCargo(ctx: SeedCtx): Gate[] {
  if (!existsSync(join(ctx.dir, 'Cargo.toml'))) return [];
  const paths = ['src/**', 'Cargo.toml', 'Cargo.lock'];
  return [
    { name: 'lint', run: 'cargo fmt --check', paths },
    { name: 'check', run: 'cargo clippy -- -D warnings', paths },
    { name: 'test', run: 'cargo test', paths },
  ];
}

function seedJust(ctx: SeedCtx): Gate[] {
  const path = existsSync(join(ctx.dir, 'Justfile'))
    ? join(ctx.dir, 'Justfile')
    : existsSync(join(ctx.dir, 'justfile'))
      ? join(ctx.dir, 'justfile')
      : undefined;
  if (!path) return [];
  const recipes = new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => /^([A-Za-z_][\w-]*)[ \t]*[^\n:]*:/.exec(l)?.[1])
      .filter((n): n is string => !!n),
  );
  const gates: Gate[] = [];
  for (const name of ['lint', 'test', 'build', 'check']) {
    if (recipes.has(name)) gates.push({ name, run: `just ${name}` });
  }
  return gates;
}

function seedDeno(ctx: SeedCtx): Gate[] {
  const path = existsSync(join(ctx.dir, 'deno.json'))
    ? join(ctx.dir, 'deno.json')
    : existsSync(join(ctx.dir, 'deno.jsonc'))
      ? join(ctx.dir, 'deno.jsonc')
      : undefined;
  if (!path) return [];
  let tasks: Record<string, string> = {};
  try {
    const text = readFileSync(path, 'utf8').replace(/\/\/.*$/gm, '');
    tasks = (JSON.parse(text) as { tasks?: Record<string, string> }).tasks ?? {};
  } catch {
    return [];
  }
  const gates: Gate[] = [];
  for (const name of ['lint', 'test', 'build']) {
    if (tasks[name]) gates.push({ name, run: `deno task ${name}` });
  }
  return gates;
}

function seedTerraform(ctx: SeedCtx): Gate[] {
  if (walkFiles(ctx.dir, (name) => name.endsWith('.tf')).length === 0) return [];
  const bin = ctx.onPath('tofu') ? 'tofu' : ctx.onPath('terraform') ? 'terraform' : 'tofu';
  const paths = ['**/*.tf', '**/*.tfvars'];
  const gates: Gate[] = [
    { name: 'tf-fmt', run: `${bin} fmt -check -recursive`, paths, requires: [bin] },
    { name: 'tf-validate', run: `${bin} validate`, paths, requires: [bin] },
  ];
  if (ctx.onPath('tflint')) gates.push({ name: 'tflint', run: 'tflint', paths, requires: ['tflint'] });
  return gates;
}

function seedKustomize(ctx: SeedCtx): Gate[] {
  const files = walkFiles(ctx.dir, (name) => name === 'kustomization.yaml' || name === 'kustomization.yml');
  return files.map((relPath) => {
    const relDir = dirOf(relPath);
    return {
      name: `kustomize-${baseOf(relDir)}`,
      run: `kubectl kustomize ${relDir} > /dev/null`,
      paths: [`${relDir}/**`],
      requires: ['kubectl'],
    };
  });
}

function seedAnsible(ctx: SeedCtx): Gate[] {
  const files = walkFiles(ctx.dir, (_name, relPath) => /^ansible\/playbooks\/[^/]+\.ya?ml$/.test(relPath)).sort();
  if (files.length === 0) return [];
  return [
    {
      name: 'ansible',
      run: `ansible-playbook --syntax-check ${files.join(' ')}`,
      paths: ['ansible/playbooks/*.yml', 'ansible/playbooks/*.yaml'],
      requires: ['ansible-playbook'],
    },
  ];
}

const SHELLCHECK_CAP = 50;

function seedShellcheck(ctx: SeedCtx): Gate[] {
  if (!ctx.onPath('shellcheck')) return [];
  const files = walkFiles(ctx.dir, (name) => name.endsWith('.sh')).sort();
  if (files.length === 0) return [];
  const capped = files.slice(0, SHELLCHECK_CAP);
  if (files.length > SHELLCHECK_CAP) {
    console.error(`snuff: ${files.length - SHELLCHECK_CAP} more .sh files not seeded (cap ${SHELLCHECK_CAP})`);
  }
  return [{ name: 'shellcheck', run: `shellcheck ${capped.join(' ')}`, paths: capped, requires: ['shellcheck'] }];
}

const NESTED_PKG_CAP = 20;

function seedNestedPackageJson(ctx: SeedCtx): Gate[] {
  const files = walkFiles(ctx.dir, (name) => name === 'package.json')
    .filter((relPath) => relPath !== 'package.json')
    .sort();
  if (files.length === 0) return [];
  const capped = files.slice(0, NESTED_PKG_CAP);
  if (files.length > NESTED_PKG_CAP) {
    console.error(`snuff: ${files.length - NESTED_PKG_CAP} more package.json dirs not seeded (cap ${NESTED_PKG_CAP})`);
  }
  const gates: Gate[] = [];
  for (const relPath of capped) {
    const relDir = dirOf(relPath);
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(join(ctx.dir, relPath), 'utf8')) as { scripts?: Record<string, string> };
    } catch {
      continue;
    }
    for (const name of ['lint', 'test', 'build']) {
      if (pkg.scripts?.[name]) {
        gates.push({
          name: `${relDir}-${name}`,
          run: name === 'test' ? 'npm test' : `npm run ${name}`,
          cwd: relDir,
          paths: [`${relDir}/**`],
        });
      }
    }
  }
  return gates;
}

function seedGitleaks(ctx: SeedCtx): Gate[] {
  if (!ctx.onPath('gitleaks')) return [];
  return [{ name: 'secrets', run: 'gitleaks detect --no-git -s . --redact', paths: ['**'], requires: ['gitleaks'] }];
}

const SEEDERS: Seeder[] = [
  seedNpm,
  seedMake,
  seedPyproject,
  seedGo,
  seedCargo,
  seedJust,
  seedDeno,
  seedTerraform,
  seedKustomize,
  seedAnsible,
  seedShellcheck,
  seedNestedPackageJson,
  seedGitleaks,
];

// cheap → expensive; the obvious dependency: test/build wait for typecheck.
// Names outside this list (per-dir gates like `kustomize-app`, `web-test`)
// sort after everything in it, in the order they were seeded (stable sort).
const ORDER = [
  'typecheck',
  'lint',
  'format',
  'check',
  'tf-fmt',
  'tf-validate',
  'tflint',
  'shellcheck',
  'ansible',
  'secrets',
  'test',
  'build',
  'verify',
];

function rank(name: string): number {
  const i = ORDER.indexOf(name);
  return i === -1 ? ORDER.length : i;
}

export interface SeedOpts {
  onPath?: (tool: string) => boolean;
}

export function seedGates(dir: string, opts: SeedOpts = {}): Gate[] {
  const ctx: SeedCtx = { dir, onPath: opts.onPath ?? ((tool) => onPath(tool)), taken: new Set() };
  const gates: Gate[] = [];
  for (const seed of SEEDERS) {
    for (const g of seed(ctx)) {
      if (ctx.taken.has(g.name)) continue;
      gates.push(g);
      ctx.taken.add(g.name);
    }
  }

  gates.sort((a, b) => rank(a.name) - rank(b.name));
  const names = new Set(gates.map((g) => g.name));
  for (const g of gates) {
    if ((g.name === 'test' || g.name === 'build') && names.has('typecheck')) g.needs = ['typecheck'];
  }

  return gates;
}

export function renderManifestYaml(gates: Gate[], defaults?: Manifest['defaults'], include?: Manifest['include']): string {
  const lines = ['# snuff manifest — definition-of-done gates. Run `snuff` to execute all.'];
  if (include?.length) lines.push(`include: [${include.join(', ')}]`);
  if (defaults) {
    lines.push('defaults:');
    if (defaults.timeout !== undefined) lines.push(`  timeout: ${defaults.timeout}`);
    if (defaults.jobs !== undefined) lines.push(`  jobs: ${defaults.jobs}`);
    if (defaults.env && Object.keys(defaults.env).length > 0) {
      lines.push('  env:');
      for (const [k, v] of Object.entries(defaults.env)) lines.push(`    ${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push('gates:');
  for (const g of gates) {
    lines.push(`  - name: ${g.name}`);
    lines.push(`    run: ${yamlScalar(g.run)}`);
    if (g.each !== undefined) lines.push(`    each: ${yamlScalar(g.each)}`);
    if (g.fix !== undefined) lines.push(`    fix: ${yamlScalar(g.fix)}`);
    if (g.when !== undefined) lines.push(`    when: ${yamlScalar(g.when)}`);
    if (g.needs?.length) lines.push(`    needs: [${g.needs.join(', ')}]`);
    if (g.requires?.length) lines.push(`    requires: [${g.requires.join(', ')}]`);
    if (g.tags?.length) lines.push(`    tags: [${g.tags.join(', ')}]`);
    if (g.paths?.length) {
      lines.push('    paths:');
      for (const p of g.paths) lines.push(`      - ${yamlScalar(p)}`);
    }
    // block list, not flow list — a regex source can contain unescaped commas/brackets
    if (g.match?.length) {
      lines.push('    match:');
      for (const p of g.match) lines.push(`      - ${yamlScalar(p)}`);
    }
    if (g.ignore?.length) {
      lines.push('    ignore:');
      for (const p of g.ignore) lines.push(`      - ${yamlScalar(p)}`);
    }
    if (g.cwd !== undefined) lines.push(`    cwd: ${yamlScalar(g.cwd)}`);
    if (g.env && Object.keys(g.env).length > 0) {
      lines.push('    env:');
      for (const [k, v] of Object.entries(g.env)) lines.push(`      ${k}: ${yamlScalar(v)}`);
    }
    if (g.timeout !== undefined) lines.push(`    timeout: ${g.timeout}`);
    if (g.retries !== undefined) lines.push(`    retries: ${g.retries}`);
    if (g.excerptLines !== undefined) lines.push(`    excerptLines: ${g.excerptLines}`);
    if (g.allowFail) lines.push(`    allowFail: true`);
  }
  return `${lines.join('\n')}\n`;
}

// Quote when the parser would otherwise mangle it (comment marker, brackets,
// commas, backslashes, control chars). Single quotes when the value has no
// `'` (literal, nothing to escape); else double quotes with YAML escapes —
// the exact inverse of manifest.ts scalar().
export function yamlScalar(v: string): string {
  if (!/[#\[\]{},\\\n\t\r]|^['"]|^$/.test(v) && v.trim() === v) return v;
  if (!v.includes("'") && !/[\n\t\r]/.test(v)) return `'${v}'`;
  const esc = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r');
  return `"${esc}"`;
}

/** Append `.snuff/` to .gitignore when the file exists and lacks it. Never creates one. */
export function ensureGitignore(dir: string): boolean {
  const path = join(dir, '.gitignore');
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  if (text.split('\n').some((l) => l.trim() === '.snuff/' || l.trim() === '.snuff')) return false;
  writeFileSync(path, `${text.replace(/\n*$/, '')}\n.snuff/\n`);
  return true;
}

export interface CmdInitOpts {
  /** replace a foreign (non-snuff) git hook; never touches an existing manifest */
  force?: boolean;
  /** overwrite an existing snuff.yaml with a fresh seed */
  reseed?: boolean;
  claude?: boolean;
  /** print the seeded manifest to stdout and write nothing */
  suggest?: boolean;
  /** wire .git/hooks/pre-commit → snuff --changed */
  preCommit?: boolean;
  /** wire .git/hooks/pre-push → snuff */
  prePush?: boolean;
  /** Stop hook timeout in seconds (--claude only); default 600 */
  hookTimeout?: number;
}

export function cmdInit(dir: string, opts: CmdInitOpts = {}): number {
  const { force = false, reseed = false, claude = false, suggest = false, preCommit = false, prePush = false, hookTimeout } = opts;

  if (suggest) {
    const gates = seedGates(dir);
    if (gates.length === 0) {
      console.error('snuff: nothing to seed');
      return 1;
    }
    process.stdout.write(renderManifestYaml(gates));
    return 0;
  }

  const existing = findManifest(dir);
  if (existing && !reseed && !claude && !preCommit && !prePush) {
    console.error(`snuff: ${existing} already exists (use --reseed to overwrite)`);
    return 1;
  }

  if (!existing || reseed) {
    const gates = seedGates(dir);
    if (gates.length === 0) {
      console.error(
        'snuff: nothing to seed — no matching package.json scripts or Makefile targets; write snuff.yaml by hand',
      );
      return 1;
    }
    const path = join(dir, 'snuff.yaml');
    writeFileSync(path, renderManifestYaml(gates));
    console.log(`wrote ${path} with ${gates.length} gates: ${gates.map((g) => g.name).join(', ')}`);
  } else if (claude) {
    console.log(`${existing} already exists — left untouched`);
  }

  if (ensureGitignore(dir)) console.log('added .snuff/ to .gitignore');

  let code = 0;
  if (claude) code ||= wireClaude(dir, { timeout: hookTimeout });
  if (preCommit) code ||= wireGitHookCmd(dir, 'pre-commit', 'snuff --changed', force);
  if (prePush) code ||= wireGitHookCmd(dir, 'pre-push', 'snuff', force);
  return code;
}

const HOOK_COMMAND = 'snuff --hook';
const HOOK_TIMEOUT_S = 600;
const CLAUDE_MD_HEADING = '## Definition of done';
const CLAUDE_MD_BULLET =
  '- `snuff` is the definition-of-done gate — run it before declaring work\n  done (a Stop hook runs `snuff --hook` automatically).';

export interface MergeStopHookOpts {
  /** hook timeout in seconds; default 600 — bump for slow suites (e.g. a trading-system repo's 900s) */
  timeout?: number;
}

/**
 * Merge the Stop hook into a .claude/settings.json body, preserving whatever
 * else is there. `changed` is false when a snuff hook is already wired.
 */
export function mergeStopHook(
  settingsText: string | undefined,
  opts: MergeStopHookOpts = {},
): { text: string; changed: boolean; upgraded?: boolean } {
  // `opts.timeout` distinguishes an explicit --hook-timeout override (defined)
  // from just using the internal default when installing fresh (undefined).
  const explicit = opts.timeout;
  const timeout = explicit ?? HOOK_TIMEOUT_S;
  const settings = settingsText?.trim()
    ? (JSON.parse(settingsText) as Record<string, unknown>)
    : {};
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const stop = (hooks.Stop ??= []) as Array<{
    hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
  }>;
  const ours = stop.flatMap((m) => m.hooks ?? []).filter((h) => typeof h.command === 'string' && h.command.includes('snuff'));
  // Claude Code kills hooks after 60s by default — a cold build gate needs more.
  if (ours.length === 0) {
    stop.push({ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout }] });
    return { text: `${JSON.stringify(settings, null, 2)}\n`, changed: true };
  }
  // present but wired before the timeout existed → upgrade in place, touch nothing else;
  // an explicit --hook-timeout always overwrites a differing value, even a previously-set one
  let changed = false;
  for (const h of ours) {
    if (h.timeout === undefined) {
      h.timeout = timeout;
      changed = true;
    } else if (explicit !== undefined && h.timeout !== explicit) {
      h.timeout = explicit;
      changed = true;
    }
  }
  return { text: `${JSON.stringify(settings, null, 2)}\n`, changed, upgraded: changed };
}

/**
 * Insert the snuff bullet under a `## Definition of done` heading, appending
 * a fresh heading (+ bullet) at EOF when the doc doesn't have one yet.
 */
export function mergeClaudeMdNote(md: string): string {
  const headingRe = /^## Definition of done[ \t]*$/m;
  const m = headingRe.exec(md);
  if (!m) return `${md.trimEnd()}\n\n${CLAUDE_MD_HEADING}\n\n${CLAUDE_MD_BULLET}\n`;
  const at = m.index + m[0].length;
  return `${md.slice(0, at)}\n\n${CLAUDE_MD_BULLET}${md.slice(at)}`;
}

function wireClaude(dir: string, opts: { timeout?: number } = {}): number {
  // pass opts.timeout through as-is (may be undefined) so mergeStopHook can
  // tell an explicit --hook-timeout apart from the internal default
  const timeout = opts.timeout ?? HOOK_TIMEOUT_S;
  const settingsPath = join(dir, '.claude', 'settings.json');
  const prev = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;
  let merged: ReturnType<typeof mergeStopHook>;
  try {
    merged = mergeStopHook(prev, { timeout: opts.timeout });
  } catch {
    console.error(`snuff: ${settingsPath} is not valid JSON — Stop hook not added`);
    return 1;
  }
  if (merged.changed) {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath, merged.text);
    if (merged.upgraded) console.log(`Stop hook in ${settingsPath} timeout set to ${timeout}s`);
    else console.log(`wired Stop hook (${HOOK_COMMAND}) into ${settingsPath}`);
  } else {
    console.log(`Stop hook already present in ${settingsPath}`);
  }

  const claudeMd = join(dir, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const md = readFileSync(claudeMd, 'utf8');
    if (!md.includes('snuff')) {
      writeFileSync(claudeMd, mergeClaudeMdNote(md));
      console.log('added snuff note to CLAUDE.md');
    }
  }
  return 0;
}

/**
 * The repo's hooks dir via `git rev-parse --git-path hooks` — correct for
 * worktrees, submodules and core.hooksPath. Falls back to `.git/hooks` when
 * git isn't runnable; throws when neither says "this is a git repo".
 */
export function gitHooksDir(dir: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return resolve(dir, out);
  } catch {
    // git missing or not a repo — fall through to the plain-layout check
  }
  const gitDir = join(dir, '.git');
  if (!existsSync(gitDir)) throw new Error(`${dir}: not a git repository (no .git found)`);
  return join(gitDir, 'hooks');
}

/**
 * Write (or leave alone) a `<hooks>/<name>` shim. "Ours" means the
 * existing file mentions "snuff" — anything else is left untouched without
 * `force`. Byte-identical content short-circuits to 'present' before the
 * ownership check, so re-running is a true no-op.
 */
export function writeGitHook(
  dir: string,
  name: string,
  cmd: string,
  opts: { force?: boolean } = {},
): 'written' | 'present' | 'foreign' {
  const hooksDir = gitHooksDir(dir);
  mkdirSync(hooksDir, { recursive: true });
  const path = join(hooksDir, name);
  const content = `#!/bin/sh\nexec ${cmd}\n`;

  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (existing === content) return 'present';
    if (!existing.includes('snuff') && !opts.force) return 'foreign';
  }

  writeFileSync(path, content);
  chmodSync(path, 0o755); // writeFileSync's mode option only applies on create, not overwrite
  return 'written';
}

function wireGitHookCmd(dir: string, name: string, cmd: string, force: boolean): number {
  let result: ReturnType<typeof writeGitHook>;
  try {
    result = writeGitHook(dir, name, cmd, { force });
  } catch (err) {
    console.error(`snuff: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (result === 'written') console.log(`wired ${name} hook (${cmd})`);
  else if (result === 'present') console.log(`${name} hook already wired`);
  else {
    console.error(`snuff: existing ${name} hook doesn't mention snuff — left untouched (use --force to replace it)`);
    return 1;
  }
  return 0;
}
