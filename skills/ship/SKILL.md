---
name: ship
description: Deploy flow composed from the tool fleet — gates before (snuff), the repo's own deploy command, then post-deploy verification (snuff prod profile / peep / looksy, pulse snap → diff). TRIGGER on "ship", "deploy", "release", "push to prod", "go live" in any repo that deploys something. SKIP for library/tool repos with no deploy target (just run `snuff`).
---

# /ship

Composition — nothing here re-implements a check.

## 0. Pre-flight (stop on red)
```sh
git status --short              # untracked/modified under src/** → ask whether they belong in this deploy; never deploy silently with them
snuff                           # full gate matrix must be green (or an explicit allowFail ⚠ you name in the report)
pulse snap pre-deploy 2>/dev/null   # runtime baseline (skip silently if pulse is not installed)
```
Read the repo's `CLAUDE.md` for the deploy command/procedure and any prod URLs — that is the source of truth; if none is documented, stop and ask (deploy is outward-facing).

## 1. Deploy
Run exactly the documented command. Capture output; long output → `| squirt`.

## 2. Verify (all read-only)
```sh
snuff                           # full matrix again, post-deploy (`snuff --profile prod` once PLAN W.2 ships — not implemented yet)
peep check <domain> [--expect noindex]
looksy <prod-url> --check "contrast:aa,no-hscroll,h1-count:1,canonical,meta-description"
pulse diff pre-deploy 2>/dev/null   # new crit/warn since the baseline = the deploy's fault until proven otherwise
```
Any red → report the exact lines and the fix; do not declare shipped.

## 3. Report (≤ 8 lines) — replaces hand-written "status-sync" docs
`shipped <sha> → <target> · gates ✓ · peep ✓/✗ · looksy ✓/✗ · pulse: <n> new findings` + what to watch. Append friction for any fleet tool you used to that tool's `FEEDBACK.md` (global rule). Don't commit/push unless told.
