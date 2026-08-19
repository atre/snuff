import test from 'node:test';
import assert from 'node:assert/strict';
import { trimFailure } from '../src/trim.js';

test('keeps signal-bearing lines, plus the stack frame right after one', () => {
  const excerpt = trimFailure(
    [
      'compiling 214 modules...',
      'ok 1 - warmup',
      "AssertionError: expected 402, got 200",
      '    at OrderFlow.refund (src/orders.ts:141:9)',
      '2 passing, 1 failing',
    ].join('\n'),
  );

  assert.deepEqual(excerpt, [
    "AssertionError: expected 402, got 200",
    '    at OrderFlow.refund (src/orders.ts:141:9)',
    '2 passing, 1 failing',
  ]);
});

test('falls back to the tail when nothing matches', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const excerpt = trimFailure(lines.join('\n'), 5);
  assert.deepEqual(excerpt, ['line 25', 'line 26', 'line 27', 'line 28', 'line 29']);
});

test('caps line length', () => {
  const [line] = trimFailure(`error: ${'x'.repeat(500)}`);
  assert.equal(line.length, 200);
  assert.ok(line.endsWith('…'));
});

test('matches plural "failures" summary lines', () => {
  assert.deepEqual(trimFailure('compiling\n2 failures\n'), ['2 failures']);
});

test('tsc trimmer: file:line/col + summary, drops noise', () => {
  const excerpt = trimFailure('src/a.ts(3,5): error TS2322: bad\nnoise\nFound 1 error.\n', 15, { run: 'npm run lint' });
  assert.deepEqual(excerpt, ['src/a.ts(3,5): error TS2322: bad', 'Found 1 error.']);
});

test('eslint trimmer: path from header line + summary', () => {
  const excerpt = trimFailure(
    ['src/a.js', '  1:1  error  Missing semicolon', '', '✖ 1 problem (1 error, 0 warnings)'].join('\n'),
  );
  assert.deepEqual(excerpt, ['src/a.js:1:1  error  Missing semicolon', '✖ 1 problem (1 error, 0 warnings)']);
});

test('ruff trimmer: concise lines + summary', () => {
  const excerpt = trimFailure(['src/a.py:10:1: F401 unused import', 'Found 1 error.'].join('\n'));
  assert.deepEqual(excerpt, ['src/a.py:10:1: F401 unused import', 'Found 1 error.']);
});

test('node --test trimmer: not-ok lines + fail count', () => {
  const excerpt = trimFailure(
    ['not ok 1 - a thing', '  ---', '  ...', '# pass 2', '# fail 1'].join('\n'),
  );
  assert.deepEqual(excerpt, ['not ok 1 - a thing', '# fail 1']);
});

test('pytest trimmer: FAILED lines + summary', () => {
  const noise = Array.from({ length: 15 }, (_, i) => `PASSED tests/x.py::t${i}`);
  const excerpt = trimFailure(
    [...noise, 'FAILED tests/x.py::t - AssertionError', '1 failed, 3 passed in 0.2s'].join('\n'),
  );
  assert.deepEqual(excerpt, ['FAILED tests/x.py::t - AssertionError', '1 failed, 3 passed in 0.2s']);
});

test('pytest trimmer: picks the banded ==== summary line pytest actually prints', () => {
  const output = [
    '============================= test session starts ==============================',
    'collected 3 items',
    '',
    'tests/test_x.py F.F                                                      [100%]',
    '',
    '=================================== FAILURES ===================================',
    '__________________________________ test_a ______________________________________',
    '    assert 1 == 2',
    'E   assert 1 == 2',
    'tests/test_x.py:4: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED tests/test_x.py::test_a - assert 1 == 2',
    'FAILED tests/test_x.py::test_c - assert 3 == 4',
    '========================= 2 failed, 1 passed in 0.12s ==========================',
  ].join('\n');
  assert.deepEqual(trimFailure(output), [
    'FAILED tests/test_x.py::test_a - assert 1 == 2',
    'FAILED tests/test_x.py::test_c - assert 3 == 4',
    '========================= 2 failed, 1 passed in 0.12s ==========================',
  ]);
  const short = ['FAILED t.py::a', '= 1 failed ='].join('\n');
  assert.deepEqual(trimFailure(short), ['FAILED t.py::a', '= 1 failed =']);
});

