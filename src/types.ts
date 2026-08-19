export interface Gate {
  name: string;
  run: string;
  /** command to run on failure, before one re-check of `run` (only with --fix) */
  fix?: string;
  /** seconds; default 600 */
  timeout?: number;
  /** failure is reported (⚠) but doesn't fail the run */
  allowFail?: boolean;
  /** gates that must finish first; a hard (non-allowFail) failure skips this gate */
  needs?: string[];
  /** external tools that must be on PATH; missing ones report `missing: <tool>` without spawning */
  requires?: string[];
  /** globs; with --changed the gate is skipped when none of them changed */
  paths?: string[];
  /** extra environment for the command */
  env?: Record<string, string>;
  /** working directory, relative to the manifest */
  cwd?: string;
  /** internal only, never set from YAML/JSON — absolute dir `cwd` resolves against; manifest.ts sets this when merging in an `include:`d repo's gates so they default to that repo's dir, not the including manifest's */
  baseDir?: string;
  /** regex sources; when given, only matching excerpt lines survive (replaces the trimmer/SIGNAL fallback) */
  match?: string[];
  /** regex sources; matching lines are dropped from the excerpt before anything else runs */
  ignore?: string[];
  /** max excerpt lines for this gate; overrides the global default (15) / --lines */
  excerptLines?: number;
  /** extra attempts on failure (transient/flaky gates); 0 or absent = no retries */
  retries?: number;
  /** free-form labels; `snuff --tag <t>` runs only gates carrying one of the requested tags */
  tags?: string[];
  /** shell condition checked before `run`; non-zero exit skips the gate without blocking dependents */
  when?: string;
  /** directory glob sugar, e.g. `sites/*` — expands this one stanza into N gates (one per matching
   * directory), interpolating `{dir}` (relative path) / `{name}` (basename) into name/run/cwd/paths,
   * defaulting cwd/paths from the match when absent. Consumed by `expandEach` before validation —
   * never present on a loaded manifest's final gates. */
  each?: string;
}

export interface Manifest {
  gates: Gate[];
  /** shared fallbacks: timeout/env applied to gates lacking their own, jobs is a run-level default */
  defaults?: {
    timeout?: number;
    env?: Record<string, string>;
    jobs?: number;
  };
  /** other repos' manifests to run as part of this one, e.g. `[../streamer]`; each path resolves relative to this manifest's dir, and that repo's gates merge in named `<label>/<name>` (label = the include path's basename) */
  include?: string[];
}

export interface GateResult {
  gate: Gate;
  ok: boolean;
  /** not run: a needed gate failed, or --changed found no matching diff */
  skipped?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  /** set only when a fix attempt happened: whether the re-check passed */
  fixed?: boolean;
  /** set only when gate.retries > 0: how many tries it took (1 = first try) */
  attempts?: number;
}
