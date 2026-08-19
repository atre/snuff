import type { FleetRepoResult } from './fleet.js';
import { defaultTimeoutS } from './runner.js';
import { trimFailure } from './trim.js';
import type { Gate, GateResult } from './types.js';

function compile(patterns?: string[]): RegExp[] | undefined {
  return patterns?.map((p) => new RegExp(p));
}

function excerptOf(r: GateResult, lines: number): string[] {
  const max = r.gate.excerptLines ?? lines;
  return trimFailure(r.output, max, { run: r.gate.run, match: compile(r.gate.match), ignore: compile(r.gate.ignore) });
}

function paint(sym: string, code: number): string {
  return `\x1b[${code}m${sym}\x1b[0m`;
}

function symbol(r: GateResult, color = false): string {
  const sym = r.ok ? '✓' : r.skipped ? '–' : r.gate.allowFail ? '⚠' : '✗';
  if (!color) return sym;
  return paint(sym, r.ok ? 32 : r.skipped ? 2 : r.gate.allowFail ? 33 : 31);
}

function duration(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

// suffix a matrix cell with (+N.Ns) when a gate got meaningfully slower —
// ≥ 2s and ≥ 50% slower than its last recorded run, to skip noise on quick gates
function cell(r: GateResult, previousMs?: number, color = false): string {
  if (r.skipped) return `${symbol(r, color)} ${r.gate.name}`;
  let base = `${symbol(r, color)} ${r.gate.name} ${duration(r.durationMs)}`;
  if (r.fixed) base += ' (fixed)';
  if (r.ok && r.attempts !== undefined && r.attempts > 1) base += ` (passed on retry ${r.attempts - 1})`;
  if (previousMs === undefined || r.durationMs < 2000 || r.durationMs < previousMs * 1.5) return base;
  return `${base} (+${((r.durationMs - previousMs) / 1000).toFixed(1)}s)`;
}

/** First line of every run: names the resolved manifest so sessions that `cd` between repos can tell which one just gated them. */
export function renderManifestLine(manifestPath: string): string {
  return `snuff.yaml: ${manifestPath}`;
}

/** Live matrix line while gates run: done cells + `… name` for running/pending. */
export function renderProgress(
  gates: Gate[],
  done: Map<string, GateResult>,
  running: Set<string>,
  color = false,
): string {
  return gates
    .map((g) => {
      const r = done.get(g.name);
      if (r) return cell(r, undefined, color);
      return running.has(g.name) ? `… ${g.name}` : `· ${g.name}`;
    })
    .join('  ');
}

export function renderText(
  results: GateResult[],
  opts: { previous?: Map<string, number>; lines?: number; color?: boolean; durationMs?: number } = {},
): string {
  const lines = opts.lines ?? 15;
  const color = opts.color ?? false;
  const out: string[] = [];
  out.push(results.map((r) => cell(r, opts.previous?.get(r.gate.name), color)).join('  '));

  const skipped = results.filter((r) => r.skipped);
  if (skipped.length > 0) {
    out.push('');
    for (const r of skipped) out.push(`– ${r.gate.name}: skipped, ${r.skipped}`);
  }

  for (const r of results.filter((r) => !r.ok && !r.skipped)) {
    const missing = r.exitCode === null && !r.timedOut && r.output.startsWith('missing: ');
    const why = r.timedOut
      ? `timed out after ${r.gate.timeout ?? defaultTimeoutS()}s`
      : missing
        ? r.output.trim()
        : `exit ${r.exitCode ?? '?'}`;
    out.push('');
    out.push(`${symbol(r, color)} ${r.gate.name} → ${why}`);
    if (!missing) for (const line of excerptOf(r, lines)) out.push(`  ${line}`);
  }
  out.push('');
  out.push(renderSummary(results, opts.durationMs));
  return out.join('\n');
}

export function isRunOk(results: GateResult[]): boolean {
  return results.every((r) => r.ok || r.skipped !== undefined || r.gate.allowFail === true);
}

// same per-gate "counts as passed" predicate isRunOk uses, so a fully green
// (or skip/allowFail-covered) run always reports N/N.
function passCount(results: GateResult[]): number {
  return results.filter((r) => r.ok || r.skipped !== undefined || r.gate.allowFail === true).length;
}

// wall-clock when the caller has it (real elapsed time around runAll); else
// the slowest non-skipped gate as a critical-path proxy — gates run
// concurrently, so summing durationMs would overstate the real run time.
function summaryDuration(results: GateResult[], explicitMs?: number): number {
  if (explicitMs !== undefined) return explicitMs;
  return results.filter((r) => r.skipped === undefined).reduce((max, r) => Math.max(max, r.durationMs), 0);
}

/** `N/M gates Ts` — N = gates counted as passed (ok, skipped, or allowFail), M = total, T = wall-clock (or critical-path proxy). */
export function renderSummary(results: GateResult[], durationMs?: number): string {
  return `${passCount(results)}/${results.length} gates ${duration(summaryDuration(results, durationMs))}`;
}

export function toJson(results: GateResult[], opts: { lines?: number; durationMs?: number } = {}) {
  const lines = opts.lines ?? 15;
  return {
    ok: isRunOk(results),
    gates: results.map((r) => ({
      name: r.gate.name,
      ok: r.ok,
      skipped: r.skipped ?? null,
      allowFail: r.gate.allowFail ?? false,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      attempts: r.attempts ?? 1,
      fixed: r.fixed ?? null,
      excerpt: r.ok || r.skipped ? [] : excerptOf(r, lines),
    })),
    summary: { passed: passCount(results), total: results.length, durationMs: summaryDuration(results, opts.durationMs) },
  };
}

export function renderJson(results: GateResult[], opts: { lines?: number; durationMs?: number } = {}): string {
  return JSON.stringify(toJson(results, opts), null, 2);
}

const TSC_LOC = /^(\S+)\((\d+),(\d+)\): (.*)$/;
const GENERIC_LOC = /^(\S+?):(\d+)(?::(\d+))?[: ] ?(.*)$/;

/** GitHub Actions `::error ...` annotations, one per excerpt line — tsc's `file(line,col):` shape first, else generic `file:line[:col]:`, else a title-only annotation. */
export function renderGha(results: GateResult[], opts: { lines?: number } = {}): string[] {
  const linesN = opts.lines ?? 15;
  const out: string[] = [];
  for (const r of results.filter((r) => !r.ok && !r.skipped)) {
    for (const line of excerptOf(r, linesN)) {
      const tsc = TSC_LOC.exec(line);
      if (tsc) {
        out.push(`::error file=${tsc[1]},line=${tsc[2]},col=${tsc[3]}::${tsc[4]}`);
        continue;
      }
      const generic = GENERIC_LOC.exec(line);
      if (generic) {
        const col = generic[3] ? `,col=${generic[3]}` : '';
        out.push(`::error file=${generic[1]},line=${generic[2]}${col}::${generic[4]}`);
        continue;
      }
      out.push(`::error title=${r.gate.name}::${line}`);
    }
  }
  return out;
}

/** One row per gate, for $GITHUB_STEP_SUMMARY. */
export function renderStepSummary(results: GateResult[]): string {
  const rows = results.map((r) => {
    const result = r.skipped !== undefined ? '–' : r.ok ? '✓' : '✗';
    const time = r.skipped !== undefined ? '' : duration(r.durationMs);
    return `| ${r.gate.name} | ${result} | ${time} |`;
  });
  return ['| gate | result | time |', '|---|---|---|', ...rows].join('\n');
}

/**
 * One line per repo: `✓ name  gate ✓ · gate ✗ · 1.2s`; a repo that couldn't
 * run is `✗ name — <error first line>`, one skipped on purpose is `– name  <why>`.
 * Footer: `<N> red` (+ ` · <M> broken` when any repo errored).
 */
export function renderFleet(repos: FleetRepoResult[]): string {
  const lines = repos.map((r) => {
    if (r.error !== undefined) return `✗ ${r.name} — ${r.error.split('\n')[0]}`;
    if (r.skipped !== undefined) return `– ${r.name}  ${r.skipped}`;
    const sym = r.ok ? '✓' : '✗';
    const totalMs = r.gates.reduce((sum, g) => sum + g.durationMs, 0);
    const parts = [
      ...r.gates.map((g) => `${g.gate.name} ${g.ok ? '✓' : g.skipped !== undefined ? '–' : '✗'}`),
      duration(totalMs),
    ];
    return `${sym} ${r.name}  ${parts.join(' · ')}`;
  });
  const red = repos.filter((r) => !r.ok).length;
  const broken = repos.filter((r) => r.error !== undefined).length;
  lines.push(`${red} red${broken > 0 ? ` · ${broken} broken` : ''}`);
  return lines.join('\n');
}

/**
 * Fraction of the configured timeout a gate's max recent duration must reach
 * to be flagged by `doctor`. 80%: a gate regularly landing within 20% of its
 * timeout is one slow CI box, one extra fixture, or one dependency bump away
 * from a spurious timeout kill — and outside every `--tag` used in CI/hooks,
 * nothing surfaces that drift until it actually happens.
 */
export const DOCTOR_THRESHOLD = 0.8;

export interface DoctorFinding {
  name: string;
  timeoutS: number;
  maxDurationMs: number;
  recentDurationsMs: number[];
}

/**
 * Gates whose recent real durations (from `.snuff/last.json` history) sit at
 * or over DOCTOR_THRESHOLD of their configured timeout. A gate with no
 * recorded history (never run, or history predates this feature) is silent —
 * there's nothing to compare yet, not a clean bill of health.
 */
export function doctorFindings(gates: Gate[], history: Map<string, number[]>): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const g of gates) {
    const recent = history.get(g.name);
    if (!recent || recent.length === 0) continue;
    const timeoutS = g.timeout ?? defaultTimeoutS();
    const maxDurationMs = Math.max(...recent);
    if (maxDurationMs >= timeoutS * 1000 * DOCTOR_THRESHOLD) {
      findings.push({ name: g.name, timeoutS, maxDurationMs, recentDurationsMs: recent });
    }
  }
  return findings;
}

