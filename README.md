# snuff

Definition-of-done runner. One command runs every quality gate a repo declares
— typecheck, lint, tests, build, plus external gates like `peep`, `looksy`,
and other content-QA tools — and prints a compact pass/fail matrix. Failures are
trimmed to the lines you'd act on, never full runner output. Be "up to snuff"
before you ship.

Built so an AI session (or a human) never has to rediscover how a repo
verifies itself, and so the *full* gate actually runs every time.

## Usage

```
snuff                 # run all gates from snuff.yaml (parallel, needs: respected)
snuff test build      # run only these gates (plus what they need)
snuff --changed       # skip gates whose paths: have no diff vs HEAD
snuff -j1             # sequential
snuff init            # seed snuff.yaml from package.json (npm/pnpm/yarn/bun) / Makefile / pyproject.toml /
                       # go.mod / Cargo.toml / Justfile / deno.json / *.tf (tofu/terraform + tflint) /
                       # kustomization.yaml / ansible playbooks / *.sh (shellcheck, on PATH) /
                       # nested */package.json (monorepo site dirs) — plus a gitleaks gate when on PATH
snuff init --claude   # + wire a Claude Code Stop hook (`snuff --hook`: only gates whose files moved since they last ran, silent when green) and CLAUDE.md note
snuff init --claude --hook-timeout 900
                       # override the Stop hook's timeout (default 600s) — bump for a slow suite
snuff init --suggest  # print the seeded manifest, write nothing — dry-run before adopting
snuff init --pre-commit --pre-push
                       # wire the repo's pre-commit (snuff --changed) and pre-push (snuff) hooks
                       # (via `git rev-parse --git-path hooks`, so worktrees/submodules work);
                       # a non-snuff hook is left untouched → exit 1, unless --force replaces it
snuff init --reseed   # overwrite an existing snuff.yaml with a fresh seed (--force never does)
snuff --quiet         # print nothing when all green (red: matrix as usual)
snuff --json          # machine-readable results
snuff --rerun-failed  # run only what was red last time (plus what it needs)
snuff --show test     # print the full saved output of one gate, no re-run
snuff --last          # re-print the last run's matrix, no re-run
snuff doctor           # compare each gate's configured timeout against its recent real
                       # durations (.snuff/last.json history, last 5 runs per gate); flags
                       # a gate whose max recent run is >= 80% of its timeout — a drift risk
                       # even though it currently passes when run directly; silent when every
                       # gate has headroom; exit 1 if anything is flagged; --json supported
snuff --lines 5        # cap failure excerpts at 5 lines (default 15)
snuff --fix             # on failure, run a gate's fix: command, then re-check once
snuff --fail-fast       # stop launching new gates after the first hard failure
snuff --tag fast         # run only gates tagged fast (plus what they need); repeatable
snuff --gha              # print GitHub Actions ::error annotations; appends a step
                          # summary table when $GITHUB_STEP_SUMMARY is set
snuff --all ~/git         # run every child repo's manifest under a root dir; one
                          # line per repo (`✗ name — <error>` for one that couldn't run),
                          # exit 1 if any repo is red; --tag/--changed/--fix/--fail-fast/
                          # --quiet are forwarded to every child run, --lines shapes --json
```

Every run saves full output to `.snuff/last/<gate>.log` + `.snuff/last.json`
(gitignored by `snuff init`) — the excerpt on screen is trimmed, the saved
log isn't. A partial run (named gates, `--rerun-failed`) updates only the
gates it ran; the rest of the last full picture stays put.

The matrix and excerpt symbols colour on a TTY stdout (never in `--json` or
`--hook`); `NO_COLOR=1` disables it, `FORCE_COLOR=1` forces it even when
piped (and wins over `NO_COLOR` when both are set). A gate that got
meaningfully slower than its last saved run (≥ 2s and ≥ 50%) gets a timing-Δ
suffix: `✓ test 14.3s (+6.1s)`.

Output:

```
✓ typecheck 2.1s  ✓ lint 0.8s  ✗ test 14.3s  ✓ build 9.0s

✗ test → exit 1
  AssertionError: expected 402, got 200
  2 passing, 1 failing
```

## Manifest

`snuff.yaml` in the repo root:

