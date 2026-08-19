# snuff — plan

> **How to run this plan (agent):** read `CLAUDE.md` first; work top-down inside Backlog W; each open item states *what / why / accept* — do not tick `[x]` until its accept check passes; tests never touch the network or the real cluster (fixtures); `snuff` green = done (Stop hook runs it); append friction to `FEEDBACK.md`; never `git commit`/`push` unless the user says so; ask only when two readings lead to materially different work — otherwise pick the simpler one and say so.

The problem: every repo verifies differently (npm scripts, Makefile, pytest,
deploy dry-runs), so each session re-discovers how — then runs 4–5 commands
whose verbose output all lands in context. snuff is the standard "verify"
entry point: one command, one matrix, failures compressed to what's
actionable. It's also the umbrella that composes looksy / peep and other
content-QA tools as gates instead of each needing its own trigger.

> **Context discipline (fresh session):** this file is the queue, `DONE.md` is history — do not read `DONE.md` unless an item references it. Read `CLAUDE.md`, this file, then only the source files the item names (`grep -n` first, slices second). Do not read `test/*.ts` wholesale — open the one test file the item names. One item per session unless it says otherwise.

## Next up (ranked)

Backlogs A–D and F closed; E.2–E.3 done. **The fleet review verdict below
(2026-08-17) is the current call and supersedes the value÷effort ranking
that used to sit here** — the two disagreed (this list had W.2/W.3/W.4/W.8
before W.5/W.7; the review found `/ship` has 0 invocations, so profiles and
the findings shape are unvalidated speculation). Reconciled 2026-08-18:

1. **X.1 cross-repo deploy gate** (`include:`) — real dogfooding miss, not
   speculative (2026-08-18 FEEDBACK): a gate said green while the repo that
   actually shipped had zero coverage.
2. **W.1 last-result file** `~/.snuff/<slug>.json` (+ `skipped` per gate) —
   brief's reader already exists and waits for it; ~1h.
3. **X.3 leading "which manifest" line** — tiny, directly mitigates the X.1
   blind spot (would have caught it immediately per the FEEDBACK note).
4. **W.5 `each:` sugar** — 10 sites / 8 kustomize dirs hand-copied today.
5. **W.7 `init --claude` refinements** — timeout scaling, mypy path, ruff format.
6. **W.9 small polish batch** (2026-08-16/17 rollout triage) — three tiny,
   independently-trivial doc/output nits.

**Parked** (no proven pull — revisit once a real `/ship` run exists to
validate the shape): **W.2** `--profile`, **W.4** `--json` findings shape,
**W.6** weekly profile, **W.8** squirt fallback trimmer.

**Cut:** **W.3** `--brief` (`--hook` already prints one matrix — redundant).
**E.4** Windows `taskkill` (spec exact, can't be verified here, no Windows
user).

## Backlog W — cross-tool wiring (2026-08-16 hub deep-thinks #1+#2, re-ranked 2026-08-17)

