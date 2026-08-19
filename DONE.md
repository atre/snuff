# snuff — done history

Moved out of PLAN.md on 2026-08-17 to keep the queue small. Append-only; PLAN.md items link here by section title.

## Phase 1 — core (scaffolded)

- [x] `snuff.yaml` / `snuff.json` manifest (constrained YAML subset, zero-dep)
- [x] sequential runner: exit codes, per-gate timeout, duration
- [x] failure trimming: signal lines (error/assert/fail/…) else tail, capped
- [x] matrix + excerpt text output, `--json`
- [x] `snuff <gate...>` subset runs
- [x] `snuff init` seeding from package.json scripts + Makefile targets

## Phase 2 — execution (done)

- [x] parallel gates with `needs:` ordering; failed need → dependents skipped (–)
- [x] streamed matrix line updating as gates finish (TTY only, on stderr; plain when piped)
- [x] `--changed` mode: skip gates whose `paths:` globs have no diff vs HEAD
- [x] per-gate `env:` and `cwd:` keys for monorepo sub-packages
- [x] `-j N` concurrency cap; timeout kills the whole process tree

## Next-up history (session notes)

Done 2026-08-17: `snuff --all ~/git` fleet runner (F.1) — new `src/fleet.ts`:
`listManifests` returns direct child dirs with a manifest, **sorted
alphabetically** (not specified — `readdirSync` order isn't guaranteed
stable across filesystems, and a fleet report re-ordering itself between
runs would be unpleasant; also what makes "first line is the red repo"
deterministic). `runFleet` runs each repo's gates sequentially
(`jobs: 1`, ignoring that repo's own `defaults.jobs`) while repos
themselves run concurrently up to the fleet-level `-j`, via a small private
`mapLimit` (no existing generic concurrency-capped-map to reuse — `runAll`'s
job cap is Gate-specific). Staleness reads `.snuff/last.json` **before**
`saveLast` overwrites it, same ordering discipline as B.5's
`previousDurations`. **One addition beyond the literal spec**: a repo whose
manifest fails to load is caught and reported as a red, errored entry
instead of crashing the whole sweep — across dozens of repos, one broken
manifest taking down `--all` entirely would defeat the point of a
fleet-hygiene tool. `renderFleetJson` reuses `toJson(...).gates` per repo
rather than a third gate-JSON shape to maintain (required loosening
`toJson`'s return type from an explicit `object` to inferred, so `.gates`
is actually accessible to callers in the same module).

Deferred, not done: Windows `taskkill /T /F` for process-tree kill (E.4) —
skipped for now, not abandoned. Its own accept criteria requires a manual
check on an actual Windows box ("leaves no `sleep` in Task Manager") that
this session has no way to run; implementing the `killTree` branch blind,
with only darwin/linux CI to verify against, risks shipping an unverified
Windows code path with false confidence. Revisit when there's a Windows
machine (or CI runner) to actually check it against.

Done 2026-08-17: `--gha` GitHub Actions annotations + step summary (E.3) —
`renderGha` reuses the same `excerptOf` pipeline `renderText`/`toJson`
already call, tries the tsc `file(line,col):` shape first, then a generic
`file:line[:col]:` shape, else falls back to a title-only annotation for a
line with no location at all. `renderStepSummary` is one markdown row per
gate, appended to `$GITHUB_STEP_SUMMARY` when set. Both additive to the
normal output, not a replacement — `--gha` prints annotations *and* the
usual matrix still prints below, so a human reading the raw CI log isn't
stuck parsing `::error` lines.

Done 2026-08-17: `snuff init --pre-commit`/`--pre-push` git hook shims (E.2)
— `writeGitHook` writes `.git/hooks/<name>` as `#!/bin/sh\nexec <cmd>`,
chmod 755 (chmodSync explicitly — `writeFileSync`'s `mode` option only takes
effect when creating a file, not overwriting one); "ours" = the existing
file mentions `snuff`, anything else is left alone without `--force`;
byte-identical content short-circuits to `'present'` before that check, so
re-running is a true no-op. `cmdInit`'s existing-manifest guard now also
lets `--pre-commit`/`--pre-push` through unmodified-manifest, the same way
`--claude` already does — wiring a hook doesn't touch the manifest. **Did
not** switch pre-commit to `--tag fast` despite the original decide note
suggesting it once D.1 landed: tags are hand-authored, no seeder emits
them, so defaulting to `--tag fast` would make every commit fail on a repo
with no `fast`-tagged gate. `--changed` stays the safe default; `--tag fast`
is a manual upgrade once gates are actually tagged.

Done 2026-08-17: `SNUFF_JOBS`/`SNUFF_TIMEOUT` env overrides (D.5) — `parseArgs`
takes an optional `env` param (default `process.env`, testable without
mutating real env); `SNUFF_JOBS` is applied *after* the flag loop so an
explicit `-j` already won and the env var is a pure fallback — that ordering
also gives the full `-j` > `SNUFF_JOBS` > `defaults.jobs` > CPU-count chain
for free, no extra code, since `flags.jobs` already resolves to the first
two tiers by the time `index.ts` applies the third. `DEFAULT_TIMEOUT_S`
(600) became `defaultTimeoutS(env)`, read at call time instead of frozen at
module load — both `runGate` and `render.ts`'s "timed out after Ns" why-line
call it, so a `SNUFF_TIMEOUT=0.3` run reports 0.3s, not a stale 600s.
Deliberate asymmetry kept as specified: `SNUFF_JOBS` throws on a bad value,
`SNUFF_TIMEOUT` silently falls back to 600 — PLAN's own wording only says
"else throw" for jobs. **Backlog D (D.1–D.5) all done.**

Done 2026-08-17: top-level `defaults:` (D.3) — the constrained YAML parser's
one `gates:` section became two (`gates:` / `defaults:`), reusing the
existing nested-block-continuation logic unchanged since it was already
generic over whatever `current` points at, not gate-specific by
construction; the only new branching is how a top-level entry *starts*
(gates: `- name: …`, defaults: flat `key: value`). `parseManifestYaml` stays
a pure parser (raw `defaults` + un-merged gates); a separate `applyDefaults`
does the merge (`timeout` whole-value fallback, `env` merges per-key, gate's
own key always wins), called from `loadManifest` for both the YAML and JSON
paths so a bad `defaults` value in either throws the same `defaults: bad
<key> "<value>"` shape. `jobs` is `-j` > `defaults.jobs` > CPU count, resolved
in `index.ts` — not per-gate, so it never touches `applyDefaults`. No
`concurrency:` key, per the original decide line — `defaults.jobs` is it.
`coerceEnv` extracted once, reused by both gate `env:` and `defaults.env:`.

Done 2026-08-17: `when:`/`if:` (D.2) — a condition check ahead of the retry
loop in `runGate`, reusing `spawnCommand` (so `env:`/`cwd:` already apply —
zero extra plumbing for the env-check accept case). `if:` is a parse-time
alias only; `Gate` never has an `if` field, `renderManifestYaml` always
writes `when:`. **Found and fixed a real bug while implementing this**: a
`when:`-skip has `ok: false`, and `runAll`'s completion callback was adding
*any* `!ok` result to `blocking` regardless of whether it carried a
`skipped` reason — so without a fix, a `when:`-skipped gate would have
wrongly blocked its dependents (contradicting the feature's own point).
Fixed by excluding any result with a `skipped` key from the blocking check —
a general rule already implicitly followed by the pre-skip (`--changed`)
path, just not previously enforced for skips that happen *inside* `runGate`.
A real hard failure (no `skipped` key) still blocks exactly as before.

Done 2026-08-17: `tags: [fast]` + `snuff --tag fast` (D.1) — `filterByTags`
is a pure filter (gates carrying any requested tag, nothing more); the
existing `selectGates` still does all the needs-pulling, so `--tag fast`
produces a name list and feeds the same pipe `--rerun-failed` and positional
gate names already use, not a separate needs-walk. That also gives the right
semantics for free: a fast-tagged gate's own `needs:` get pulled in even if
untagged, but a gate that merely *needs* a fast-tagged gate is not — tagging
is gate-driven, not reverse-dependency-driven. No gate carrying the requested
tag → error lists what tags do exist. No CLI change to any other command;
purely a selection filter.

Done 2026-08-17: `--fail-fast` (C.3) — the sweep sits in the one place a hard
failure is already recorded (`tick()`'s per-gate completion callback in
`runAll`): every gate still in `pending` (never launched) becomes
`skipped(gate, 'fail-fast')`; gates already **running** are left alone and
land with a real result. No `render.ts` change needed — the skipped-section
line already renders an arbitrary reason string generically, and `isRunOk`
already treats any `skipped` result as not what fails the run (the real
failing gate does that on its own). Backlog C (C.1–C.3) all done.

Done 2026-08-17: `retries: N` for flaky gates (C.2) — the retry loop sits
between the first `spawnCommand(gate.run, …)` and C.1's fix block (cheap
non-mutating retry first; only reach for the fixer once retries are
exhausted). Stops immediately on a timeout, per the original `while (!ok &&
!timedOut)` condition — a hung gate isn't a transient blip worth burning more
budget on. `attempts` only added to the result when `gate.retries > 0` (same
`deepStrictEqual`-safety reasoning as C.1's `fixed`), but recorded on
success *or* failure — a fixer/retry that ran and didn't help is worth
knowing, not silence. **One correction to the original wording**: PLAN's
illustrative line showed `⚠ name (passed on retry 2)` but its own rule said
"symbol stays ✓" — those contradict (⚠ already means "allowFail failure"
everywhere else in `symbol()`; reusing it here would make a genuinely-passed
retried gate look like a real failure). Went with the stated rule: symbol
stays ✓, only the `(passed on retry N)` suffix communicates it happened.
`toJson` gets `attempts` (explicitly asked for in JSON, unlike C.1's `fixed`).

Done 2026-08-17: `fix:` command per gate + `snuff --fix` (C.1) — extracted
`spawnCommand(cmd, gate, cwd, timeoutS)` out of `runGate` so it can compose
up to three spawns per gate (run, fix, run again) sharing the same
process-tree tracking. On failure with `--fix` and `gate.fix` set: spawn the
fixer, re-run once, record `fixed` either way (`true`/`false`, not just on
success — a fixer that ran but didn't help is worth knowing, not silence).
`GateResult.fixed` is only added to the object when a fix was actually
attempted (a bare `fixed: undefined` would break existing tests' `deepEqual`
against objects that never had the key). `render.ts`'s `cell()` shows `(fixed)`
after the duration. Verified end-to-end against a real broken→fixed file.

Done 2026-08-17: colour on TTY (A.5) — `symbol()` wraps the glyph only (✓
green/32, ✗ red/31, ⚠ yellow/33, – dim/2, `\x1b[0m` reset) when `color` is
true; threaded through `cell`/`renderProgress`/`renderText`, default `false`
everywhere so no-opts output stays byte-identical. `--json` never colours
(doesn't touch `cell`/`symbol` at all) and `--hook` is deliberately excluded.
`src/index.ts` computes `color` from `process.stdout.isTTY` +
`NO_COLOR`/`FORCE_COLOR` once, near the top of `main()`. **One correction to
the original spec**: the live progress line writes to stderr, not stdout
(`live = process.stderr.isTTY`, kept separate on purpose so `snuff | tee
log.txt` doesn't get cursor-control codes in the log) — reusing the
stdout-based `color` there would wrongly disable progress colour whenever
stdout is piped even if stderr is a live terminal, so it gets its own
`progressColor` computed from `live` instead. Backlog A (A.1–A.5) all done.

Done 2026-08-17: `excerptLines:` per gate / `--lines N` global (A.4) —
`excerptOf` (the one place every `trimFailure` call already funnels through)
takes the resolved cap, gate value wins over `--lines`, default stays 15.
Surfaced and fixed a real pre-existing bug in the same pass: `cli.ts`'s
`VERSION` used a fixed `../package.json` relative to the compiled file, which
only resolves under the production build's flat `dist/` layout — the test
build nests `test-dist/src/`, one level deeper, and nothing had ever imported
`cli.ts` directly in a test before this session's `test/cli.test.ts` became
the first. Replaced with an upward directory walk. Backlog A (A.1–A.4) done.

Done 2026-08-17: dedupe repeated lines / collapse stack frames (A.3) —
`collapseDuplicates` folds a consecutive run of exact-duplicate lines to the
first + `… N more like this`; `collapseFrames` folds a consecutive run of
`    at ...` frames to the first one that isn't `node_modules/` or a
`(node:...)` internal (falling back to the literal first when every frame in
the run is foreign). Both are a post-pass on whatever `trimFailure` already
selected — but the SIGNAL fallback needed a real fix to make that post-pass
reachable: frame lines never themselves contain a SIGNAL keyword, so the
existing hits-filter was silently dropping every stack frame outright,
including the one worth showing. Fixed by pulling a hit's immediately
following frame run into the candidate set before collapsing it down to one
line. **This changes existing behavior** — a JS/TS stack trace after an
assertion now keeps one frame instead of zero; the original "keeps only
signal-bearing lines" test asserted the old (worse) behavior and was updated
to match, not left as a regression.

Done 2026-08-17: `.snuff/last` timing history (B.5) — `previousDurations(cwd)`
reads `.snuff/last.json` before `saveLast` overwrites it (sequencing is
caller-owned: `index.ts` reads, then saves); `renderText`'s matrix line
suffixes a gate `(+9.3s)` when it's ≥2s and ≥50% slower than its last
recorded run. Skipped gates excluded from the durations map (their stored
duration is always 0). `--json` untouched, `--last` shows no delta (no
"previous to the previous" to diff against). Closes Backlog B — B.1–B.5 all
done.

Done 2026-08-17: per-gate `match:`/`ignore:` regexes (A.2) — `trimFailure`'s
third param became an options bag (`{run?, match?, ignore?}`) since A.1's
`run` tie-breaker and A.2's PLAN wording both wanted that slot; `ignore`
drops noise before anything else runs, `match` (when given) replaces the
trimmer table + SIGNAL fallback entirely. Regexes validated at manifest load
(`coerceGate`, gate-scoped error on a bad pattern) — stored as raw strings on
`Gate` (not compiled `RegExp`, which doesn't survive the `.snuff/last.json`
round-trip), compiled once per render call. Rendered back as a block list
(`paths:`'s shape), not a flow list (`needs:`'s) — a regex source routinely
contains unescaped commas/parens/brackets that the constrained flow-list
splitter isn't built to protect.

Done 2026-08-17: `requires: [tofu, peep]` (C.4) — `runGate` short-circuits
before spawn on a missing tool (`missing: <tool>`, no exit-127 cryptic
failure); `onPath` moved to new `src/path.ts` so both `init.ts` (seeding) and
`runner.ts` (execution) share it without a backwards import. Wired into the
5 PATH-gated seeders from the previous entry (tf-fmt/tf-validate/tflint,
kustomize, ansible, shellcheck, gitleaks) — closes the portability gap
FEEDBACK.md flagged same day: a manifest seeded with a tool installed no
longer silently 127s for someone without it.

Done 2026-08-17: seeders beyond npm/Make (E.3: go, cargo, Justfile, deno) +
infra shapes (`*.tf` via tofu/terraform + tflint, `kustomization.yaml`,
ansible playbooks, `*.sh` via shellcheck, nested `*/package.json`) + a
gitleaks gate when on PATH + `init --suggest` dry-run. Dogfooded read-only
against an OSS-hosting repo (5→14 gates once nested-`build`-only dirs were seeded —
see fix below) and the homelab infra repo (10/10, near-identical to the hand-written
manifest) — see FEEDBACK.md.

Done 2026-08-17: `.snuff/last/<gate>.log` + `.snuff/last.json` + `--show` +
`--last` + `--rerun-failed` (B.1–B.4) — see Backlog B. Timing history (B.5,
Δ vs previous run) stays backlog; it wants a second history slot, separate
pass.

Done 2026-08-17: tool-aware trimmers (A.1) — see Backlog A.

Done 2026-08-16: `--quiet`, `--hook` (Stop-hook contract: green → silent 0,
red → stderr + exit 2), `snuff init --claude` (merges the Stop hook into
.claude/settings.json, idempotent, + CLAUDE.md note). Hooks live in squirt +
snuff; manifests seeded in looksy, peep, other content-QA tools, an e-commerce repo, cli.

## Hardening (2026-08-16 code review)

**Fix-run notes for the executing session:** work top to bottom; every fix
gets a test in the matching `test/*.test.ts` (items marked manual excepted);
tick each box as its verify passes; done = all boxes ticked + `snuff` green
in this repo. No-deps is the current state, not a rule — add a dep when it earns its keep. If an item can't be done
as written, leave it unticked and note why beneath it — don't improvise a
different design.

- [x] `--changed` breaks on quoted paths — `src/changed.ts`,
      `changedPaths()`. `git status --porcelain=v1` quotes paths containing
      spaces/non-ASCII; quoted entries never match the globs, so those gates
      silently skip. Fix: add `-z` (NUL-separated, never quoted): split
      output on `'\0'`, drop empties, `slice(3)`. Extract a pure
      `parsePorcelain(out: string): string[]` so it's unit-testable; keep
      the `--show-prefix` stripping on the parsed result.
      Verify: `parsePorcelain('?? a b.txt\0 M src/x.ts\0')` →
      `['a b.txt', 'src/x.ts']` (add to `test/changed.test.ts`).
- [x] Multibyte chunk boundaries garble excerpts — `src/runner.ts`,
      `runGate()`. Per-chunk `Buffer.toString('utf8')` splits multibyte
      chars. Fix: `child.stdout?.setEncoding('utf8')` (and stderr); the
      capture callback then receives strings.
      Verify: `npm run lint` clean, existing runner tests green.
- [x] `needs` + `allowFail` docs contradict the runner — `src/types.ts`
      (needs docstring) and the manifest example in `src/cli.ts` help. The
      runner is correct (a failed allowFail need does NOT skip dependents —
      allowFail = advisory); fix the words, not the code:
      "gates that must finish first; a hard (non-allowFail) failure skips
      this gate".
      Verify: `npm run lint`; `grep -rn '"must pass"' src` empty.
- [x] SIGNAL misses plural "failures" — `src/trim.ts`. `'2 failures'`
      summary lines don't match. Fix: `fail(s|ed|ure(s)?|ing)?` in SIGNAL.
      (Tool-aware trimmers in backlog A stay the real solution.)
      Verify: `trimFailure('compiling\n2 failures\n')` → `['2 failures']`
      (add to `test/trim.test.ts`).
- [x] Quoted-scalar round-trip edge — `src/manifest.ts`, `scalar()`. A
      written value containing `" #` re-parses truncated: the lazy quoted
      regex closes at the inner quote once a `#` follows. Fix: make the body
      greedy — `/^(['"])(.*)\1(\s+#.*)?$/` — longest body wins and comment
      stripping still works.
      Verify: round-trip gates with `run: echo "x" # y` and `run: a " # b`
      through `renderManifestYaml` → `parseManifestYaml` unchanged (extend
      the round-trip test in `test/manifest.test.ts`).
- [x] Ctrl-C swallows the partial matrix — `src/runner.ts` + `src/index.ts`.
      Today the runner's module-scope signal handler kills children and
      exits before anything prints. Fix: runner exports
      `setSignalReporter(cb: (sig: string) => void)`; its handler kills the
      tree, calls the reporter if set, then exits 130/143 as now. `index.ts`
      sets the reporter before `runAll`: clear the live line
      (`\r\x1b[K` to stderr), print `renderText` of the results so far (keep
      the latest `done` snapshot from `onProgress` in a closure).
      Verify (manual): manifest with a `sleep 30` gate; Ctrl-C → finished
      cells print, exit code 130.

## Backlog — ideas, ranked by value for the actual use (AI session runs `snuff`, reads a few lines, acts)

### A. Make the excerpt smarter (the core value)
- [x] tool-aware trimmers (2026-08-17): `src/trim.ts` gained a `TRIMMERS` table
  (tsc, eslint, ruff-concise, node --test, pytest) tried before the SIGNAL
  fallback — detects by output signature, `run` substring as a tie-breaker
  when more than one matches; keeps the first N picks + the summary line
  (unlike the fallback's tail). `src/render.ts` passes `r.gate.run` through.
  8 new tests in `test/trim.test.ts`; the 4 pre-existing ones stay
  byte-identical (unknown output still falls through to SIGNAL/tail).
  go test / cargo / terraform stay backlog — same shape, add when a gate
  actually needs one.
- [x] per-gate `match:` / `ignore:` regexes for tools we don't know
  (2026-08-17) — `Gate.match?`/`Gate.ignore?: string[]`; `coerceGate`
  validates each compiles (`new RegExp`) at load time, gate-scoped error on a
  bad pattern; `trimFailure(output, max, {run?, match?, ignore?})` — `ignore`
  filters first, `match` (given) replaces trimmer-table/SIGNAL entirely
  (tail-biased, same convention as SIGNAL); `renderManifestYaml` round-trips
  both as block lists (like `paths:`, not `needs:` — regex sources need the
  quoting a flow list doesn't reliably give them).
- [x] dedupe repeated lines ("N more like this"), collapse stack frames to
  the first in-repo frame (2026-08-17) — `collapseDuplicates`/`collapseFrames`
  in `src/trim.ts`, applied to whatever `trimFailure` selected regardless of
  path (match: / trimmer table / SIGNAL fallback). Required fixing the SIGNAL
  fallback itself: frame lines never carry a SIGNAL keyword, so hits-filtering
  was dropping every frame outright — a hit now pulls its immediately
  following frame run into the candidate set first. Duplicate = exact match
  after `trimEnd`; only consecutive frames/duplicates collapse.
- [x] `excerptLines:` per gate / `--lines N` global (2026-08-17) —
  `Gate.excerptLines?: number` validated like `timeout`; `--lines N` /
  `--lines=N`; `excerptOf` in `src/render.ts` resolves `gate.excerptLines ??
  lines` before every `trimFailure` call, threaded through `renderText`,
  `toJson`/`renderJson`, and all four render call sites in `index.ts`
  (normal run, `--hook`, Ctrl-C partial print, `--last`). Default stays 15,
  byte-identical when nothing is set.
- [x] colour on TTY (✓ green ✗ red ⚠ yellow – dim), `NO_COLOR` / `FORCE_COLOR`
  (2026-08-17) — `paint(sym, code)` + `symbol(r, color)` in `src/render.ts`,
  threaded through `cell`/`renderProgress`/`renderText`. `color` computed
  once in `src/index.ts`; the live-progress line (stderr) gets its own
  `progressColor` rather than reusing the stdout-based one — see "Next up"
  for why. `--json`/`--hook` never colour.

### B. Don't lose the detail, just hide it
- [x] save full output per gate to `.snuff/last/<gate>.log` (2026-08-17) —
  `src/last.ts` (`saveLast`, `readLast`, `readLog`, `failedNames`); one log
  per non-skipped gate, `.snuff/last.json` self-contained (embeds each
  `Gate`, not the `--json` shape, so `--last` re-renders byte-identically).
  Merges into whatever was already there instead of overwriting wholesale —
  a partial run (`snuff <gate>` / `--rerun-failed`) only touches the gates it
  ran, so it can't erase the rest of the last full picture. Gitignored via
  `ensureGitignore` in `src/init.ts` (runs from `snuff init` when a
  `.gitignore` exists and lacks the entry).
- [x] `snuff --show <gate>` (2026-08-17) — prints the saved log verbatim,
  `src/index.ts` `command === 'show'`; no manifest load needed.
- [x] `snuff --last` (2026-08-17) — re-renders the stored results, `--json`
  honoured; no previous run → `snuff: no previous run here`, exit 1.
- [x] `--rerun-failed` (2026-08-17) — `failedNames` (red, not skipped, not
  `allowFail`, filtered to gates still in the manifest so a stale record
  can't crash `selectGates`) → `selectGates` pulls the `needs`, manifest
  order preserved. Nothing red → `nothing failed last run`, exit 0.
- [x] timing history (2026-08-17) — `previousDurations(cwd)` in `src/last.ts`
  reads `.snuff/last.json` before `saveLast` overwrites it; `renderText`'s
  matrix cell suffixes `(+9.3s)` when a gate is ≥2s and ≥50% slower than its
  last recorded run. Only the previous run, no multi-run history file, per
  the original decide line.

### C. Turn red into green faster
- [x] `fix:` command per gate (`eslint --fix`, `prettier -w`, `terraform fmt`);
  `snuff --fix` runs the fixer on failure, then re-runs the gate once
  (2026-08-17) — `Gate.fix?: string`, `GateResult.fixed?: boolean`;
  `runGate(gate, cwd, {fix?: boolean})` composes `spawnCommand` up to three
  times (run, fix, run); `fixed` recorded true or false once attempted, never
  a bare `undefined` property (would break existing `deepEqual` tests). `--fix`
  flag; `render.ts` shows `(fixed)`.
- [x] `retries: N` for flaky gates (network, browser) (2026-08-17) —
  `Gate.retries?: number` (non-negative, 0 valid), `GateResult.attempts?:
  number`; `runGate` loops up to `retries + 1` while `!ok && !timedOut`,
  ahead of the C.1 fix block. Symbol stays ✓, `(passed on retry N)` suffix
  in `render.ts`; `toJson` always includes `attempts` (default 1). No CLI
  flag — purely per-gate, no `--retries` global.
- [x] `--fail-fast` — stop launching after the first hard failure
  (2026-08-17) — `RunOptions.failFast`; the sweep lives in `tick()`'s
  per-gate completion callback in `runAll`, right where a hard failure is
  already recorded into `blocking`: every gate still in `pending` becomes
  `skipped(gate, 'fail-fast')`, gates already running finish normally. No
  `render.ts` change — the skipped-section already renders arbitrary reason
  strings.
- [x] `requires: [peep, tofu]` (2026-08-17) — `runGate` checks each name via
  `onPath` (new `src/path.ts`, `accessSync(X_OK)` over `PATH`, no `which`
  subprocess) before spawning; missing → `{ok:false, exitCode:null,
  output:'missing: peep, tofu'}`, resolved immediately, no process tree at
  all. `renderText`'s why-line special-cases it to `→ missing: peep` instead
  of the uninformative `→ exit ?`, and skips the (redundant) excerpt line.
  Wired into the 5 PATH-gated seeders (tf-fmt/tf-validate/tflint, kustomize,
  ansible, shellcheck, gitleaks) — see "Next up" above.

### D. Selection & shape
- [x] `tags: [fast]` + `snuff --tag fast` (pre-commit) vs full (pre-push /
  CI) (2026-08-17) — `Gate.tags?: string[]`; `filterByTags(gates, tags)` in
  `src/manifest.ts` is a pure filter, `selectGates` still does the
  needs-pulling; `--tag <t>` repeatable in `src/cli.ts`; wired in
  `src/index.ts` alongside `--rerun-failed` at the same `selectedNames`
  computation point.
- [x] `when:` / `if:` — shell condition or env var; skip with reason when
  false (2026-08-17) — `Gate.when?: string`; `if:` a parse-time-only alias,
  `Gate` never carries an `if` field; checked via `spawnCommand` (same
  env/cwd as the real run) ahead of the retry loop in `runGate`; skips don't
  block dependents — required fixing `runAll`'s blocking condition to
  exclude any `skipped` result, not just `when:`'s.
- [x] top-level `defaults:` (timeout, env, jobs) and `concurrency:` per
  manifest (2026-08-17) — `Manifest.defaults?: {timeout?; env?; jobs?}`;
  `parseManifestYaml` parses it as a second top-level section reusing the
  gate-parsing nested-block logic (already generic, not gate-specific);
  `applyDefaults` is the separate pure merge step, called from `loadManifest`
  for both YAML and JSON; `jobs` precedence `-j` > `defaults.jobs` > CPU
  count in `index.ts`; `renderManifestYaml` writes `defaults:` first.
  `concurrency:` is not a separate key, per the decide line — `defaults.jobs`
  is it.
- [x] `--hook` / `--quiet` mode (2026-08-16): quiet prints nothing when green;
  hook mode is the Stop-hook contract (red → stderr + exit 2)
- [x] `SNUFF_JOBS`, `SNUFF_TIMEOUT` env overrides (2026-08-17) —
  `parseArgs(argv, env = process.env)` applies `SNUFF_JOBS` as a fallback
  after the flag loop (explicit `-j` wins); `defaultTimeoutS(env)` replaces
  the frozen `DEFAULT_TIMEOUT_S` constant at both call sites (`runGate`,
  `render.ts`'s why-line) so a timeout report matches the actual override
  used. `SNUFF_JOBS` throws on a bad value, `SNUFF_TIMEOUT` falls back to
  600 silently — asymmetry is in the original spec, not accidental.

### E. Distribution / integrations
- [x] `snuff init --claude` (2026-08-16) — merges the Stop hook into
  `.claude/settings.json` (idempotent) + CLAUDE.md note
- [x] `snuff init --pre-commit` / `--pre-push` git hook shims (2026-08-17) —
  `writeGitHook(dir, name, cmd, {force?}): 'written'|'present'|'foreign'` in
  `src/init.ts`; `cmdInit` gains `{preCommit, prePush}`, bypasses the
  existing-manifest guard the same way `--claude` already does. Pre-commit
  runs `snuff --changed`, pre-push runs `snuff`; kept as the default rather
  than switching to `--tag fast` (see "Next up" for why).
- [x] GitHub Actions: `--gha` → `::error file=..,line=..::msg` annotations +
  matrix into `$GITHUB_STEP_SUMMARY` (2026-08-17) — `renderGha`/
  `renderStepSummary` in `src/render.ts`, reusing the private `excerptOf`/
  `duration` helpers `renderText`/`toJson` already have. Tried tsc's
  `file(line,col):` shape first, then generic `file:line[:col]:`, else a
  title-only annotation. Additive to the normal matrix output, not a
  replacement.
- [x] seeders beyond npm/Make (2026-08-17): go (`go vet`/`go test`), cargo
  (`fmt --check`/`clippy`/`test`), Justfile recipes, `deno.json` tasks. pyproject
  was already done (2026-08-16). `seedGates` is now a list of small seeder
  functions over a shared `SeedCtx { dir, onPath, taken }` instead of one
  growing function — see the infra-shapes entry below for the same pass's
  Terraform/kustomize/ansible/shellcheck/nested-package.json/gitleaks work.
- [ ] Windows: `taskkill /T /F` for process-tree kill → files: `src/runner.ts` (`killTree`: on `win32` `spawn('taskkill', ['/pid', String(pid), '/T', '/F'])` instead of `process.kill(-pid)`; keep `detached: false` there), `test/runner.test.ts` (drop `skip: process.platform === 'win32'` from the timeout test) · accept: `npm run lint` clean and the timeout test green on darwin/linux (unchanged path); manual on Windows: `snuff` with a `timeout: 1` gate running `sleep 30 & wait` exits with `timed out after 1s` and leaves no `sleep` in Task Manager.

### F. Fleet
- [x] `snuff --all ~/git` — run each child repo's manifest; one line per
  repo, `--json` aggregate, "which repos are red / stale" (2026-08-17) —
  `src/fleet.ts` (`listManifests`, `runFleet`, `FleetRepoResult`), `--all
  <dir>` on `src/cli.ts`, `renderFleet`/`renderFleetJson` on `src/render.ts`.
  A repo with an unloadable manifest is reported as errored, not thrown —
  see "Next up" for the rest of the deviations from the literal spec.

### Done / merged

- [x] `init` inference for infra shapes (2026-08-17): `*.tf` anywhere →
  `tf-fmt`/`tf-validate` (`tofu` preferred, `terraform` fallback) + `tflint`
  when on PATH; each `**/kustomization.yaml` → `kustomize-<dirname>: kubectl
  kustomize <dir> > /dev/null`; `ansible/playbooks/*.yml` → `--syntax-check`;
  `*.sh` → `shellcheck` (only when it's on PATH — a machine-dependent gate is
  worse than none; the real fix is `requires:`, next up); nested
  `*/package.json` → per-dir `<dir>-lint`/`<dir>-test`/`<dir>-build`. `init
  --suggest` prints the manifest, writes nothing. New `walkFiles`/`onPath`
  primitives in `src/init.ts`, both reusable (onPath is exported for C.4).
  Dogfooded read-only against an OSS-hosting repo and the homelab infra repo — see PLAN "Next up"
  and FEEDBACK.md 2026-08-17.

- [x] **gitleaks gate** (2026-08-17) — `snuff init` seeds `secrets: gitleaks
  detect --no-git -s . --redact` when `gitleaks` is on PATH, absent otherwise.
  No install hint on absence (kept consistent with the other on-PATH-gated
  seeders — tflint, shellcheck — none of which print one either).

- [x] ~~merged~~ `--json --changed` on Stop writes `changedGates` into the last-result file so brief can distinguish "green because skipped" from "green because passed" (`gates ✓ 3/5 (2 skipped)`). → files: `src/last.ts` (`skipped` reason already in `GateResult`; ensure the file keeps it), README · accept: brief's `readSnuffLast` fixture from the Phase 1.6 item includes `skipped: 'unchanged'` and renders `(1 skipped)`.
  → **merged into W.1** (2026-08-17 re-rank; the last-result file keeps `skipped` per gate) — no separate work.

- [x] ~~merged~~ Profiles: `snuff --profile prod` = the post-deploy gate set (peep check, looksy --check, other content-QA tools) reading a shared per-repo `fleet.yaml` (domains/pages/locales) so post-deploy QA is a manifest, not a script. → files: same as the `snuff --profile <name>` item below (`src/types.ts` `Manifest.profiles`, `src/manifest.ts`, `src/cli.ts`, `src/index.ts`, `test/manifest.test.ts`) · accept: covered by that item's accept (`--profile prod` runs only the listed gates; unknown profile errors listing known ones); tick both together. decide: `fleet.yaml` is not read by snuff — profiles only select gates; peep/looksy/other tools read their own config from the gate `run:` line.
  → **merged into W.2** (2026-08-17 re-rank; profiles select gates; `fleet.yaml` never read by snuff) — no separate work.
