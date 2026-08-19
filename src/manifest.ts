import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { globToRegExp } from './changed.js';
import type { Gate, Manifest } from './types.js';

export const MANIFEST_NAMES = ['snuff.yaml', 'snuff.yml', 'snuff.json'];

export function findManifest(dir: string): string | undefined {
  return MANIFEST_NAMES.map((n) => join(dir, n)).find((p) => existsSync(p));
}

/**
 * Load this dir's manifest. `seen` tracks the include chain currently being
 * resolved (absolute dirs) so `include:` cycles throw instead of recursing
 * forever — internal, callers never pass it.
 */
export function loadManifest(dir: string, seen: Set<string> = new Set()): Manifest {
  const path = findManifest(dir);
  if (!path) {
    throw new Error(`no ${MANIFEST_NAMES.join(' / ')} found here — run \`snuff init\``);
  }
  const absDir = resolve(dir);
  if (seen.has(absDir)) throw new Error(`${path}: include cycle back to ${dir}`);
  const text = readFileSync(path, 'utf8');
  let manifest: Manifest;
  if (path.endsWith('.json')) {
    const parsed = JSON.parse(text) as {
      gates?: Array<Record<string, unknown>>;
      defaults?: Record<string, unknown>;
      include?: unknown;
    };
    let include: string[] | undefined;
    if (parsed.include !== undefined) {
      include = stringList(parsed.include);
      if (!include) throw new Error(`${path}: "include" must be a list of strings`);
      if (include.length === 0) include = undefined;
    }
    manifest = {
      gates: (parsed.gates ?? []).map(coerceGate),
      defaults: parsed.defaults !== undefined ? coerceDefaults(parsed.defaults) : undefined,
      include,
    };
  } else {
    manifest = parseManifestYaml(text);
  }
  manifest = { ...manifest, gates: expandEach(manifest.gates, dir) };
  manifest = applyDefaults(manifest);

  if (manifest.include && manifest.include.length > 0) {
    seen.add(absDir);
    const labelSeen = new Map<string, string>();
    try {
      for (const inc of manifest.include) {
        const incDir = resolve(dir, inc);
        let included: Manifest;
        try {
          included = loadManifest(incDir, seen);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`${path}: include "${inc}" (${incDir}): ${msg}`);
        }
        const label = basename(inc.replace(/\/+$/, '')) || inc;
        const otherInc = labelSeen.get(label);
        if (otherInc !== undefined && otherInc !== inc) {
          throw new Error(
            `${path}: include "${inc}" and "${otherInc}" both resolve to label "${label}" — rename one directory or use a more specific include path`,
          );
        }
        labelSeen.set(label, inc);
        for (const g of included.gates) {
          manifest.gates.push({
            ...g,
            name: `${label}/${g.name}`,
            ...(g.needs?.length ? { needs: g.needs.map((n) => `${label}/${n}`) } : {}),
            baseDir: g.baseDir ?? incDir,
          });
        }
      }
    } finally {
      seen.delete(absDir);
    }
  }

  if (manifest.gates.length === 0) throw new Error(`${path}: no gates defined`);
  validateGraph(manifest.gates);
  return manifest;
}

type RawValue = string | string[] | Record<string, string>;
type RawGate = Record<string, RawValue>;