```yaml
gates:
  - name: typecheck
    run: npm run lint
  - name: test
    run: npm test
    needs: [typecheck]          # runs after; skipped (–) if typecheck fails
    paths: [src/**, test/**]    # for --changed
    env:
      CI: "1"
  - name: opsec
    run: peep check example.com
    allowFail: true             # report ⚠ but don't fail the run
    timeout: 120                # seconds (default 600)
    cwd: packages/web           # relative to the manifest
```

| key | meaning |
|---|---|
| `needs` | gates that must finish first; a failed (non-`allowFail`) need skips this gate |
| `requires` | external tools that must be on PATH; missing → clean `missing: <tool>`, no spawn |
| `paths` | globs (`**`, `*`, `?`, `{a,b}`, `dir/`); with `--changed`, no matching change → skipped |
| `env` | extra environment for the command; a relative path used as a value isn't resolved by snuff — it's passed through as-is to the child process, so it resolves (if the command treats it as a path) against the gate's `cwd:`, not necessarily the repo root |
| `cwd` | working directory, relative to the manifest |
| `timeout` | seconds, default 600; the whole process tree is killed |
| `allowFail` | failure shows as ⚠ and doesn't affect the exit code or dependents |
| `match` | regexes; when set, only matching excerpt lines survive (escape hatch for tools with no built-in trimmer) |
| `ignore` | regexes; matching lines are dropped from the excerpt before anything else runs |
| `excerptLines` | max excerpt lines for this gate; overrides the global default (15) / `--lines` |
| `fix` | command to run on failure, before one re-check of `run` — only with `--fix` |
| `retries` | extra attempts on failure (flaky gates); marks the matrix `(passed on retry N)` |
| `tags` | free-form labels; `snuff --tag <t>` runs only gates carrying one of the given tags |
| `when` (alias `if`) | shell condition checked before `run`; false → skipped, doesn't block dependents. Env checks: `when: 'test -n "$VAR"'` |
| `each` | directory glob (e.g. `sites/*`); expands this one stanza into N gates, one per matching dir — see below |

Quoting: double-quoted scalars honour YAML escapes (`\\`, `\"`, `\n`, `\t`),
single-quoted ones are literal (`''` → `'`). So a regex in `match:`/`ignore:`
is `"\\d+"` or `'\d+'`, and a shell test with quotes is `when: "test -n \"$X\""`
or `when: 'test -n "$X"'` — `snuff init` writes whichever needs no escaping.

A top-level `defaults:` block supplies fallbacks — `timeout`/`env` apply to
any gate lacking its own (a gate's own `env` key still wins over a
same-named default), `jobs` is a run-level default below `-j`:

```yaml
defaults:
  timeout: 120
  jobs: 2
  env:
    CI: "1"
gates:
  - name: typecheck
    run: npm run lint
```

`each:` expands one stanza into N gates, one per matching directory — for
repos with a pile of near-identical per-site/per-overlay gates that would
otherwise be hand-copied:

```yaml
gates:
  - name: build-{name}
    run: npm run build
    each: sites/*
```

Matches directories only (`readdirSync`, not the changed-files list); one
path segment per `*`, `**` for arbitrary depth. `{dir}` (the matched
directory, relative to the manifest) and `{name}` (its basename) are
interpolated into `name`/`run`/`cwd`/`paths`. `cwd` defaults to `{dir}` and
`paths` to `['{dir}/**']` when the gate doesn't set its own. Zero matches is
a load error; a `name` that doesn't vary per match (missing `{name}`) hits
the normal duplicate-gate-name error once expanded.

`include:` pulls another repo's gates into this run — for a deploy command
that ships another repo's files, so that repo's own coverage still gates it,
instead of shipping ungated:

```yaml
include: [../other-repo]
gates:
  - name: deploy
    run: ./deploy.sh
```

