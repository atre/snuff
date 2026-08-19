# snuff

Definition-of-done runner: execute every gate in `snuff.yaml`, print a compact
pass/fail matrix with trimmed failure excerpts. The compact output IS the
product — never print full runner output.

## Stack
- TypeScript 5.x, Node ≥ 20, ESM only (`"type": "module"`)
- No runtime npm deps so far (built-ins) — not a constraint; add one when it earns its keep
- devDeps: typescript, @types/node

## Commands
- `npm run build` — tsc → dist/
- `npm run dev` — tsc --watch
- `npm test` — compile → test-dist/, run node --test
- `npm run lint` — tsc --noEmit

## Architecture
- `src/index.ts` — entry: dispatch run/init/help, exit-code policy
- `src/cli.ts` — arg parsing, help (hand-rolled)
- `src/manifest.ts` — snuff.yaml/json loading; constrained YAML-subset parser
- `src/runner.ts` — parallel gate execution ordered by `needs` (spawn shell, timeout, capture cap, retries/fix)
- `src/changed.ts` — `--changed`: git status → glob match against `paths:`
- `src/last.ts` — `.snuff/last.json` + per-gate logs (`--last`, `--show`, `--rerun-failed`, timing-Δ)
- `src/path.ts` — PATH lookup for `requires:`
- `src/fleet.ts` — `--all <dir>`: run every child repo's manifest
- `src/trim.ts` — failure-output compression (signal lines else tail)
- `src/render.ts` — matrix + excerpts, JSON
- `src/init.ts` — seed manifest from package.json scripts / Makefile targets
- `src/types.ts` — shared types

## Rules
- No runtime npm deps today; add one when it earns its keep (see Stack)
- The YAML parser stays constrained to the manifest shape — if a manifest need
  outgrows it, extend the shape deliberately (parser + renderManifestYaml +
  round-trip test together), don't reach for a YAML lib
- Exit code 0 only when all non-allowFail gates pass — hooks and CI rely on it
- Roadmap lives in PLAN.md (open queue only; DONE.md is history — don't read it unless pointed there) — check it before proposing features