// Constrained parser for the manifest shape — NOT general YAML. Supported:
//   defaults:                    top-level map, applied to gates lacking their own
//     timeout: 30
//     jobs: 2
//     env:
//       CI: "1"
//   gates:                       top-level list of gate maps
//     - name: x                  scalar keys (quotes optional)
//       needs: [a, b]            flow list, or a block list:
//       paths:
//         - src/**
//       env:                     one-level map of scalars
//         CI: "1"
// No deeper nesting, no multi-line strings, no anchors.
export function parseManifestYaml(text: string): Manifest {
  const gates: RawGate[] = [];
  const defaultsRaw: RawGate = {};
  let hasDefaults = false;
  const includeRaw: string[] = [];
  let hasInclude = false;
  let section: 'gates' | 'defaults' | 'include' | undefined;
  let current: RawGate | undefined;
  // pending nested key: block list or map being collected under `current`
  let nested: { key: string; indent: number; kind?: 'list' | 'map' } | undefined;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trimEnd();
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();

    if (indent === 0) {
      if (/^gates:\s*$/.test(body)) section = 'gates';
      else if (/^defaults:\s*$/.test(body)) {
        section = 'defaults';
        hasDefaults = true;
        current = defaultsRaw;
      } else if (/^include:/.test(body)) {
        hasInclude = true;
        const [, value] = keyValue(body, i);
        const flow = /^\[(.*)\]$/.exec(value);
        if (flow) includeRaw.push(...splitFlow(flow[1]).map(scalar).filter((s) => s.length > 0));
        else if (value !== '') includeRaw.push(scalar(value));
        section = value === '' ? 'include' : undefined;
      } else section = undefined;
      if (section !== 'defaults') current = undefined;
      nested = undefined;
      continue;
    }
    if (!section) continue;

    // Inside a nested block (deeper than the nested key itself)? Generic over
    // whatever `current` points at — a gate-in-progress, or `defaultsRaw`.
    if (nested && current && indent > nested.indent) {
      const item = /^-\s+(.*)$/.exec(body);
      if (item) {
        if (nested.kind === 'map') throw parseError(i, 'mixed list item inside a map');
        nested.kind = 'list';
        (current[nested.key] as string[]).push(scalar(item[1]));
      } else {
        if (nested.kind === 'list') throw parseError(i, 'mixed key inside a list');
        if (nested.kind === undefined) current[nested.key] = {};
        nested.kind = 'map';
        const [k, v] = keyValue(body, i);
        (current[nested.key] as Record<string, string>)[k] = scalar(v);
      }
      continue;
    }
    nested = undefined;

    if (section === 'gates') {
      const dash = /^-\s+(.*)$/.exec(body);
      if (dash) {
        current = {};
        gates.push(current);
        const [k, v] = keyValue(dash[1], i);
        // key indent for the rest of this gate = indent + "- ".length
        nested = setValue(current, k, v, indent + dash[0].length - dash[1].length);
        continue;
      }
      if (!current) throw parseError(i, 'expected "- name: …" to start a gate');
      const [k, v] = keyValue(body, i);
      nested = setValue(current, k, v, indent);
      continue;
    }

    if (section === 'include') {
      const item = /^-\s+(.*)$/.exec(body);
      if (!item) throw parseError(i, 'expected "- path" inside include:');
      includeRaw.push(scalar(item[1]));
      continue;
    }

    // defaults: a flat map, no dashes
    const [k, v] = keyValue(body, i);
    nested = setValue(defaultsRaw, k, v, indent);
  }

  return {
    gates: gates.map(coerceGate),
    defaults: hasDefaults ? coerceDefaults(defaultsRaw) : undefined,
    include: hasInclude && includeRaw.length > 0 ? includeRaw : undefined,
  };
}

function setValue(
  into: RawGate,
  key: string,
  value: string,
  indent: number,
): { key: string; indent: number; kind?: 'list' | 'map' } | undefined {
  if (value === '') {
    // block list or map follows on deeper-indented lines
    into[key] = [];
    return { key, indent };
  }
  const flow = /^\[(.*)\]$/.exec(value);
  if (flow) {
    into[key] = splitFlow(flow[1]).map(scalar).filter((s) => s.length > 0);
    return undefined;
  }
  into[key] = scalar(value);
  return undefined;
}

// Split a flow list body on commas outside quotes and `{…}` (so `{ts,tsx}` globs survive).
function splitFlow(body: string): string[] {
  const items: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (const c of body) {
    if (quote) {
      cur += c;
      if (escaped) escaped = false;
      else if (c === '\\' && quote === '"') escaped = true;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '{') {
      depth++;
      cur += c;
    } else if (c === '}') {
      depth = Math.max(0, depth - 1);
      cur += c;
    } else if (c === ',' && depth === 0) {
      items.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  items.push(cur.trim());
  return items;
}

function keyValue(fragment: string, lineIdx: number): [string, string] {
  const kv = /^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/.exec(fragment);
  if (!kv) throw parseError(lineIdx, `can't parse "${fragment}" — expected "key: value"`);
  return [kv[1], kv[2] ?? ''];
}

function parseError(lineIdx: number, msg: string): Error {
  return new Error(`snuff.yaml:${lineIdx + 1}: ${msg}`);
}

// Quoted: take the quoted body, ignore anything after (incl. comments).
// Double quotes honour YAML escapes (\\ \" \n \t …); single quotes are literal
// except '' → '. Bare: strip a trailing ` # comment`.
function scalar(value: string): string {
  const dq = /^"((?:[^"\\]|\\.)*)"(\s+#.*)?$/.exec(value);
  if (dq) return unescapeDoubleQuoted(dq[1]);
  const sq = /^'((?:[^']|'')*)'(\s+#.*)?$/.exec(value);
  if (sq) return sq[1].replace(/''/g, "'");
  return value.replace(/\s+#.*$/, '').trimEnd();
}

const DQ_ESCAPES: Record<string, string> = {
  '\\': '\\',
  '"': '"',
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '/': '/',
  ' ': ' ',
  b: '\b',
  f: '\f',
  e: '\x1b',
};

