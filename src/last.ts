import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Gate, GateResult } from './types.js';

const LAST_DIR = '.snuff';
const LOG_DIR = join(LAST_DIR, 'last');
const LAST_JSON = join(LAST_DIR, 'last.json');

interface LastGate {
  /** epoch ms when this gate last actually executed (not skipped) — --hook's per-gate baseline */
  ranAt?: number;
  gate: Gate;
  ok: boolean;
  skipped: string | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** marker fields render.ts reads — persisted so `--last` reproduces `(fixed)` / `(passed on retry N)` */
  fixed?: boolean;
  attempts?: number;
  /** last DURATION_HISTORY_CAP real durations (oldest first), appended to on each non-skipped run — `doctor`'s timeout-drift data. Missing on last.json written before this field existed; treat as empty history, never crash. */
  durationHistory?: number[];
}

/** How many recent durations to retain per gate for `doctor`'s drift check — enough to smooth one-off spikes without last.json growing unbounded. */
export const DURATION_HISTORY_CAP = 5;

interface LastFile {
  ts: string;
  head: string | null;
  cwd: string;
  ok: boolean;
  gates: LastGate[];
}

/** Gate name → safe filename stem — never build a path from a raw name. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function gitHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Persist a run: `.snuff/last/<gate>.log` (verbatim output, non-skipped gates
 * only) + `.snuff/last.json` (everything else, no output — logs are the
 * source of truth for that). Merges into whatever was already recorded —
 * `snuff <gate>` / `--rerun-failed` only touch the gates they actually ran,
 * so a partial run updates those entries without erasing the rest of the
 * last full picture. Best-effort: a write failure never fails the run.
 */
export function saveLast(cwd: string, results: GateResult[]): void {
  try {
    const prevPath = join(cwd, LAST_JSON);
    const prev = existsSync(prevPath) ? (JSON.parse(readFileSync(prevPath, 'utf8')) as LastFile) : undefined;

    const byName = new Map<string, LastGate>((prev?.gates ?? []).map((g) => [g.gate.name, g]));
    const now = Date.now();
    for (const r of results) {
      const prevEntry = byName.get(r.gate.name);
      const prevRanAt = prevEntry?.ranAt;
      // only a real (non-skipped) run tells us anything about actual runtime — a skipped
      // gate's durationMs is always 0 and must not dilute the history doctor reads.
      const durationHistory = r.skipped === undefined
        ? [...(prevEntry?.durationHistory ?? []), r.durationMs].slice(-DURATION_HISTORY_CAP)
        : prevEntry?.durationHistory;
      byName.set(r.gate.name, {
        ...(r.skipped === undefined ? { ranAt: now } : prevRanAt !== undefined ? { ranAt: prevRanAt } : {}),
        gate: r.gate,
        ok: r.ok,
        skipped: r.skipped ?? null,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        ...(durationHistory !== undefined && durationHistory.length > 0 ? { durationHistory } : {}),
        ...(r.fixed !== undefined ? { fixed: r.fixed } : {}),
        ...(r.attempts !== undefined ? { attempts: r.attempts } : {}),
      });
    }
    const gates = [...byName.values()];

    mkdirSync(join(cwd, LOG_DIR), { recursive: true });
    for (const r of results) {
      const logPath = join(cwd, LOG_DIR, `${sanitize(r.gate.name)}.log`);
      if (r.skipped !== undefined) rmSync(logPath, { force: true });
      else writeFileSync(logPath, r.output);
    }

    const file: LastFile = {
      ts: new Date().toISOString(),
      head: gitHead(cwd),
      cwd,
      ok: gates.every((g) => g.ok || g.skipped !== null || g.gate.allowFail === true),
      gates,
    };
    writeFileSync(prevPath, `${JSON.stringify(file, null, 2)}\n`);
  } catch {
    // best-effort — a run that can't write .snuff/ still reports normally
  }
}

/** Global-home slug for a repo path — byte-identical to brief's `slugFor` (`path.replace(/[/.]/g, '-')`). */
function slugFor(repoPath: string): string {
  return repoPath.replace(/[/.]/g, '-');
}

interface GlobalLastGate {
  name: string;
  ok: boolean;
  skipped: string | null;
  allowFail: boolean;
  durationMs: number;
}

/**
 * Low-detail export for cross-tool consumers (`brief`'s radar): one JSON file
 * per repo under a global home dir, keyed by an absolute-path slug. Distinct
 * from `saveLast`'s repo-local `.snuff/last.json` — this carries no output,
 * just the matrix, so `brief` can show `gates ✗ lint` without reading logs.
 * Best-effort: a write failure never fails the run.
 */
export function writeLastResult(
  cwd: string,
  results: GateResult[],
  home: string = process.env.SNUFF_HOME ?? join(homedir(), '.snuff'),
): void {
  try {
    const gates: GlobalLastGate[] = results.map((r) => ({
      name: r.gate.name,
      ok: r.ok,
      skipped: r.skipped ?? null,
      allowFail: r.gate.allowFail === true,
      durationMs: r.durationMs,
    }));
    const file = {
      ts: Date.now(),
      head: gitHead(cwd),
      cwd,
      ok: gates.every((g) => g.ok || g.skipped !== null || g.allowFail),
      gates,
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, `${slugFor(cwd)}.json`), `${JSON.stringify(file, null, 2)}\n`);
  } catch {
    // best-effort — a run that can't write ~/.snuff still reports normally
  }
}

