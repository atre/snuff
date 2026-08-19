import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateDurationHistory, saveLast } from '../src/last.js';
import { doctorFindings, renderDoctor, renderDoctorJson } from '../src/render.js';
import { runAll } from '../src/runner.js';
import type { Gate } from '../src/types.js';

function tmp(tag: string): string {
  return mkdtempSync(join(tmpdir(), `snuff-doctor-${tag}-`));
}

// Write a `.snuff/last.json` fixture directly — doctor reads history, never re-runs gates.
function writeFixture(dir: string, gates: Array<{ name: string; run?: string; timeout?: number; durationHistory: number[] }>): void {
  mkdirSync(join(dir, '.snuff'), { recursive: true });
  const file = {
    ts: new Date().toISOString(),
    head: null,
    cwd: dir,
    ok: true,
    gates: gates.map((g) => ({
      gate: { name: g.name, run: g.run ?? 'echo x', ...(g.timeout !== undefined ? { timeout: g.timeout } : {}) },
      ok: true,
      skipped: null,
      exitCode: 0,
      timedOut: false,
      durationMs: g.durationHistory[g.durationHistory.length - 1] ?? 0,
      durationHistory: g.durationHistory,
    })),
  };
  writeFileSync(join(dir, '.snuff', 'last.json'), JSON.stringify(file, null, 2));
}

test('doctorFindings: history near/over timeout is flagged, headroom stays silent', () => {
  const gates: Gate[] = [
    { name: 'preflight', run: 'x', timeout: 600 },
    { name: 'lint', run: 'x', timeout: 120 },
  ];
  const history = new Map<string, number[]>([
    // real ~23min run against a 600s (10min) configured timeout — the FEEDBACK case
    ['preflight', [420_000, 500_000, 1_380_000]],
    // comfortably under a 120s timeout
    ['lint', [8_000, 9_500, 10_200]],
  ]);

  const findings = doctorFindings(gates, history);
  assert.deepEqual(findings.map((f) => f.name), ['preflight']);
  assert.equal(findings[0].timeoutS, 600);
  assert.equal(findings[0].maxDurationMs, 1_380_000);
});

test('doctorFindings: gate with no history is silent (nothing to compare yet)', () => {
  const gates: Gate[] = [{ name: 'new-gate', run: 'x', timeout: 60 }];
  assert.deepEqual(doctorFindings(gates, new Map()), []);
});

test('doctorFindings: falls back to the runner default timeout when unset', () => {
  const gates: Gate[] = [{ name: 'no-timeout', run: 'x' }];
  const history = new Map<string, number[]>([['no-timeout', [590_000]]]); // 590s vs 600s default = 98%
  assert.equal(doctorFindings(gates, history).length, 1);
});

test('renderDoctor: clean line when nothing is flagged, one line per finding otherwise', () => {
  assert.match(renderDoctor([]), /no timeout drift/);
  const out = renderDoctor(doctorFindings(
    [{ name: 'preflight', run: 'x', timeout: 600 }],
    new Map([['preflight', [590_000]]]),
  ));
  assert.match(out, /preflight/);
  assert.match(out, /timeout 600s/);
});

test('renderDoctorJson: ok=false with findings, ok=true when clean', () => {
  const clean = JSON.parse(renderDoctorJson([])) as { ok: boolean; findings: unknown[] };
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.findings, []);

  const dirty = JSON.parse(renderDoctorJson(doctorFindings(
    [{ name: 'preflight', run: 'x', timeout: 600 }],
    new Map([['preflight', [590_000]]]),
  ))) as { ok: boolean; findings: unknown[] };
  assert.equal(dirty.ok, false);
  assert.equal(dirty.findings.length, 1);
});

test('gateDurationHistory: no last.json → empty map; corrupt json → empty map, no throw', () => {
  const dir = tmp('missing');
  assert.deepEqual(gateDurationHistory(dir), new Map());
  mkdirSync(join(dir, '.snuff'), { recursive: true });
  writeFileSync(join(dir, '.snuff', 'last.json'), '{not json');
  assert.deepEqual(gateDurationHistory(dir), new Map());
  rmSync(dir, { recursive: true, force: true });
});

test('gateDurationHistory: an old last.json without durationHistory degrades to no entry, not a crash', () => {
  const dir = tmp('old-shape');
  mkdirSync(join(dir, '.snuff'), { recursive: true });
  const oldShape = {
    ts: new Date().toISOString(),
    head: null,
    cwd: dir,
    ok: true,
    gates: [{ gate: { name: 'legacy', run: 'x' }, ok: true, skipped: null, exitCode: 0, timedOut: false, durationMs: 1234 }],
  };
  writeFileSync(join(dir, '.snuff', 'last.json'), JSON.stringify(oldShape));

  const history = gateDurationHistory(dir);
  assert.equal(history.has('legacy'), false);
  assert.deepEqual(doctorFindings([{ name: 'legacy', run: 'x', timeout: 1 }], history), []);
  rmSync(dir, { recursive: true, force: true });
});

test('saveLast: appends durationMs to durationHistory and caps it at DURATION_HISTORY_CAP', async () => {
  const dir = tmp('history-cap');
  for (let i = 0; i < 7; i++) {
    const results = await runAll([{ name: 'x', run: 'echo x' }], dir);
    saveLast(dir, results);
  }
  const history = gateDurationHistory(dir).get('x');
  assert.ok(history);
  assert.equal(history.length, 5);
  rmSync(dir, { recursive: true, force: true });
});

test('saveLast: a skipped run does not append (and does not zero-out) durationHistory', async () => {
  const dir = tmp('skip-preserves-history');
  const gates = [
    { name: 'a', run: 'echo ok' },
    { name: 'b', run: 'echo b', needs: ['a'] },
  ];
  const first = await runAll(gates, dir); // both run: b gets a real history entry
  saveLast(dir, first);

  const beforeSkip = gateDurationHistory(dir).get('b');
  assert.ok(beforeSkip && beforeSkip.length === 1);

  // second run: a fails → b is skipped ("needs a"), not re-run
  const second = await runAll([{ ...gates[0], run: 'exit 1' }, gates[1]], dir);
  saveLast(dir, second);
  assert.equal(second.find((r) => r.gate.name === 'b')?.skipped, 'needs a');

  const after = gateDurationHistory(dir).get('b');
  assert.deepEqual(after, beforeSkip);
  rmSync(dir, { recursive: true, force: true });
});

test('fixture: doctor end-to-end against a written last.json — near/over timeout flagged, headroom silent', () => {
  const dir = tmp('e2e-fixture');
  writeFixture(dir, [
    { name: 'preflight', timeout: 600, durationHistory: [610_000, 700_000, 1_380_000] },
    { name: 'unit', timeout: 300, durationHistory: [12_000, 15_000, 11_000] },
  ]);

  const raw = JSON.parse(readFileSync(join(dir, '.snuff', 'last.json'), 'utf8')) as {
    gates: Array<{ gate: { name: string; timeout?: number }; durationHistory: number[] }>;
  };
  const gates: Gate[] = raw.gates.map((g) => ({ name: g.gate.name, run: 'x', timeout: g.gate.timeout }));

  const findings = doctorFindings(gates, gateDurationHistory(dir));
  assert.deepEqual(findings.map((f) => f.name), ['preflight']);
  assert.match(renderDoctor(findings), /1 gate at risk/);
  rmSync(dir, { recursive: true, force: true });
});
