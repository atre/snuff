import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up from this compiled file's own directory rather than a fixed
// relative depth — dist/cli.js and test-dist/src/cli.js sit a different
// number of levels below the repo root, and a fixed `../package.json`
// only resolves for one of them.
function findVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const path = join(dir, 'package.json');
    if (existsSync(path)) return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
    dir = dirname(dir);
  }
  throw new Error('snuff: could not find package.json to read the version');
}

export const VERSION: string = findVersion();

export type Command = 'run' | 'init' | 'help' | 'version' | 'show' | 'last' | 'fleet' | 'doctor';

export interface ParsedArgs {
  command: Command;
  /** gate names to run (empty = all); also the single name for --show */
  names: string[];
  flags: {
    json: boolean;
    force: boolean;
    reseed: boolean;
    changed: boolean;
    quiet: boolean;
    hook: boolean;
    claude: boolean;
    suggest: boolean;
    preCommit: boolean;
    prePush: boolean;
    rerunFailed: boolean;
    fix: boolean;
    failFast: boolean;
    gha: boolean;
    jobs?: number;
    lines?: number;
    tags?: string[];
    /** --all <dir>: fleet root directory */
    all?: string;
    /** init --hook-timeout N: Stop hook timeout in seconds (default 600) */
    hookTimeout?: number;
  };
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const args = argv.slice(2);
  const parsed: ParsedArgs = {
    command: 'run',
    names: [],
    flags: {
      json: false,
      force: false,
      reseed: false,
      changed: false,
      quiet: false,
      hook: false,
      claude: false,
      suggest: false,
      preCommit: false,
      prePush: false,
      rerunFailed: false,
      fix: false,
      failFast: false,
      gha: false,
    },
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') parsed.flags.json = true;
    else if (a === '--force') parsed.flags.force = true;
    else if (a === '--reseed') parsed.flags.reseed = true;
    else if (a === '--changed') parsed.flags.changed = true;
    else if (a === '--quiet' || a === '-q') parsed.flags.quiet = true;
    else if (a === '--hook') parsed.flags.hook = true;
    else if (a === '--claude') parsed.flags.claude = true;
    else if (a === '--suggest') parsed.flags.suggest = true;
    else if (a === '--pre-commit') parsed.flags.preCommit = true;
    else if (a === '--pre-push') parsed.flags.prePush = true;
    else if (a === '--rerun-failed') parsed.flags.rerunFailed = true;
    else if (a === '--fix') parsed.flags.fix = true;
    else if (a === '--fail-fast') parsed.flags.failFast = true;
    else if (a === '--gha') parsed.flags.gha = true;
    else if (a === '--all') {
      const v = args[++i];
      if (!v) throw new Error('--all needs a directory');
      parsed.flags.all = v;
      parsed.command = 'fleet';
    }
    else if (a === '--hook-timeout' || a.startsWith('--hook-timeout=')) {
      const v = a.startsWith('--hook-timeout=') ? a.slice(15) : args[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--hook-timeout needs a positive integer, got "${v ?? ''}"`);
      parsed.flags.hookTimeout = n;
    }
    else if (a === '--tag') {
      const v = args[++i];
      if (!v) throw new Error('--tag needs a value');
      (parsed.flags.tags ??= []).push(v);
    }
    else if (a === '--lines' || a.startsWith('--lines=')) {
      const v = a.startsWith('--lines=') ? a.slice(8) : args[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--lines needs a positive integer, got "${v ?? ''}"`);
      parsed.flags.lines = n;
    }
    else if (a === '--show') parsed.command = 'show';
    else if (a === '--last') parsed.command = 'last';
    else if (a === '-j' || a === '--jobs' || a.startsWith('--jobs=') || /^-j\d+$/.test(a)) {
      const v = a.startsWith('--jobs=') ? a.slice(7) : /^-j\d+$/.test(a) ? a.slice(2) : args[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--jobs needs a positive integer, got "${v ?? ''}"`);
      parsed.flags.jobs = n;
    } else if (a === '--help' || a === '-h' || a === 'help') parsed.command = 'help';
    else if (a === '--version' || a === '-v') parsed.command = 'version';
    else if (a === 'init') parsed.command = 'init';
    else if (a === 'doctor') parsed.command = 'doctor';
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else parsed.names.push(a);
  }
  if (parsed.command === 'show' && parsed.names.length !== 1) {
    throw new Error(`--show needs one gate name, got ${parsed.names.length}`);
  }
  // env var is a fallback, not an override — an explicit -j/--jobs already won above
  if (parsed.flags.jobs === undefined && env.SNUFF_JOBS !== undefined) {
    const n = Number(env.SNUFF_JOBS);
    if (!Number.isInteger(n) || n < 1) throw new Error('SNUFF_JOBS must be a positive integer');
    parsed.flags.jobs = n;
  }
  return parsed;
}

export function printHelp(): void {
  console.log(`snuff ${VERSION} — definition-of-done runner

Runs every quality gate in snuff.yaml and prints a compact pass/fail matrix.
Failures are trimmed to the lines you'd act on, never full runner output.

Usage:
  snuff                 run all gates
  snuff <gate...>       run only the named gates (plus what they need)
  snuff --rerun-failed  run only what was red last time (plus what it needs)
  snuff --tag fast      run only gates tagged fast (plus what they need)
  snuff --show <gate>   print the full saved output of one gate, no re-run
  snuff --last          re-print the last run's matrix, no re-run
  snuff doctor          compare each gate's configured timeout against its
                        recent real durations (.snuff/last.json history);
                        flags gates at risk of a timeout kill, exit 1 if any
  snuff --all <dir>     run every child repo's manifest under <dir>; one
                        line per repo, exit 1 if any repo is red
  snuff init [--reseed] seed snuff.yaml from package.json / Makefile / pyproject.toml /
                        go.mod / Cargo.toml / Justfile / deno.json / *.tf /
                        kustomization.yaml / ansible playbooks / *.sh (shellcheck) /
                        nested */package.json — plus a gitleaks gate when on PATH
  snuff init --claude   also wire a Claude Code Stop hook (snuff --hook) into
                        .claude/settings.json and a CLAUDE.md note
  snuff init --claude --hook-timeout N
                        override the Stop hook's timeout (default 600s) —
                        bump it for a slow suite (e.g. 900)
  snuff init --suggest  print the seeded manifest, write nothing
  snuff init --pre-commit / --pre-push
                        wire the repo's pre-commit (snuff --changed) and/or
                        pre-push (snuff) hook; a non-snuff hook is left
                        untouched (exit 1) unless --force replaces it
  snuff init --reseed   overwrite an existing snuff.yaml with a fresh seed

Flags:
  --changed      skip gates whose paths: have no diff vs HEAD (git)
  -j, --jobs N   max concurrent gates (default: CPU count; -j1 = sequential)
  -q, --quiet    print nothing when all green; matrix + excerpts only on red
  --hook         Claude Code Stop-hook mode: green → silent, exit 0;
                 red → matrix + excerpts to stderr, exit 2 (blocks the stop
                 so the session keeps fixing until green)
  --json         machine-readable output
  --lines N      max excerpt lines per failing gate (default 15); a gate's
                 own excerptLines: wins over this
  --fix          on failure, run the gate's fix: command then re-check once
  --fail-fast    stop launching new gates after the first hard failure
                 (gates already running finish normally)
  --tag <t>      repeatable; run only gates carrying one of the given tags
  --gha          print GitHub Actions ::error annotations; also appends a
                 step summary table when $GITHUB_STEP_SUMMARY is set
  -h, --help     this help
  -v, --version  version

Every run saves full output to .snuff/last/<gate>.log + .snuff/last.json.

Manifest (snuff.yaml):
  gates:
    - name: typecheck
      run: npm run lint
    - name: test
      run: npm test
      needs: [typecheck]     # run after; skipped on hard (non-allowFail) failure
      paths: [src/**, test/**]
      env:
        CI: "1"
    - name: opsec
      run: peep check example.com
      allowFail: true        # report ⚠ but don't fail the run
      timeout: 120           # seconds (default 600)
      cwd: packages/web      # relative to the manifest
    - name: tf-validate
      run: tofu validate
      requires: [tofu]       # missing tool → clean "missing: tofu", no spawn
    - name: deploy
      run: some-tool deploy
      match: ["^ERR:"]       # unrecognized tool: only these lines survive the excerpt
      ignore: ["^DEBUG:"]    # dropped before match/trimmers run
    - name: lint
      run: eslint .
      fix: eslint . --fix    # snuff --fix: on failure, run this, then re-check once
      tags: [fast]           # snuff --tag fast: run only tagged gates + their needs
    - name: e2e
      run: playwright test
      when: test -n "$CI"    # false → skipped, doesn't block dependents (if: also accepted)

Exit code: 0 when every gate passes (allowFail gates excepted), 1 otherwise.`);
}

export function printVersion(): void {
  console.log(VERSION);
}