/** The last run, with `output` rehydrated from its log so renderText/renderJson reproduce the original. */
export function readLast(cwd: string): { ts: string; head: string | null; results: GateResult[] } | undefined {
  const path = join(cwd, LAST_JSON);
  if (!existsSync(path)) return undefined;
  const file = JSON.parse(readFileSync(path, 'utf8')) as LastFile;
  return {
    ts: file.ts,
    head: file.head,
    results: file.gates.map((g) => ({
      gate: g.gate,
      ok: g.ok,
      skipped: g.skipped ?? undefined,
      exitCode: g.exitCode,
      timedOut: g.timedOut,
      durationMs: g.durationMs,
      output: g.skipped !== null ? '' : (readLog(cwd, g.gate.name) ?? ''),
      ...(g.fixed !== undefined ? { fixed: g.fixed } : {}),
      ...(g.attempts !== undefined ? { attempts: g.attempts } : {}),
    })),
  };
}

/** The verbatim saved output for one gate, or undefined if none was recorded. */
export function readLog(cwd: string, name: string): string | undefined {
  const path = join(cwd, LOG_DIR, `${sanitize(name)}.log`);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * Gate name → its durationMs from the last saved run, for timing-Δ display.
 * Must be read before `saveLast` overwrites the file — call this first.
 * Skipped gates are excluded (their stored duration is always 0, which would
 * manufacture a spurious "got slower" the next time they actually run).
 */
export function previousDurations(cwd: string): Map<string, number> {
  const path = join(cwd, LAST_JSON);
  if (!existsSync(path)) return new Map();
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as LastFile;
    return new Map(file.gates.filter((g) => g.skipped === null).map((g) => [g.gate.name, g.durationMs]));
  } catch {
    return new Map();
  }
}

/**
 * Gate name → its recent real-duration history (oldest first, capped at
 * DURATION_HISTORY_CAP), for `doctor`'s timeout-drift check. A gate with no
 * recorded history (never run, or last.json predates this field) is simply
 * absent from the map — never a crash.
 */
export function gateDurationHistory(cwd: string): Map<string, number[]> {
  const path = join(cwd, LAST_JSON);
  if (!existsSync(path)) return new Map();
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as LastFile;
    return new Map(file.gates.filter((g) => (g.durationHistory?.length ?? 0) > 0).map((g) => [g.gate.name, g.durationHistory!]));
  } catch {
    return new Map();
  }
}

/** Names that were red (not skipped, not allowFail) last run, filtered to gates that still exist. */
export function failedNames(last: { results: GateResult[] }, known: Set<string>): string[] {
  return last.results
    .filter((r) => !r.ok && r.skipped === undefined && r.gate.allowFail !== true)
    .map((r) => r.gate.name)
    .filter((n) => known.has(n));
}

/**
 * Per-gate baseline for `--hook`: when each gate last actually ran (epoch ms), plus which gates
 * were hard-red then. Undefined when there is no previous run.
 */
export function lastRunBaseline(cwd: string): { ranAt: Map<string, number>; red: Set<string> } | undefined {
  const path = join(cwd, LAST_JSON);
  if (!existsSync(path)) return undefined;
  const file = JSON.parse(readFileSync(path, 'utf8')) as LastFile;
  const ranAt = new Map<string, number>();
  const red = new Set<string>();
  for (const g of file.gates) {
    if (g.ranAt !== undefined) ranAt.set(g.gate.name, g.ranAt);
    if (g.skipped === null && !g.ok && g.gate.allowFail !== true) red.add(g.gate.name);
  }
  return { ranAt, red };
}

const BLOCK_JSON = join(LAST_DIR, 'last-block.json');

/** Fingerprint of a red run: which gates are hard-red and what they said. */
export function redFingerprint(results: GateResult[]): string {
  const red = results
    .filter((r) => r.skipped === undefined && !r.ok && r.gate.allowFail !== true)
    .map((r) => `${r.gate.name}\u0000${r.output.trim()}`)
    .sort()
    .join('\u0001');
  return createHash('sha1').update(red).digest('hex').slice(0, 12);
}

/** The fingerprint of the red that last blocked a Stop here (and how many times), if any. */
export function readLastBlock(cwd: string): { fingerprint: string; ts: string; count: number } | undefined {
  const path = join(cwd, BLOCK_JSON);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { fingerprint: string; ts: string; count: number };
  } catch {
    return undefined;
  }
}

export function saveLastBlock(cwd: string, fingerprint: string, count: number): void {
  try {
    mkdirSync(join(cwd, LAST_DIR), { recursive: true });
    writeFileSync(join(cwd, BLOCK_JSON), `${JSON.stringify({ fingerprint, ts: new Date().toISOString(), count }, null, 2)}\n`);
  } catch {
    // best-effort
  }
}

export function clearLastBlock(cwd: string): void {
  rmSync(join(cwd, BLOCK_JSON), { force: true });
}