Ordered by value ÷ effort with dependencies verified against the sibling repos on 2026-08-17. Work top-down: W.1 → W.8 are unblocked and need no change in any other repo (W.8 pins squirt's local tag). Tick each only when its accept line passes and `snuff` is green.

- [x] **W.1** **Last-result file** — every run writes `~/.snuff/<repo-slug>.json` (matrix, ts, git head); `brief` reads it and shows `gates ✗ lint` on the radar. Closes the snuff→brief loop (a trading-system repo's lint red, an open-data repo's TS break stop being agent-report trivia). → files: `src/last.ts` (already exists since B.1 — add `writeLastResult(cwd, results, home = process.env.SNUFF_HOME ?? join(homedir(), '.snuff'))`: slug = absolute repo path with `/` and `.` → `-` (same rule as brief's `slugFor`), body `{ts, head: git rev-parse HEAD or null, cwd, ok, gates:[{name, ok, skipped, allowFail, durationMs}]}`; errors swallowed), `src/index.ts` (call after every run, hook mode included, before printing), README "Claude Code integration" note, `test/last.test.ts` · accept: `writeLastResult('/Users/me/git/x', results, tmp)` → `<tmp>/-Users-me-git-x.json` parses with `gates[0].name` equal to the first gate and `head` either a 40-hex sha or `null`; brief's `readSnuffLast` (its Phase 1.6 item) reads exactly this shape.
  **Also carries the skipped-count** (formerly a separate item below): keep `skipped` per gate as it is in `.snuff/last.json` (`skipped: string|null`, e.g. `"unchanged"`), so brief renders `gates ✓ 3/5 (2 skipped)`. Verified 2026-08-17: brief's consumer is **already shipped** — `~/git/brief/src/gates.ts:readSnuffLast` reads `<home>/<slugFor(repo)>.json` (slug = `path.replace(/[/.]/g, '-')`, `BRIEF_SNUFF_HOME` override) and already normalises both shapes (`{ts:number, gates:[{name}]}` and snuff's in-repo `{ts:ISO, gates:[{gate:{name}}]}`), falling back to `<repo>/.snuff/last.json`. So brief works today via the fallback; W.1 only has to write the global file with `ts` as epoch ms and flat `gates[].name` — no brief change needed. Home = `SNUFF_HOME ?? ~/.snuff`. Slug rule must stay byte-identical to brief's `slugFor`.

- [ ] **W.2** `snuff --profile <name>` — what: manifest `profiles: { prod: [peep, looksy, <tool>] }` selecting a gate subset by name; default profile = all gates without a `profile:` tag; why: `/ship` needs pre (fast) vs post-deploy (network) sets; → files: `src/types.ts` (`Manifest.profiles?: Record<string, string[]>`), `src/manifest.ts` (parse top-level `profiles:` map of lists in both YAML and JSON; validate every listed name exists; `selectProfile(manifest, name)` → gate names, then `selectGates` for needs), `src/cli.ts` (`--profile <name>`), `src/index.ts`, `src/fleet.ts` (`--all` passes `profile` through), `src/init.ts` (`renderManifestYaml` writes `profiles:`), README manifest table, `test/manifest.test.ts` · accept: manifest test — `--profile prod` runs only listed gates (+ their needs); unknown profile → error listing known ones; a name in a profile that isn't a gate → load error; YAML round-trip keeps `profiles:`.
  Absorbs the `fleet.yaml` post-deploy "Profiles" item (merged below): profiles only select gates; snuff never reads `fleet.yaml`. `--profile` composes with `--all` (fleet passes it through, needed by W.6) and with `--tag`. Gates listed in any profile but not `profiles.default` are excluded from a plain `snuff` run only when a `default:` profile is declared; without one, plain `snuff` = every gate (backwards compatible). `renderManifestYaml` writes `profiles:` back (round-trip test). Parser: `profiles:` is a top-level map of name → flow/block list — same one-level shape `defaults.env` already handles.

- [ ] **W.3** `--brief` output mode for hooks (one line when red, silent when green) — hub SessionStart budget is ~60 lines total across brief/tally/pulse. → files: `src/cli.ts` (`--brief`), `src/render.ts` (`renderBrief(results): string` — `''` when `isRunOk`, else `snuff ✗ lint, test (2/5) — snuff --show lint`), `src/index.ts` (`--brief` prints that line to stdout, exit 1 when red; combined with `--hook` it replaces the full matrix on stderr), README usage block, `test/render.test.ts` · accept: `renderBrief` on 5 results with `lint` and `test` red → `snuff ✗ lint, test (2/5) — snuff --show lint`; all green → `''` and nothing is printed; timed-out gate is listed like a red one.

- [ ] **W.4** **`--json` findings shape** — what: `snuff --json` gains `findings: Finding[]` next to the matrix — one per red/timed-out gate: `{id: 'gate:<repo-slug>/<name>', scope: 'gate', severity: 'crit'|'warn' (allowFail → warn), title: '<name> ✗ 12s', detail: <excerpt joined>, hint: 'snuff --show <name>'}` using the fleet Finding schema (pulse `src/types.ts` is the reference; see hub TOOLS.md contract); why: brief's `gates` column, pulse, and any future join read one shape instead of parsing each tool's JSON; the last-result file (`~/.snuff/<slug>.json`) carries the same `findings` array; → files: `src/render.ts` (`toFindings(results, slug)`), `src/last.ts`, `src/index.ts`, README schema note, `test/render.test.ts` · accept: two results (red `test`, allowFail red `mypy`) → findings `[{id:'gate:<slug>/test', severity:'crit'}, {id:'gate:<slug>/mypy', severity:'warn'}]`; green run → `findings: []`.
  Verified 2026-08-17 against `~/git/pulse/src/types.ts`: `Finding = {id, scope, severity: 'crit'|'warn'|'ok', title, detail?, hint?, since?, group?, status?, latencyMs?}`; `Scope` there is a closed union without `gate` — snuff emits `scope: 'gate'` as a string and pulse widens its union when it consumes it (pulse-side one-liner, note it in pulse/PLAN.md when doing this). `hint` is mandatory for crit/warn → always `snuff --show <name>`. Also write `findings` into the W.1 file.

- [x] **W.5** `each:` sugar — `each: sites/*` → one stanza expands to N gates with `{dir}`/`{name}` interpolation and auto `cwd:`+`paths:` (an OSS-hosting repo's 10 sites, the homelab infra repo's 8 kustomize dirs were hand-copied). Doesn't cover the OSS-hosting repo's `tf-validate` split-root case (`terraform/environments/production` is the real root, bare `terraform/` isn't) — that needs walking for a `backend {}`/provider block per subdirectory, noted 2026-08-17, out of scope for this item, not worth its own line yet. → files: `src/types.ts` (raw key `each?: string` on the manifest gate; expanded gates carry no `each`), `src/manifest.ts` (`expandEach(gates, dir)`: match `each` against directories with `readdirSync` + `globToRegExp` from `changed.ts` (dirs only, one level per `*`, `**` allowed); per match interpolate `{dir}` (relative path) and `{name}` (basename) in `name`/`run`/`cwd`/`paths`; default `cwd: {dir}` and `paths: ['{dir}/**']` when absent; run before `validateGraph`), `src/init.ts` (`renderManifestYaml` writes `each:` back — round-trip stays lossless), README manifest table row, `test/manifest.test.ts` · accept: tmp dir with `sites/a`, `sites/b` and gate `{name: 'build-{name}', run: 'npm run build', each: 'sites/*'}` → `['build-a','build-b']` with `cwd: 'sites/a'` and `paths: ['sites/a/**']`; zero matches → error `each: sites/* matched no directories`; a `{name}` missing from `name` with ≥2 matches → duplicate-name error from `validateGraph`.

- [ ] **W.6** **`weekly` profile: supply-chain freshness** — what: `snuff init` seeds (under `profiles.weekly`, never in the default set) `audit: npm audit --audit-level=high` (pnpm/yarn variants by lockfile) or `pip-audit`/`uv pip audit` for Python, `outdated: npm outdated || true` as ⚠, `node-eol: node -e "…"` comparing `engines.node`/`.nvmrc` against the EOL table, plus `secrets: gitleaks` when on PATH; `/weekly` runs `snuff --all ~/git --profile weekly` and files the fleet line into `~/git/snuff/reports/YYYY-WW.md`; why: 60 repos, no one looks at `npm audit` — the only class of red nothing in the fleet surfaces today; network gates must not run on every Stop, hence a profile; → files: `src/init.ts` (`seedProfileGates(dir)`), `src/manifest.ts` (`profiles:` — W.2 above; tick that first), `src/fleet.ts` (F item: `--profile` passes through), README, `test/init.test.ts` (lockfile → the right audit command) · accept: tmp with `pnpm-lock.yaml` → `audit: pnpm audit --audit-level=high` under `profiles.weekly`; default `snuff` run ignores profile-only gates. decide: audit gates are `allowFail: true` (⚠) — a red matrix for a transitive advisory would train everyone to ignore it.
  Depends on W.2 (profiles) — do W.2 first.

- [x] **W.7** `init --claude`: hook timeout scaled to slow suites (a trading-system repo needing 128s), CLAUDE.md note under a `## Definition of done` heading, mypy path from hatch `packages`, `ruff format --check`, seed `paths:` from `testpaths`/`src`. → files: `src/init.ts` (`mergeStopHook(text, {timeout = 600})`; `wireClaude` puts the CLAUDE.md note under a `## Definition of done` heading (append the heading when missing); `seedGates`: mypy target from `[tool.hatch.build.targets.wheel] packages = ["src/x"]` (fallback `.`), add `format: ruff format --check <dirs>` when ruff is present, `paths` from `[tool.pytest.ini_options] testpaths` + `[tool.ruff] src` + `pyproject.toml`), `src/cli.ts` (`init --hook-timeout N`), README, `test/init.test.ts` · accept: `mergeStopHook(undefined, {timeout: 900})` → `hooks.Stop[0].hooks[0].timeout === 900`; pyproject with `packages = ["src/app"]` and `testpaths = ["tests"]` → typecheck `uv run mypy src/app`, a `format` gate `uv run ruff format --check .`, paths `['src/app/**','tests/**','pyproject.toml']`; `wireClaude` on a CLAUDE.md lacking the heading appends a `## Definition of done` heading followed by the snuff bullet (tmp dir test).

- [ ] **W.8** **squirt as the fallback trimmer** — what: when a failed gate's output is > 200 lines and no tool-aware trimmer (A) matched, run it through squirt's library entry (`import { cluster, renderText } from 'squirt'`) with `--tokens`-style budget = the excerpt cap, and print the digest instead of the SIGNAL/tail excerpt; why: test suites and deploy dry-runs produce log-shaped output — squirt already solves "2,000 lines → 20", snuff re-implements a worse version; → files: `package.json` (dep `squirt` pinned to `github:atre/squirt#v<tag>` — first dep, allowed by the contract; optional: dynamic `import()` guarded so snuff still works without it), `src/trim.ts` (`trimFailure(output, max, run?, opts?)`: TRIMMERS → if `output.split('\n').length > 200` → squirt digest capped at `max` lines → SIGNAL fallback), `src/render.ts`, `test/trim.test.ts` (fixture: 500 lines from 3 templates + one `ERROR boom`) · accept: excerpt shows `ERROR boom ×1` and `≤ max` lines; a 20-line failure is trimmed exactly as today (byte-identical). Depends on squirt's "Library entry" item (bump its priority — snuff is its first consumer).
  **Unblocked 2026-08-17**: `~/git/squirt/src/lib.ts` exports `cluster, renderText, …` and `RenderOptions.maxLines`; tag `v0.3.0` (local — pin `github:atre/squirt#v0.3.0` after push).

- [x] **W.9** small polish batch (2026-08-16/17 rollout triage) — what: (a)
  `init --claude` on a repo with an existing manifest prints nothing about
  leaving it untouched — silently skips straight to hook-wiring
  (`src/init.ts:422`, the `if (!existing || reseed)` branch only logs on the
  seed path); (b) README doesn't document that `env:` values which are paths
  resolve relative to the gate's `cwd`, not the repo root; (c) no one-line
  human/JSON run summary (`3/3 gates 2.2s`) to quote in a done-report; → files:
  `src/init.ts` (log `${manifest} already exists — left untouched` when
  `existing && claude && !reseed`), README (`env:` cwd-resolution note),
  `src/render.ts` (`renderText`/`toJson` summary line) · accept: `init --claude`
  against a repo with an existing manifest prints the untouched line; README
  has the cwd note; `snuff` text output ends with an `N/M gates Ts` line.

## Backlog X — cross-repo gate gap (2026-08-18 triage, a streaming repo → edge deploy)

Real dogfooding gap, not speculative: the homelab infra repo's pre-deploy gate shipped
a streaming repo's files via ansible; only the homelab infra repo has a `snuff.yaml`, so
the gate validated ansible/k8s (unchanged) and said green while the actually-
deployed Python had zero coverage. Stronger pull signal than Backlog W's
parked items — this is a gate that lied, not a feature nobody's used yet.

- [x] **X.1** **Cross-repo deploy gate** (`include:`) — what: `snuff.yaml`
  gains `include: [../other-repo]` — paths to other repos whose own gates run as
  part of this repo's matrix; why: a deploy command in repo A that ships repo
  B's files has no way today to name B's coverage, so B goes ungated
  (2026-08-18 FEEDBACK, a streaming repo's deploy); → files: `src/types.ts`
  (`Manifest.include?: string[]`), `src/manifest.ts` (resolve each `include`
  entry's own `snuff.yaml`/`.json` relative to the including manifest's dir,
  load its gates prefixed `<dir>/<name>`, merge into the same run graph — each
  included gate keeps its own default `cwd`), `src/render.ts` (matrix
  distinguishes included-repo gates), README · accept: tmp fixture, repo A's
  `snuff.yaml` has `include: [../B]`, B has its own manifest → `snuff` in A
  runs both A's and B's gates in one matrix; a red gate in B fails A's run;
  missing/unreadable included manifest → load error naming the path.
- [x] **X.2** **Worked example: scripts-only / artifact-producing repo** —
  what: README section for a no-tests, no-build repo (py_compile, an
  import-time consistency check, an N-sample smoke run) — the exact shape
  a streaming repo needed and didn't get written because nothing showed what "gates"
  means without lint/build (2026-08-18 FEEDBACK); → files: README · accept:
  README has a copy-pasteable example block for this shape.
- [x] **X.3** **Leading "which manifest" line** — what: every run prints one
  line naming the resolved `snuff.yaml` path before the matrix (human +
  `--hook`); why: sessions that `cd` between repos can't tell which manifest
  just gated them — this masked X.1's gap in practice (2026-08-18 FEEDBACK); →
  files: `src/render.ts`, `src/index.ts` · accept: a run in a repo with a
  manifest prints `snuff.yaml: <resolved path>` as the first line;
  `--json`/`--brief` output unaffected.
- [x] **X.4** **`snuff doctor`: timeout-drift check** — what: a `doctor`
  subcommand comparing each gate's configured `timeout` against its last N
  real durations (from `.snuff/last.json` history) and warning when timeout
  sits well under recent real runtime; why: a gate outside every `--tag` used
  in CI/hooks can drift toward a timeout kill with nothing surfacing it until
  it goes red for the wrong reason (a content-gen repo's `preflight`: configured 600s, real
  run ~23min, 2026-08-18 FEEDBACK); → files: `src/last.ts` (retain last N
  durations per gate, not just latest), `src/index.ts` (`doctor` dispatch),
  `src/render.ts`, README · accept: fixture with historical durations near/over
  a configured timeout → doctor flags it; a gate with headroom stays silent.

## Backlog E — deferred

- [ ] Windows: `taskkill /T /F` for process-tree kill → files: `src/runner.ts` (`killTree`: on `win32` `spawn('taskkill', ['/pid', String(pid), '/T', '/F'])` instead of `process.kill(-pid)`; keep `detached: false` there), `test/runner.test.ts` (drop `skip: process.platform === 'win32'` from the timeout test) · accept: `npm run lint` clean and the timeout test green on darwin/linux (unchanged path); manual on Windows: `snuff` with a `timeout: 1` gate running `sleep 30 & wait` exits with `timed out after 1s` and leaves no `sleep` in Task Manager.

## Phase 3 — composition (not started)

- gate recipes doc: peep deploy-gate, looksy visual pass, other
  content-QA gates, `squirt --baseline` as a post-deploy log gate
- `snuff init` detecting those tools' configs and proposing gates
- shared manifests: `extends: ~/git/defaults/snuff-base.yaml`

## Fleet review 2026-08-17 (hub TOOLS.md Round 4) — this section is the queue

Verdict: **DOGFOOD** — gate for the fleet building itself (151 fleet + 46 own runs; Stop hook in 20 repos) but 7 real-repo runs (one e-commerce repo only); no `snuff.yaml` in the content-gen repo or the work employer repo, where 227 sessions/30d happen. All Backlog A–F + hardening accepts verified 2026-08-17.
- [ ] **Where the work is** — `snuff init` (+ `--claude`) in the content-gen repo and the work employer repo (and its sub-repos that have a test/lint story); record the seeder gaps in FEEDBACK. why: DoD gate value is zero where no session runs it · accept: `brief` on those repos shows `gates:`. `pull/gold`
- [ ] **CI workflow** — `.github/workflows/ci.yml` node 20/22/24 like the other six (contract). `hygiene`
- Re-ranked Backlog W (above): **W.1** last-result (brief reader waits) and **W.5** `each:` and **W.7** init refinements are pull → do; **W.2/W.4/W.6/W.8** parked until one real `/ship` run exists (`/ship` = 0 invocations); **W.3 `--brief`** cut (`--hook` already prints one matrix; 7th `--brief` adds nothing); **E.4 Windows** cut.

## Non-goals

- Not a build system, no caching, no DAG beyond `needs:` — CI stays CI.
- No general YAML: manifest shape is fixed; complexity goes in the commands.
