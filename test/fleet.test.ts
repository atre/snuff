import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listManifests, runFleet } from '../src/fleet.js';
import { renderFleet, renderFleetJson } from '../src/render.js';

function fleetRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'snuff-fleet-'));
  mkdirSync(join(root, 'ok'));
  writeFileSync(join(root, 'ok', 'snuff.yaml'), 'gates:\n  - name: check\n    run: echo ok\n');
  mkdirSync(join(root, 'bad'));
  writeFileSync(join(root, 'bad', 'snuff.yaml'), 'gates:\n  - name: check\n    run: exit 1\n');
  return root;
}

test('listManifests: only direct child dirs with a manifest, alphabetically sorted', () => {
  const root = fleetRoot();
  mkdirSync(join(root, 'nomanifest'));
  const names = listManifests(root).map((d) => d.split('/').pop());
  assert.deepEqual(names, ['bad', 'ok']);
  rmSync(root, { recursive: true, force: true });
});

test('runFleet: runs each repo, reports ok/red correctly', async () => {
  const root = fleetRoot();
  const repos = await runFleet(root);
  assert.equal(repos.length, 2);
  const byName = Object.fromEntries(repos.map((r) => [r.name, r]));
  assert.equal(byName.ok.ok, true);
  assert.equal(byName.bad.ok, false);
  rmSync(root, { recursive: true, force: true });
});

test('renderFleet: first line matches a red repo, footer has the red count', async () => {
  const root = fleetRoot();
  const repos = await runFleet(root);
  const text = renderFleet(repos);
  const lines = text.split('\n');
  assert.match(lines[0], /^✗ bad/);
  assert.ok(text.includes('1 red'));
  rmSync(root, { recursive: true, force: true });
});

test('runFleet: an unparseable manifest is reported as an errored entry, not thrown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snuff-fleet-broken-'));
  mkdirSync(join(root, 'broken'));
  writeFileSync(join(root, 'broken', 'snuff.yaml'), 'gates:\n  - name: a\n    needs: [nope]\n    run: x\n');
  mkdirSync(join(root, 'fine'));
  writeFileSync(join(root, 'fine', 'snuff.yaml'), 'gates:\n  - name: check\n    run: echo hi\n');

  const repos = await runFleet(root);
  const byName = Object.fromEntries(repos.map((r) => [r.name, r]));
  assert.equal(byName.broken.ok, false);
  assert.ok(byName.broken.error);
  assert.equal(byName.fine.ok, true);
  rmSync(root, { recursive: true, force: true });
});

test('renderFleetJson: repos[].gates matches the same shape single-repo --json uses', async () => {
  const root = fleetRoot();
  const repos = await runFleet(root);
  const json = renderFleetJson(repos) as { repos: Array<{ name: string; ok: boolean; gates: unknown[] }> };
  assert.equal(json.repos.length, 2);
  const bad = json.repos.find((r) => r.name === 'bad')!;
  assert.equal(bad.ok, false);
  assert.equal(bad.gates.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('renderFleet/renderFleetJson: an errored repo renders `✗ name — <error first line>` and an error key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snuff-fleet-err-'));
  mkdirSync(join(root, 'broken'));
  writeFileSync(join(root, 'broken', 'snuff.yaml'), 'gates:\n  - name: a\n    needs: [nope]\n    run: x\n');
  const repos = await runFleet(root);
  const text = renderFleet(repos);
  const [line, footer] = text.split('\n');
  assert.match(line, /^✗ broken — .+/);
  assert.doesNotMatch(line, /\n/);
  assert.doesNotMatch(text, /stale/);
  assert.equal(footer, '1 red · 1 broken');
  const json = renderFleetJson(repos) as { ok: boolean; repos: Array<{ error?: string; dir: string }> };
  assert.equal(json.ok, false);
  assert.ok(json.repos[0].error);
  assert.ok(isAbsolute(json.repos[0].dir));
  rmSync(root, { recursive: true, force: true });
});

test('runFleet: writes an absolute cwd into each repo last.json, even from a relative root', async () => {
  const root = fleetRoot();
  const rel = relative(process.cwd(), root);
  await runFleet(rel);
  const last = JSON.parse(readFileSync(join(root, 'ok', '.snuff', 'last.json'), 'utf8')) as { cwd: string };
  assert.ok(isAbsolute(last.cwd), `cwd must be absolute, got ${last.cwd}`);
  rmSync(root, { recursive: true, force: true });
});

test('runFleet: nonexistent root throws `--all: no such dir <p>`', async () => {
  await assert.rejects(runFleet('/definitely/not/here'), /--all: no such dir \/definitely\/not\/here/);
});

test('runFleet: forwards --tag/--changed/--fail-fast per repo; untagged repos are `–`, not red', async () => {
  const root = mkdtempSync(join(tmpdir(), 'snuff-fleet-fwd-'));
  mkdirSync(join(root, 'tagged'));
  writeFileSync(
    join(root, 'tagged', 'snuff.yaml'),
    'gates:\n  - name: fast\n    run: echo fast\n    tags: [fast]\n  - name: slow\n    run: exit 1\n',
  );
  mkdirSync(join(root, 'plain'));
  writeFileSync(join(root, 'plain', 'snuff.yaml'), 'gates:\n  - name: check\n    run: exit 1\n');

  const repos = await runFleet(root, { tags: ['fast'] });
  const byName = Object.fromEntries(repos.map((r) => [r.name, r]));
  assert.deepEqual(byName.tagged.gates.map((g) => g.gate.name), ['fast']);
  assert.equal(byName.tagged.ok, true);
  assert.equal(byName.plain.ok, true);
  assert.equal(byName.plain.skipped, 'no gates tagged fast');
  assert.match(renderFleet(repos), /^– plain  no gates tagged fast$/m);

  // --changed inside a non-git dir → the repo's error, others still run
  const changed = await runFleet(root, { changed: true });
  assert.ok(changed.every((r) => r.error?.includes('--changed needs git')));

  // --fail-fast: second gate never launches after the first hard failure
  writeFileSync(
    join(root, 'plain', 'snuff.yaml'),
    'gates:\n  - name: a\n    run: exit 1\n  - name: b\n    run: echo b\n    needs: [a]\n',
  );
  const ff = await runFleet(root, { failFast: true });
  const plain = ff.find((r) => r.name === 'plain')!;
  assert.equal(plain.gates.find((g) => g.gate.name === 'b')?.skipped !== undefined, true);
  rmSync(root, { recursive: true, force: true });
});
