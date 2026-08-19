import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

test('--lines N parses to flags.lines', () => {
  assert.equal(parseArgs(['n', 's', '--lines', '3']).flags.lines, 3);
});

test('--lines=N form also parses', () => {
  assert.equal(parseArgs(['n', 's', '--lines=7']).flags.lines, 7);
});

test('--lines rejects non-positive-integer values', () => {
  assert.throws(() => parseArgs(['n', 's', '--lines', '0']), /--lines needs a positive integer/);
  assert.throws(() => parseArgs(['n', 's', '--lines', 'x']), /--lines needs a positive integer/);
});

test('no --lines leaves flags.lines undefined', () => {
  assert.equal(parseArgs(['n', 's']).flags.lines, undefined);
});

test('--hook-timeout N / --hook-timeout=N parse to flags.hookTimeout', () => {
  assert.equal(parseArgs(['n', 'init', '--claude', '--hook-timeout', '900']).flags.hookTimeout, 900);
  assert.equal(parseArgs(['n', 'init', '--claude', '--hook-timeout=128']).flags.hookTimeout, 128);
});

test('--hook-timeout rejects non-positive-integer values', () => {
  assert.throws(() => parseArgs(['n', 'init', '--hook-timeout', '0']), /--hook-timeout needs a positive integer/);
  assert.throws(() => parseArgs(['n', 'init', '--hook-timeout', 'x']), /--hook-timeout needs a positive integer/);
});

test('--fix parses to flags.fix; defaults to false', () => {
  assert.equal(parseArgs(['n', 's', '--fix']).flags.fix, true);
  assert.equal(parseArgs(['n', 's']).flags.fix, false);
});

test('--fail-fast parses to flags.failFast; defaults to false', () => {
  assert.equal(parseArgs(['n', 's', '--fail-fast']).flags.failFast, true);
  assert.equal(parseArgs(['n', 's']).flags.failFast, false);
});

test('--tag is repeatable, accumulates into flags.tags', () => {
  assert.deepEqual(parseArgs(['n', 's', '--tag', 'fast', '--tag', 'ci']).flags.tags, ['fast', 'ci']);
});

test('no --tag leaves flags.tags undefined; --tag with no value throws', () => {
  assert.equal(parseArgs(['n', 's']).flags.tags, undefined);
  assert.throws(() => parseArgs(['n', 's', '--tag']), /--tag needs a value/);
});

test('SNUFF_JOBS: used as a fallback when -j is not given', () => {
  assert.equal(parseArgs(['n', 's'], { SNUFF_JOBS: '3' }).flags.jobs, 3);
});

test('SNUFF_JOBS: an explicit -j/--jobs wins over the env var', () => {
  assert.equal(parseArgs(['n', 's', '-j1'], { SNUFF_JOBS: '3' }).flags.jobs, 1);
});

test('SNUFF_JOBS: a bad value throws', () => {
  assert.throws(() => parseArgs(['n', 's'], { SNUFF_JOBS: 'x' }), /SNUFF_JOBS must be a positive integer/);
  assert.throws(() => parseArgs(['n', 's'], { SNUFF_JOBS: '0' }), /SNUFF_JOBS must be a positive integer/);
});

test('no SNUFF_JOBS, no -j → flags.jobs stays undefined', () => {
  assert.equal(parseArgs(['n', 's'], {}).flags.jobs, undefined);
});

test('--reseed parses to flags.reseed; --force stays separate', () => {
  const p = parseArgs(['node', 'snuff', 'init', '--reseed'], {});
  assert.equal(p.command, 'init');
  assert.equal(p.flags.reseed, true);
  assert.equal(p.flags.force, false);
});
