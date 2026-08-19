import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Gate } from './types.js';

/** Paths changed vs HEAD (staged, unstaged, untracked), repo-relative to cwd. */
export function changedPaths(cwd: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall', '--no-renames', '.'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr).trim() : '';
    throw new Error(`--changed needs git: ${msg || 'git status failed'}`);
  }
  const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd, encoding: 'utf8' }).trim();
  return parsePorcelain(out).map((p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p));
}

/** Parse `git status --porcelain=v1 -z` output (NUL-separated, never quoted) into paths. */
export function parsePorcelain(out: string): string[] {
  return out
    .split('\0')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3));
}

/**
 * Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char,
 * `{a,b}` alternation. Anchored to the whole path. A trailing `/` or a bare
 * directory name matches everything beneath it.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += `(?:${g
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  // `src` (no glob chars) also matches `src/anything`
  return new RegExp(`^${re}(?:/.*)?$`);
}

/**
 * Per-gate changed-files lookup, memoized per distinct baseDir so each directory's `git
 * status` runs once even across many gates. An `include:`d gate carries `gate.baseDir`
 * (the included repo's own dir, set by manifest.ts) and must be checked against THAT
 * repo's git status, not the including repo's — they're separate working trees.
 */
export function changedLookup(cwd: string): (gate: Gate) => string[] {
  const cache = new Map<string, string[]>();
  // eager for the main cwd — matches the historical (pre-`include:`) behavior of always
  // running `git status` once up front, so e.g. a non-git cwd still errors immediately
  // even when no gate happens to declare `paths:`. Other baseDirs (from `include:`d
  // gates) are resolved lazily, only when a gate with `paths:` actually needs them.
  cache.set(cwd, changedPaths(cwd));
  return (gate: Gate) => {
    const dir = gate.baseDir ?? cwd;
    let v = cache.get(dir);
    if (v === undefined) {
      v = changedPaths(dir);
      cache.set(dir, v);
    }
    return v;
  };
}

/** Gates with `paths:` none of which matched a changed file → name → reason. */
export function skipsForChanged(gates: Gate[], changedFor: (gate: Gate) => string[]): Map<string, string> {
  const skip = new Map<string, string>();
  for (const g of gates) {
    if (!g.paths || g.paths.length === 0) continue;
    const res = g.paths.map(globToRegExp);
    if (!changedFor(g).some((f) => res.some((r) => r.test(f)))) skip.set(g.name, 'no changes in paths');
  }
  return skip;
}

/** Subset of `paths` modified after `sinceMs` (mtime), keeping paths that no longer exist (deleted counts as changed). */
export function changedSince(cwd: string, paths: string[], sinceMs: number): string[] {
  return paths.filter((p) => {
    try {
      return statSync(join(cwd, p)).mtimeMs > sinceMs;
    } catch {
      return true;
    }
  });
}

/**
 * `--hook` skip set: a gate with `paths:` is skipped when none of its files changed since the
 * gate itself last ran (per-gate baseline), so a long-dirty tree does not re-run everything on
 * every Stop. Gates that were hard-red last time always run again; gates with no baseline
 * (never ran) fall back to the vs-HEAD rule.
 */
export function skipsForHook(
  gates: Gate[],
  dirtyFor: (gate: Gate) => string[],
  cwd: string,
  baseline: { ranAt: Map<string, number>; red: Set<string> } | undefined,
): Map<string, string> {
  if (!baseline) return skipsForChanged(gates, dirtyFor);
  const skip = new Map<string, string>();
  for (const g of gates) {
    if (!g.paths || g.paths.length === 0) continue;
    if (baseline.red.has(g.name)) continue;
    const res = g.paths.map(globToRegExp);
    const mine = dirtyFor(g).filter((f) => res.some((r) => r.test(f)));
    if (mine.length === 0) {
      skip.set(g.name, 'no changes in paths');
      continue;
    }
    const since = baseline.ranAt.get(g.name);
    // mtime check is against the gate's own dir too — `mine` are paths relative to it.
    if (since !== undefined && changedSince(g.baseDir ?? cwd, mine, since).length === 0) {
      skip.set(g.name, 'unchanged since last run');
    }
  }
  return skip;
}
