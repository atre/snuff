const SIGNAL =
  /(\berror\b|\bfail(s|ed|ure(s)?|ing)?\b|\bassert(ion)?\b|\bexpect(ed)?\b|\bexception\b|\bpanic\b|\btraceback\b|\bfatal\b|✗|✖|\bFAIL\b)/i;

const ANSI = /\x1b\[[0-9;]*m/g;

// A stack-trace frame line never itself contains a SIGNAL keyword, so on its
// own the SIGNAL fallback would drop every frame — including the one useful
// one. Pulled in as context right after a hit, then collapsed below.
const FRAME_LINE = /^\s+at\s/;

interface Picked {
  items: string[];
  summary?: string;
}

interface Trimmer {
  name: string;
  /** output-signature match — the primary detector, tried against every line */
  detect: RegExp;
  /** substring of gate.run — tie-breaker only, when more than one trimmer detects */
  hint?: RegExp;
  /** undefined ⇒ this trimmer declines despite detecting, fall through */
  pick(lines: string[]): Picked | undefined;
}

function pickTsc(lines: string[]): Picked | undefined {
  const items = lines.filter((l) => /^\S+\(\d+,\d+\): error TS\d+/.test(l));
  if (items.length === 0) return undefined;
  return { items, summary: lines.find((l) => /^Found \d+ errors?\b/.test(l)) };
}

function pickEslint(lines: string[]): Picked | undefined {
  let path: string | undefined;
  const items: string[] = [];
  let summary: string | undefined;
  for (const l of lines) {
    const err = /^\s+(\d+:\d+)\s+error\s+(.*)$/.exec(l);
    if (err) {
      if (path) items.push(`${path}:${err[1]}  error  ${err[2]}`);
      continue;
    }
    if (/^✖\s+\d+\s+problems?/.test(l)) {
      summary = l;
      continue;
    }
    if (!/^\s/.test(l)) path = l.trim();
  }
  return items.length > 0 ? { items, summary } : undefined;
}

function pickRuff(lines: string[]): Picked | undefined {
  const items = lines.filter((l) => /^\S+:\d+:\d+: [A-Z]+\d+ /.test(l));
  if (items.length === 0) return undefined;
  return { items, summary: lines.find((l) => /^Found \d+ errors?\b/.test(l)) };
}

function pickNodeTest(lines: string[]): Picked | undefined {
  const items = lines.filter((l) => /^not ok \d+ /.test(l));
  if (items.length === 0) return undefined;
  return { items, summary: lines.find((l) => /^# fail \d+/.test(l)) };
}

function pickPytest(lines: string[]): Picked | undefined {
  const items = lines.filter((l) => /^FAILED \S+/.test(l));
  if (items.length === 0) return undefined;
  // pytest bands the summary: `===== 2 failed, 1 passed in 0.12s =====` (or `= 1 failed =`); `-q` prints it bare
  return { items, summary: lines.find((l) => /^(=+ )?\d+ failed\b/.test(l)) };
}

const TRIMMERS: Trimmer[] = [
  { name: 'tsc', detect: /^\S+\(\d+,\d+\): error TS\d+/, hint: /\btsc\b|typecheck/, pick: pickTsc },
  { name: 'eslint', detect: /^\s+\d+:\d+\s+error\s/, hint: /eslint\b/, pick: pickEslint },
  { name: 'ruff', detect: /^\S+:\d+:\d+: [A-Z]+\d+ /, hint: /\bruff\b/, pick: pickRuff },
  { name: 'node --test', detect: /^not ok \d+ /, hint: /node --test|\bnpm test\b/, pick: pickNodeTest },
  { name: 'pytest', detect: /^FAILED \S+/, hint: /pytest\b/, pick: pickPytest },
];

function selectTrimmer(lines: string[], run?: string): Trimmer | undefined {
  const candidates = TRIMMERS.filter((t) => lines.some((l) => t.detect.test(l)));
  if (candidates.length <= 1) return candidates[0];
  const hinted = run ? candidates.find((t) => t.hint?.test(run)) : undefined;
  return hinted ?? candidates[0];
}

function capLine(l: string): string {
  return l.length > 200 ? `${l.slice(0, 199)}…` : l;
}

// Collapse a run of `    at ...` stack frames to the one frame worth looking
// at — first in-repo frame (not node_modules/, not a `(node:...)` internal),
// falling back to the run's first frame when every one is foreign.
function collapseFrames(lines: string[]): string[] {
  const isRepoFrame = (l: string) => !l.includes('node_modules/') && !l.includes('(node:');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!FRAME_LINE.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && FRAME_LINE.test(lines[j])) j++;
    const run = lines.slice(i, j);
    out.push(run.find(isRepoFrame) ?? run[0]);
    i = j;
  }
  return out;
}

// Collapse a run of exact-duplicate lines to the first + "N more like this".
function collapseDuplicates(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(lines[i]);
    if (j - i - 1 > 0) out.push(`  … ${j - i - 1} more like this`);
    i = j;
  }
  return out;
}

export interface TrimOpts {
  /** the gate's command — tie-breaker when more than one trimmer detects */
  run?: string;
  /** when given, replaces the trimmer table + SIGNAL entirely: only matching lines survive */
  match?: RegExp[];
  /** drops matching lines before anything else runs — noise removal, not a selector */
  ignore?: RegExp[];
}

/**
 * Compress a failed gate's output to the lines someone would act on.
 * `ignore` drops noise first. With `match` given, only matching lines survive
 * (tail-biased, like the SIGNAL fallback) — the escape hatch for tools with
 * no dedicated trimmer. Otherwise: tool-aware trimmers first (tsc/eslint/
 * ruff/node --test/pytest — detected by output signature, `run` as a
 * tie-breaker), keeping their first N picks + summary line, else the generic
 * signal-bearing lines (assertions, errors) plus any stack frames right after
 * one (collapsed to the single frame worth looking at), else the raw tail.
 */
export function trimFailure(output: string, max = 15, opts: TrimOpts = {}): string[] {
  let lines = output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  if (opts.ignore && opts.ignore.length > 0) {
    lines = lines.filter((l) => !opts.ignore!.some((r) => r.test(l)));
  }

  let chosen: string[];
  if (opts.match && opts.match.length > 0) {
    const hits = lines.filter((l) => opts.match!.some((r) => r.test(l)));
    chosen = hits.slice(-max);
  } else {
    const picked = selectTrimmer(lines, opts.run)?.pick(lines);
    if (picked) {
      const budget = picked.summary ? Math.max(max - 1, 1) : max;
      chosen = picked.summary ? [...picked.items.slice(0, budget), picked.summary] : picked.items.slice(0, budget);
    } else {
      // a SIGNAL hit pulls in the stack frames right after it — collapsed
      // below to the one frame worth showing, not dropped outright
      const hits: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!SIGNAL.test(lines[i])) continue;
        hits.push(lines[i]);
        for (let j = i + 1; j < lines.length && FRAME_LINE.test(lines[j]); j++) hits.push(lines[j]);
      }
      chosen = (hits.length > 0 ? hits : lines).slice(-max);
    }
  }

  return collapseDuplicates(collapseFrames(chosen)).map(capLine);
}