function unescapeDoubleQuoted(body: string): string {
  return body.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|.)/g, (_m, e: string) => {
    if (e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e in DQ_ESCAPES) return DQ_ESCAPES[e];
    throw new Error(`manifest: unknown escape \\${e} in double-quoted scalar`);
  });
}

function coerceEnv(v: unknown, errPrefix: string): Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${errPrefix}: "env" must be a map of KEY: value`);
  }
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
}

function coerceDefaults(raw: Record<string, unknown>): NonNullable<Manifest['defaults']> {
  const defaults: NonNullable<Manifest['defaults']> = {};
  if (raw.timeout !== undefined) {
    const t = Number(raw.timeout);
    if (!Number.isFinite(t) || t <= 0) throw new Error(`defaults: bad timeout "${raw.timeout}"`);
    defaults.timeout = t;
  }
  if (raw.jobs !== undefined) {
    const n = Number(raw.jobs);
    if (!Number.isInteger(n) || n < 1) throw new Error(`defaults: bad jobs "${raw.jobs}"`);
    defaults.jobs = n;
  }
  if (raw.env !== undefined) defaults.env = coerceEnv(raw.env, 'defaults');
  return defaults;
}

/** Apply defaults.timeout/env to gates lacking their own — gate env wins per key. */
export function applyDefaults(manifest: Manifest): Manifest {
  if (!manifest.defaults) return manifest;
  const { timeout, env } = manifest.defaults;
  return {
    ...manifest,
    gates: manifest.gates.map((g) => ({
      ...g,
      // conditional spreads, not `timeout: g.timeout ?? timeout` — that would set
      // an explicit `timeout: undefined` key when neither side has one, which
      // differs from the key being absent for deepEqual/JSON purposes
      ...(g.timeout === undefined && timeout !== undefined ? { timeout } : {}),
      ...(env ? { env: { ...env, ...g.env } } : {}),
    })),
  };
}

function coerceGate(raw: Record<string, unknown>): Gate {
  const name = typeof raw.name === 'string' ? raw.name : '';
  const run = typeof raw.run === 'string' ? raw.run : '';
  if (!name || !run) {
    throw new Error(`manifest: every gate needs "name" and "run" (got ${JSON.stringify(raw)})`);
  }
  const gate: Gate = { name, run };
  if (raw.fix !== undefined) {
    if (typeof raw.fix !== 'string' || !raw.fix) throw new Error(`gate ${name}: "fix" must be a command string`);
    gate.fix = raw.fix;
  }
  if (raw.when !== undefined || raw.if !== undefined) {
    const cond = raw.when ?? raw.if;
    if (typeof cond !== 'string' || !cond) throw new Error(`gate ${name}: "when"/"if" must be a shell condition string`);
    gate.when = cond;
  }
  if (raw.timeout !== undefined) {
    const t = Number(raw.timeout);
    if (!Number.isFinite(t) || t <= 0) throw new Error(`gate ${name}: bad timeout "${raw.timeout}"`);
    gate.timeout = t;
  }
  if (raw.retries !== undefined) {
    const n = Number(raw.retries);
    if (!Number.isInteger(n) || n < 0) throw new Error(`gate ${name}: bad retries "${raw.retries}"`);
    gate.retries = n;
  }
  if (raw.excerptLines !== undefined) {
    const n = Number(raw.excerptLines);
    if (!Number.isInteger(n) || n < 1) throw new Error(`gate ${name}: bad excerptLines "${raw.excerptLines}"`);
    gate.excerptLines = n;
  }
  if (raw.allowFail !== undefined) gate.allowFail = raw.allowFail === true || raw.allowFail === 'true';
  for (const key of ['needs', 'paths', 'requires', 'tags'] as const) {
    if (raw[key] === undefined) continue;
    const list = stringList(raw[key]);
    if (!list) throw new Error(`gate ${name}: "${key}" must be a list of strings`);
    if (list.length > 0) gate[key] = list;
  }
  for (const key of ['match', 'ignore'] as const) {
    if (raw[key] === undefined) continue;
    const list = stringList(raw[key]);
    if (!list) throw new Error(`gate ${name}: "${key}" must be a list of strings`);
    for (const p of list) {
      try {
        new RegExp(p);
      } catch {
        throw new Error(`gate ${name}: bad ${key} regex "${p}"`);
      }
    }
    if (list.length > 0) gate[key] = list;
  }
  if (raw.env !== undefined) gate.env = coerceEnv(raw.env, `gate ${name}`);
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || !raw.cwd) throw new Error(`gate ${name}: "cwd" must be a path`);
    gate.cwd = raw.cwd;
  }
  if (raw.each !== undefined) {
    if (typeof raw.each !== 'string' || !raw.each) throw new Error(`gate ${name}: "each" must be a directory glob string`);
    gate.each = raw.each;
  }
  return gate;
}

function stringList(v: unknown): string[] | undefined {
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

/** Duplicate names, unknown `needs`, cycles. */
export function validateGraph(gates: Gate[]): void {
  const byName = new Map<string, Gate>();
  for (const g of gates) {
    if (byName.has(g.name)) throw new Error(`manifest: duplicate gate name "${g.name}"`);
    byName.set(g.name, g);
  }
  for (const g of gates) {
    for (const n of g.needs ?? []) {
      if (!byName.has(n)) throw new Error(`gate ${g.name}: needs unknown gate "${n}"`);
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, path: string[]): void => {
    const s = state.get(name);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`manifest: needs cycle: ${[...path, name].join(' → ')}`);
    state.set(name, 'visiting');
    for (const n of byName.get(name)?.needs ?? []) visit(n, [...path, name]);
    state.set(name, 'done');
  };
  for (const g of gates) visit(g.name, []);
}

/** The gates named plus, transitively, everything they need — in manifest order. */
export function selectGates(gates: Gate[], names: string[]): Gate[] {
  const byName = new Map(gates.map((g) => [g.name, g]));
  const unknown = names.filter((n) => !byName.has(n));
  if (unknown.length > 0) {
    throw new Error(`unknown gate(s): ${unknown.join(', ')} — have: ${gates.map((g) => g.name).join(', ')}`);
  }
  const wanted = new Set<string>();
  const add = (n: string): void => {
    if (wanted.has(n)) return;
    wanted.add(n);
    for (const d of byName.get(n)?.needs ?? []) add(d);
  };
  names.forEach(add);
  return gates.filter((g) => wanted.has(g.name));
}

/** Gates carrying any of the requested tags — a pure filter, not a selector; feed the result to selectGates for needs. */
export function filterByTags(gates: Gate[], tags: string[]): Gate[] {
  return gates.filter((g) => g.tags?.some((t) => tags.includes(t)));
}

/**
 * `each: sites/*` sugar: expand one gate stanza into N gates, one per matching directory
 * (relative to `dir`, the manifest's own dir), interpolating `{dir}`/`{name}` into
 * name/run/cwd/paths and defaulting `cwd`/`paths` from the match when the gate doesn't set
 * its own. Runs before `validateGraph` so a template whose `name` doesn't include `{name}`
 * (≥2 matches collapsing onto one name) surfaces as the normal duplicate-gate-name error,
 * not a bespoke one here. Gates without `each` pass through unchanged.
 */