Each path resolves relative to this manifest's dir and must itself hold a
`snuff.yaml`/`.json`; a missing or unreadable one is a load error naming the
path. That repo's gates merge into the same matrix named `<label>/<name>`
(`label` = the include path's basename, e.g. `other-repo/lint`) and default to
running in *that* repo's dir, not this one — a gate with its own `cwd:` still
resolves relative to its own repo. A red gate anywhere in an included repo
fails this run too, same as a red gate of its own.

Gates run in parallel up to the CPU count — concurrency resolves as
`-j` > `SNUFF_JOBS` > `defaults.jobs` > CPU count. Skipped gates never
fail the run on their own — the gate that caused the skip already did.
`snuff.json` with the same shape also works. Exit code is 0 only when every
gate passes (`allowFail` gates excepted) — safe to use as a hook or CI step.

`SNUFF_JOBS`/`SNUFF_TIMEOUT` env vars set machine/CI-level fallbacks below
`-j`/a gate's own `timeout:` (and above `defaults.jobs`) — no manifest edit
needed.

## Worked example: scripts-only repo

Repos with no tests, no build, no lint — scene generators, one-off scripts,
artifact-producing tooling — often ship with zero `snuff.yaml` coverage
because nothing shows what a "gate" looks like without lint/build. A
syntax check, an import-time sanity check, and a small smoke run cover most
of it:

```yaml
gates:
  - name: py_compile
    run: python3 -m py_compile $(find . -name '*.py')
  - name: import_check                              # replace scene_generators
    run: python3 -c "import scene_generators"        # with your repo's module
    needs: [py_compile]
  - name: smoke_render
    run: python3 render.py --samples 3 --out /tmp/snuff-smoke
    needs: [import_check]
    timeout: 120
```

`py_compile` is a fast syntax-only pass. `import_check` exercises whatever
the module asserts at import time (config loads, registries populate).
`smoke_render` is the real signal — a tiny N-sample run standing in for
"does this still produce output" — left as a hard failure, not
`allowFail`, because for an artifact-producing repo that's the actual
definition of done.

## Claude Code integration

`snuff init --claude` wires a **Stop hook** (`snuff --hook`) into the repo's
`.claude/settings.json` (merged, idempotent) and appends a bullet under a
`## Definition of done` heading in CLAUDE.md (added if missing). The hook
contract: all gates green → silent, exit 0, the session stops normally;
anything red → matrix + excerpts on stderr, exit 2, which blocks the stop
and feeds the failures back — the session keeps fixing until the gate is
green. Enforcement lives in the harness, not in the model's memory.

The hook's timeout defaults to 600s; pass `--hook-timeout N` alongside
`--claude` to scale it for a slower suite (`snuff init --claude
--hook-timeout 900`). A pre-existing hook without a timeout is upgraded to
whatever `--hook-timeout` says (or the 600s default); one that already has a
timeout is left alone.

`--hook` re-runs only what moved: each gate remembers when it last actually
ran (`ranAt` in `.snuff/last.json`) and is skipped when none of its `paths:`
files has an mtime newer than that (`– name unchanged since last run`), so a
tree that stays dirty for days does not re-run every gate on every Stop.
Hard-red gates always re-run; a gate with no baseline yet falls back to the
plain `--changed` rule (vs HEAD).

The hook **blocks once per distinct red**: the first red Stop prints the
matrix and exits 2; a Stop with the same red again (same gates, same output)
prints one `snuff: still red (review) — … not blocking again` line and exits
0, and so does any Stop where Claude Code reports `stop_hook_active`. A
different red blocks again; green clears the memory
(`.snuff/last-block.json`). Otherwise a red that needs a human step —
baselines, verdicts, a box that is down — loops the session forever. Slow, box-dependent gates belong behind a
tag (`tags: [full]`) with the hook wired as `snuff --hook --tag fast`.

Every run (hook or plain) also writes a **global last-result file**:
`<home>/<repo-slug>.json` under `SNUFF_HOME` (default `~/.snuff/`), keyed by
the repo's absolute path with every `/` and `.` turned into `-`
(`/Users/me/git/x` → `-Users-me-git-x.json`). It's a low-detail export for
cross-tool consumers — `{ts, head, cwd, ok, gates:[{name, ok, skipped,
allowFail, durationMs}]}`, no output — so a tool like `brief` can show
`gates ✗ lint` on its radar without reading `.snuff/last.json` or any log.
Best-effort: write failures are swallowed and never affect the run's exit code.

## Status

Core + execution phases done: parallel runner with `needs:`, `--changed`,
per-gate `env`/`cwd`, live matrix on a TTY. Gate recipes for composing
external tools are next — see [PLAN.md](PLAN.md).

## Development

```
npm install
npm run build   # tsc → dist/
npm test        # node --test
npm link        # install the `snuff` command globally
```

No runtime dependencies so far — Node ≥ 20 built-ins. The YAML support is a
constrained parser for exactly the manifest shape above, not general YAML.

## Skills

`skills/ship/SKILL.md` — `/ship`: snuff gates → the repo's deploy command → post-deploy checks (`snuff --profile prod` or peep/looksy) → `pulse diff`. Symlink into `~/.claude/skills/ship`.
