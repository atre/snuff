import { spawn, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { onPath } from './path.js';
import type { Gate, GateResult } from './types.js';

export const DEFAULT_TIMEOUT_S = 600;
// Cap captured output so a chatty gate can't balloon memory; failures only
// need the tail for the excerpt.
const MAX_CAPTURE = 1_000_000;

/** SNUFF_TIMEOUT seconds if set and valid, else DEFAULT_TIMEOUT_S. Never throws — a bad value is lower-stakes than a bad job count. */
export function defaultTimeoutS(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.SNUFF_TIMEOUT;
  if (v === undefined) return DEFAULT_TIMEOUT_S;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_S;
}

// Gates run in their own process group (detached) so a timeout or Ctrl-C can
// kill the whole tree — `sh -c "npm test"` alone would leave node running.
const active = new Set<ChildProcess>();

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

let signalReporter: ((sig: string) => void) | undefined;

/** Called after children are killed on SIGINT/SIGTERM, before exit — print partial results here. */
export function setSignalReporter(cb: (sig: string) => void): void {
  signalReporter = cb;
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const c of active) killTree(c, sig);
    try {
      signalReporter?.(sig);
    } catch {
      // partial report is best-effort
    }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

function spawnCommand(cmd: string, gate: Gate, cwd: string, timeoutS: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;

    // an included gate (gate.baseDir set by manifest.ts) defaults to its own
    // repo's dir, not the including manifest's — cwd: is still relative to that
    const base = gate.baseDir ?? cwd;
    const child = spawn(cmd, {
      shell: true,
      cwd: gate.cwd ? resolvePath(base, gate.cwd) : base,
      env: gate.env ? { ...process.env, ...gate.env } : process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    active.add(child);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const capture = (chunk: string) => {
      output += chunk;
      if (output.length > MAX_CAPTURE) output = output.slice(-MAX_CAPTURE / 2);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
    }, timeoutS * 1000);

    const finish = (result: SpawnResult) => {
      clearTimeout(timer);
      active.delete(child);
      resolve(result);
    };

    child.on('error', (err) => finish({ ok: false, exitCode: null, timedOut: false, output: String(err) }));
    child.on('close', (code) => finish({ ok: !timedOut && code === 0, exitCode: code, timedOut, output }));
  });
}

export async function runGate(gate: Gate, cwd: string, opts: { fix?: boolean } = {}): Promise<GateResult> {
  const started = Date.now();

  const missing = (gate.requires ?? []).filter((t) => !onPath(t));
  if (missing.length > 0) {
    return {
      gate,
      durationMs: Date.now() - started,
      ok: false,
      exitCode: null,
      timedOut: false,
      output: `missing: ${missing.join(', ')}`,
    };
  }

  const timeoutS = gate.timeout ?? defaultTimeoutS();

  if (gate.when !== undefined) {
    const cond = await spawnCommand(gate.when, gate, cwd, timeoutS);
    if (!cond.ok) {
      return {
        gate,
        durationMs: Date.now() - started,
        ok: false,
        skipped: `when: ${gate.when} false`,
        exitCode: null,
        timedOut: false,
        output: '',
      };
    }
  }

  const maxAttempts = (gate.retries ?? 0) + 1;
  let result = await spawnCommand(gate.run, gate, cwd, timeoutS);
  let attempts = 1;
  while (!result.ok && !result.timedOut && attempts < maxAttempts) {
    result = await spawnCommand(gate.run, gate, cwd, timeoutS);
    attempts++;
  }

  let fixed: boolean | undefined;
  if (!result.ok && opts.fix && gate.fix) {
    await spawnCommand(gate.fix, gate, cwd, timeoutS);
    result = await spawnCommand(gate.run, gate, cwd, timeoutS);
    fixed = result.ok;
  }

  return {
    gate,
    durationMs: Date.now() - started,
    ...result,
    ...(fixed !== undefined ? { fixed } : {}),
    ...(gate.retries !== undefined && gate.retries > 0 ? { attempts } : {}),
  };
}

export interface RunOptions {
  /** max concurrent gates; default = available CPUs */
  jobs?: number;
  /** gate names to skip up-front (e.g. --changed found nothing); value = reason */
  skip?: Map<string, string>;
  /** called after every state change with the results so far (running gates absent) */
  onProgress?: (done: Map<string, GateResult>, running: Set<string>) => void;
  /** on failure, run the gate's fix: command then re-check once */
  fix?: boolean;
  /** stop launching new gates after the first hard (non-allowFail) failure */
  failFast?: boolean;
}

/**
 * Run gates concurrently, honouring `needs:`. A gate whose need failed (not
 * allowFail) is skipped, not run. Results come back in manifest order.
 */
export async function runAll(gates: Gate[], cwd: string, opts: RunOptions = {}): Promise<GateResult[]> {
  const jobs = Math.max(1, opts.jobs ?? availableParallelism());
  const done = new Map<string, GateResult>();
  const running = new Set<string>();
  const pending = new Set(gates.map((g) => g.name));
  const byName = new Map(gates.map((g) => [g.name, g]));
  const notify = () => opts.onProgress?.(done, running);
  // gates that failed or were skipped *because* a need failed — these block
  // dependents; a --changed skip does not (nothing changed = considered fine)
  const blocking = new Set<string>();

  const skipped = (gate: Gate, reason: string): GateResult => ({
    gate,
    ok: false,
    skipped: reason,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    output: '',
  });

  // Needs outside the selection (already filtered out) count as satisfied.
  const needsOf = (g: Gate) => (g.needs ?? []).filter((n) => byName.has(n));

  await new Promise<void>((finished) => {
    const tick = (): void => {
      // 1) resolve everything that can be settled without running
      let settled = true;
      while (settled) {
        settled = false;
        for (const name of pending) {
          const gate = byName.get(name)!;
          const preSkip = opts.skip?.get(name);
          if (preSkip) {
            done.set(name, skipped(gate, preSkip));
            pending.delete(name);
            settled = true;
            continue;
          }
          const blocker = needsOf(gate).find((n) => blocking.has(n));
          if (blocker) {
            done.set(name, skipped(gate, `needs ${blocker}`));
            blocking.add(name);
            pending.delete(name);
            settled = true;
          }
        }
      }
      // 2) launch ready gates up to the job cap
      for (const name of pending) {
        if (running.size >= jobs) break;
        const gate = byName.get(name)!;
        if (!needsOf(gate).every((n) => done.has(n))) continue;
        pending.delete(name);
        running.add(name);
        void runGate(gate, cwd, { fix: opts.fix }).then((r) => {
          running.delete(name);
          done.set(name, r);
          if (!r.ok && r.skipped === undefined && !r.gate.allowFail) {
            blocking.add(name);
            if (opts.failFast) {
              for (const p of pending) done.set(p, skipped(byName.get(p)!, 'fail-fast'));
              pending.clear();
            }
          }
          notify();
          tick();
        });
      }
      notify();
      if (pending.size === 0 && running.size === 0) finished();
    };
    tick();
  });

  return gates.map((g) => done.get(g.name)!);
}