export function expandEach(gates: Gate[], dir: string): Gate[] {
  const out: Gate[] = [];
  for (const g of gates) {
    if (g.each === undefined) {
      out.push(g);
      continue;
    }
    const { each, ...rest } = g;
    const dirs = matchEachDirs(dir, each);
    if (dirs.length === 0) throw new Error(`each: ${each} matched no directories`);
    for (const d of dirs) {
      const name = basename(d);
      const interpolate = (s: string): string => s.replace(/\{dir\}/g, d).replace(/\{name\}/g, name);
      const expanded: Gate = { ...rest, name: interpolate(rest.name), run: interpolate(rest.run) };
      expanded.cwd = rest.cwd !== undefined ? interpolate(rest.cwd) : d;
      expanded.paths = rest.paths !== undefined ? rest.paths.map(interpolate) : [`${d}/**`];
      out.push(expanded);
    }
  }
  return out;
}

/**
 * Directories under `baseDir` matching a `/`-separated glob (dirs only). Each non-`**`
 * segment matches exactly one path level via `globToRegExp` (reused per-segment — a bare
 * name's `(?:/.*)?` suffix is inert since directory entry names never contain `/`); `**`
 * matches zero or more levels via recursive descent. Results are relative, `/`-joined, sorted.
 */
function matchEachDirs(baseDir: string, pattern: string): string[] {
  const segments = pattern.split('/').filter((s) => s.length > 0);
  const results: string[] = [];
  const walk = (curDir: string, relParts: string[], segIdx: number): void => {
    if (segIdx === segments.length) {
      if (relParts.length > 0) results.push(relParts.join('/'));
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(curDir, { withFileTypes: true });
    } catch {
      return;
    }
    const seg = segments[segIdx];
    if (seg === '**') {
      walk(curDir, relParts, segIdx + 1); // zero levels
      for (const e of entries) {
        if (e.isDirectory()) walk(join(curDir, e.name), [...relParts, e.name], segIdx); // one more level, stay on **
      }
      return;
    }
    const re = globToRegExp(seg);
    for (const e of entries) {
      if (e.isDirectory() && re.test(e.name)) walk(join(curDir, e.name), [...relParts, e.name], segIdx + 1);
    }
  };
  walk(baseDir, [], 0);
  return results.sort();
}