test('trimmer caps to N items + summary, keeping the first errors', () => {
  const errors = Array.from({ length: 30 }, (_, i) => `f${i}.ts(1,1): error TS1: e${i}`);
  const excerpt = trimFailure([...errors, 'Found 30 errors.'].join('\n'), 5);
  assert.deepEqual(excerpt, [
    'f0.ts(1,1): error TS1: e0',
    'f1.ts(1,1): error TS1: e1',
    'f2.ts(1,1): error TS1: e2',
    'f3.ts(1,1): error TS1: e3',
    'Found 30 errors.',
  ]);
});

test('strips ANSI escapes before detecting', () => {
  const excerpt = trimFailure('\x1b[31msrc/a.ts(3,5): error TS2322: bad\x1b[0m\nFound 1 error.\n');
  assert.deepEqual(excerpt, ['src/a.ts(3,5): error TS2322: bad', 'Found 1 error.']);
});

test('match: replaces the trimmer/SIGNAL selection with only matching lines', () => {
  const excerpt = trimFailure('warn: a\nERR: b\nERR: c\n', 15, { match: [/^ERR/] });
  assert.deepEqual(excerpt, ['ERR: b', 'ERR: c']);
});

test('ignore: drops noise before SIGNAL runs on what is left', () => {
  const excerpt = trimFailure('debug: x\nerror: y\n', 15, { ignore: [/^debug/] });
  assert.deepEqual(excerpt, ['error: y']);
});

test('ignore: removes a line a trimmer would otherwise have picked up', () => {
  const excerpt = trimFailure(
    'src/a.ts(3,5): error TS2322: bad\nsrc/b.ts(1,1): error TS9999: noisy\nFound 2 errors.\n',
    15,
    { ignore: [/TS9999/] },
  );
  assert.deepEqual(excerpt, ['src/a.ts(3,5): error TS2322: bad', 'Found 2 errors.']);
});

test('ignore then match: ignore runs first, match selects from what is left', () => {
  const excerpt = trimFailure('debug: skip\nERR: keep\nother: skip too\n', 15, {
    ignore: [/^debug/],
    match: [/^ERR/],
  });
  assert.deepEqual(excerpt, ['ERR: keep']);
});

test('dedupes a run of exact-duplicate lines to the first + a count', () => {
  const excerpt = trimFailure(Array(6).fill('error: same').join('\n'));
  assert.deepEqual(excerpt, ['error: same', '  … 5 more like this']);
});

test('non-consecutive duplicates do not collapse', () => {
  const excerpt = trimFailure('error: x\nerror: other\nerror: x', 15, { match: [/^error/] });
  assert.deepEqual(excerpt, ['error: x', 'error: other', 'error: x']);
});

test('collapses a run of stack frames to the first in-repo frame', () => {
  const excerpt = trimFailure(
    'Error: x\n    at f (node_modules/lib/a.js:1:1)\n    at g (src/x.ts:9:3)\n    at h (node:internal/y:1:1)',
  );
  assert.deepEqual(excerpt, ['Error: x', '    at g (src/x.ts:9:3)']);
});

test('an all-foreign frame run falls back to the first frame instead of vanishing', () => {
  const excerpt = trimFailure(
    'Error: x\n    at f (node_modules/lib/a.js:1:1)\n    at h (node:internal/y:1:1)',
  );
  assert.deepEqual(excerpt, ['Error: x', '    at f (node_modules/lib/a.js:1:1)']);
});

test('a lone stack frame passes through unchanged', () => {
  const excerpt = trimFailure('Error: x\n    at g (src/x.ts:9:3)');
  assert.deepEqual(excerpt, ['Error: x', '    at g (src/x.ts:9:3)']);
});
