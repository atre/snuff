import { existsSync, readdirSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { changedLookup, skipsForChanged } from './changed.js';
import { filterByTags, findManifest, loadManifest, selectGates } from './manifest.js';
import { saveLast } from './last.js';
import { runAll, type RunOptions } from './runner.js';
import { isRunOk } from './render.js';
import type { GateResult } from './types.js';

export interface FleetRepoResult {
  name: string;
  /** absolute */
  dir: string;
  ok: boolean;
  gates: GateResult[];
  /** set when loadManifest/runAll itself threw — the repo is reported (`✗ name — <error>`), not silently dropped */
  error?: string;
  /** set when nothing ran on purpose (e.g. `--tag` matched no gates here) — reported as `–`, counts as ok */
  skipped?: string;
}

/** Per-repo options forwarded from the `snuff --all` command line to each child run. */
export interface FleetOptions {
  /** concurrent repos (default: CPU count); each repo runs its gates with jobs: 1 */
  jobs?: number;
  tags?: string[];
  changed?: boolean;
  fix?: boolean;
  failFast?: boolean;
}

/** Direct child directories of `root` that have a manifest, sorted alphabetically for a stable report order. */
export function listManifests(root: string): string[] {
  const abs = resolve(root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`--all: no such dir ${root}`);
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => join(abs, name))
    .filter((dir) => findManifest(dir) !== undefined);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return results;
}

async function runRepo(dir: string, opts: FleetOptions): Promise<FleetRepoResult> {
  const name = basename(dir);
  try {
    const manifest = loadManifest(dir);
    let gates = manifest.gates;
    if (opts.tags && opts.tags.length > 0) {
      const tagged = filterByTags(gates, opts.tags);
      if (tagged.length === 0) return { name, dir, ok: true, gates: [], skipped: `no gates tagged ${opts.tags.join(', ')}` };
      gates = selectGates(gates, tagged.map((g) => g.name));
    }
    const runOpts: RunOptions = { jobs: 1, fix: opts.fix, failFast: opts.failFast };
    if (opts.changed) runOpts.skip = skipsForChanged(gates, changedLookup(dir));
    const results = await runAll(gates, dir, runOpts);
    saveLast(dir, results);
    return { name, dir, ok: isRunOk(results), gates: results };
  } catch (err) {
    return { name, dir, ok: false, gates: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run every child repo's manifest under `root`. Each repo runs its gates
 * sequentially (jobs: 1); repos themselves run concurrently up to `jobs`.
 * A repo whose manifest fails to load is reported as a red, errored entry
 * rather than aborting the rest of the fleet.
 */
export async function runFleet(root: string, opts: FleetOptions = {}): Promise<FleetRepoResult[]> {
  const dirs = listManifests(root);
  return mapLimit(dirs, opts.jobs ?? availableParallelism(), (dir) => runRepo(dir, opts));
}