/** Text report for `snuff doctor`: silent (one clean line) when every gate has headroom. */
export function renderDoctor(findings: DoctorFinding[]): string {
  if (findings.length === 0) return 'snuff doctor: no timeout drift — every gate has headroom';
  const lines = findings.map((f) => {
    const recent = f.recentDurationsMs.map((ms) => duration(ms)).join(', ');
    const pct = Math.round((f.maxDurationMs / (f.timeoutS * 1000)) * 100);
    return `⚠ ${f.name} — timeout ${f.timeoutS}s, recent runs ${recent} (max ${duration(f.maxDurationMs)}, ${pct}% of timeout)`;
  });
  return [
    `${findings.length} gate${findings.length === 1 ? '' : 's'} at risk of a timeout kill (>= ${Math.round(DOCTOR_THRESHOLD * 100)}% of configured timeout):`,
    '',
    ...lines,
  ].join('\n');
}

export function renderDoctorJson(findings: DoctorFinding[]): string {
  return JSON.stringify({ ok: findings.length === 0, threshold: DOCTOR_THRESHOLD, findings }, null, 2);
}

export function renderFleetJson(repos: FleetRepoResult[], opts: { lines?: number } = {}): object {
  return {
    ok: repos.every((r) => r.ok),
    repos: repos.map((r) => ({
      name: r.name,
      dir: r.dir,
      ok: r.ok,
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.skipped !== undefined ? { skipped: r.skipped } : {}),
      gates: toJson(r.gates, opts).gates,
    })),
  };
}
