#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { changedLookup, skipsForChanged, skipsForHook } from './changed.js';
import { parseArgs, printHelp, printVersion } from './cli.js';
import { runFleet } from './fleet.js';
import { cmdInit } from './init.js';
import { clearLastBlock, failedNames, gateDurationHistory, lastRunBaseline, previousDurations, readLast, readLastBlock, readLog, redFingerprint, saveLast, saveLastBlock, writeLastResult } from './last.js';
import { filterByTags, findManifest, loadManifest, selectGates } from './manifest.js';
import {
  doctorFindings,
  isRunOk,
  renderDoctor,
  renderDoctorJson,
  renderFleet,
  renderFleetJson,
  renderGha,
  renderJson,
  renderManifestLine,
  renderProgress,
  renderStepSummary,
  renderText,
} from './render.js';
import { runAll, setSignalReporter, type RunOptions } from './runner.js';
import type { GateResult } from './types.js';

async function main(): Promise<void> {
  const { command, names, flags } = parseArgs(process.argv);
  const cwd = process.cwd();
  const color = (process.stdout.isTTY && !process.env.NO_COLOR) || !!process.env.FORCE_COLOR;

  if (command === 'help') return printHelp();
  if (command === 'version') return printVersion();
  if (command === 'init') {
    process.exitCode = cmdInit(cwd, {
      force: flags.force,
      reseed: flags.reseed,
      claude: flags.claude,
      suggest: flags.suggest,
      preCommit: flags.preCommit,
      prePush: flags.prePush,
      hookTimeout: flags.hookTimeout,
    });
    return;
  }
  if (command === 'show') {
    const [name] = names;
    const log = readLog(cwd, name);
    if (log === undefined) {
      console.error(`snuff: no saved log for "${name}" — run snuff first`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(log);
    return;
  }
  if (command === 'fleet') {
    if (flags.rerunFailed) throw new Error('--all does not take --rerun-failed');
    // per-repo flags are forwarded to every child run; --lines only shapes --json (text is one line per repo)
    const repos = await runFleet(flags.all!, {
      jobs: flags.jobs,
      tags: flags.tags,
      changed: flags.changed,
      fix: flags.fix,
      failFast: flags.failFast,
    });
    const ok = repos.every((r) => r.ok);
    if (!flags.quiet || !ok) {
      console.log(
        flags.json ? JSON.stringify(renderFleetJson(repos, { lines: flags.lines }), null, 2) : renderFleet(repos),
      );
    }
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === 'doctor') {
    const manifest = loadManifest(cwd);
    const findings = doctorFindings(manifest.gates, gateDurationHistory(cwd));
    console.log(flags.json ? renderDoctorJson(findings) : renderDoctor(findings));
    if (findings.length > 0) process.exitCode = 1;
    return;
  }
  if (command === 'last') {
    const last = readLast(cwd);
    if (!last) {
      console.error('snuff: no previous run here');
      process.exitCode = 1;
      return;
    }
    console.log(
      flags.json ? renderJson(last.results, { lines: flags.lines }) : renderText(last.results, { lines: flags.lines, color }),
    );
    if (!isRunOk(last.results)) process.exitCode = 1;
    return;
  }

  const manifest = loadManifest(cwd);
  // loadManifest just succeeded, so a manifest is definitely there.
  const manifestPath = findManifest(cwd)!;
  if (flags.rerunFailed && flags.tags && flags.tags.length > 0) {
    throw new Error('--rerun-failed cannot be combined with --tag');
  }
  let selectedNames = names;
  if (flags.rerunFailed) {
    const last = readLast(cwd);
    if (!last) {
      console.error('snuff: no previous run here');
      process.exitCode = 1;
      return;
    }
    const known = new Set(manifest.gates.map((g) => g.name));
    selectedNames = failedNames(last, known);
    if (selectedNames.length === 0) {
      console.log('nothing failed last run');
      return;
    }
  } else if (flags.tags && flags.tags.length > 0) {
    const tagged = filterByTags(manifest.gates, flags.tags);
    if (tagged.length === 0) {
      const have = [...new Set(manifest.gates.flatMap((g) => g.tags ?? []))].sort();
      console.error(`snuff: no gates tagged "${flags.tags.join(', ')}" — have: ${have.join(', ') || 'none'}`);
      process.exitCode = 1;
      return;
    }
    selectedNames = tagged.map((g) => g.name);
  }
  const gates = selectedNames.length > 0 ? selectGates(manifest.gates, selectedNames) : manifest.gates;

  const opts: RunOptions = {
    jobs: flags.jobs ?? manifest.defaults?.jobs,
    fix: flags.fix,
    failFast: flags.failFast,
  };
  // Stop hook runs on every stop — only re-run gates whose paths changed.
  if (flags.changed || flags.hook) {
    try {
      // per-gate lookup: an `include:`d gate's paths are checked against its own repo's
      // git status (gate.baseDir), not this one's — see changed.ts:changedLookup.
      const changedFor = changedLookup(cwd);
      // --hook: per-gate baseline (files changed since that gate last ran); --changed: vs HEAD
      opts.skip = flags.hook && !flags.changed
        ? skipsForHook(gates, changedFor, cwd, lastRunBaseline(cwd))
        : skipsForChanged(gates, changedFor);
    } catch (err) {
      // --hook outside a git repo (or git missing) degrades to a full run — an explicit --changed still errors
      if (!flags.hook || flags.changed) throw err;
      process.stderr.write('snuff: --hook: not a git repo — running all gates\n');
    }
  }

  // Live matrix on a TTY (stderr, so stdout stays clean for piping/--json).
  const live = process.stderr.isTTY && !flags.json;
  // stderr can be a live terminal even when stdout is piped (`snuff | tee log`) — its own check, not `color`.
  const progressColor = (live && !process.env.NO_COLOR) || !!process.env.FORCE_COLOR;
  let latest = new Map<string, GateResult>();
  const start = Date.now();
  opts.onProgress = (done, running) => {
    latest = done;
    if (live) process.stderr.write(`\r\x1b[K${renderProgress(gates, done, running, progressColor)}`);
  };
  setSignalReporter(() => {
    if (live) process.stderr.write('\r\x1b[K');
    if (latest.size > 0) {
      if (!flags.json) console.log(renderManifestLine(manifestPath));
      console.log(
        flags.json
          ? renderJson([...latest.values()], { lines: flags.lines, durationMs: Date.now() - start })
          : renderText([...latest.values()], { lines: flags.lines, color, durationMs: Date.now() - start }),
      );
    }
  });

  const results = await runAll(gates, cwd, opts);
  const wallMs = Date.now() - start;
  if (live) process.stderr.write('\r\x1b[K');
  const previous = previousDurations(cwd);
  saveLast(cwd, results);
  writeLastResult(cwd, results);
  const ok = isRunOk(results);

  if (flags.gha) {
    for (const line of renderGha(results, { lines: flags.lines })) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderStepSummary(results)}\n`);
    }
  }

  // Stop-hook contract: green is silent (exit 0); red goes to stderr with
  // exit 2, which blocks the stop and feeds the matrix back to the session —
  // ONCE per distinct red. Blocking again on the same red loops forever when
  // the fix is a human step (baselines, verdicts), so: `stop_hook_active`
  // (Claude Code: a hook already blocked this turn) → never block; the same
  // fingerprint as the last blocked Stop → one "still red" line, exit 0.
  if (flags.hook) {
    if (ok) {
      clearLastBlock(cwd);
      return;
    }
    const redNames = results.filter((r) => r.skipped === undefined && !r.ok && r.gate.allowFail !== true).map((r) => r.gate.name);
    const fp = redFingerprint(results);
    const prevBlock = readLastBlock(cwd);
    const hookInput = readHookInput();
    if (hookInput?.stop_hook_active) {
      process.stderr.write(`snuff: still red (${redNames.join(', ')}) — already blocked this turn, not blocking again; \`snuff --show ${redNames[0]}\` for the log\n`);
      return;
    }
    if (prevBlock && prevBlock.fingerprint === fp) {
      saveLastBlock(cwd, fp, prevBlock.count + 1);
      process.stderr.write(`snuff: still red (${redNames.join(', ')}) — same as the last blocked Stop, not blocking again (${prevBlock.count + 1}×); \`snuff --show ${redNames[0]}\` for the log\n`);
      return;
    }
    saveLastBlock(cwd, fp, 1);
    process.stderr.write(`${renderManifestLine(manifestPath)}\n${renderText(results, { previous, lines: flags.lines, durationMs: wallMs })}\n`);
    process.exitCode = 2;
    return;
  }

  if (!flags.quiet || !ok) {
    if (!flags.json) console.log(renderManifestLine(manifestPath));
    console.log(
      flags.json
        ? renderJson(results, { lines: flags.lines, durationMs: wallMs })
        : renderText(results, { previous, lines: flags.lines, color, durationMs: wallMs }),
    );
  }
  if (!ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`snuff: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

/** Claude Code hook stdin (JSON) when piped; undefined on a TTY or when unparsable. */
function readHookInput(): { stop_hook_active?: boolean } | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as { stop_hook_active?: boolean }) : undefined;
  } catch {
    return undefined;
  }
}
