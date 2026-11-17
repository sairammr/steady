import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { MULT, scoreRecording } from '../src/core/scoring.ts';
import { ofKind, TALK_HOLDOFF_MS } from '../src/core/recording.ts';
import { FIXTURES, synthesize } from '../src/core/synth.ts';
import { fixture } from './helpers.ts';

test('final post-round states match synthetic ground truth on the clean recording', () => {
  const { detail } = scoreRecording(fixture('synthetic-clean'), 'synthetic-clean.jsonl');
  const agree = detail.shots.filter((s) => s.state === s.live_state).length;
  assert.ok(agree / detail.shots.length >= 0.9, `${agree}/${detail.shots.length}`);
  for (const s of detail.shots) {
    const m = MULT[s.state];
    assert.equal(s.score, m === null ? null : Math.round(s.accuracy * m));
  }
});

test('talking greys every shot inside the talking span + 2 s hold-off', () => {
  const o = FIXTURES['synthetic-talking'];
  const { truth } = synthesize(o);
  const { detail, session } = scoreRecording(fixture('synthetic-talking'), 'synthetic-talking.jsonl');
  const [a, b] = truth.talk[0];
  const inside = detail.shots.filter((s) => s.t >= a && s.t <= b + TALK_HOLDOFF_MS);
  assert.ok(inside.length >= 1, 'fixture has shots in the talking span');
  for (const s of inside) assert.equal(s.state, 'unknown', `shot at ${s.t - a} ms into talking`);
  assert.equal(session.guided.n_grey, inside.length);
  const outside = detail.shots.filter((s) => s.t < a - 500 || s.t > b + TALK_HOLDOFF_MS + 1500);
  assert.ok(outside.every((s) => s.state !== 'unknown'));
});

test('session has Guided and No-HUD figures and one insight', () => {
  const { session } = scoreRecording(fixture('synthetic-clean'), 'synthetic-clean.jsonl');
  assert.equal(session.synthetic, true);
  assert.ok(session.guided.n > 0 && session.nohud.n > 0);
  assert.ok(session.guided.pct_pause! > session.nohud.pct_pause!);
  assert.ok(session.insight.text.length > 10);
  assert.equal(ofKind(fixture('synthetic-clean'), 'round').length, 2);
});

test('replaying a recording twice yields byte-identical session.json and report', () => {
  const run = () => execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'src/cli/replay.ts', 'test/fixtures/synthetic-talking.jsonl'], { encoding: 'utf8' });
  const a = run(), b = run();
  assert.equal(a, b);
  assert.match(a, /SYNTHETIC TEST DATA/);
  const s1 = JSON.stringify(scoreRecording(fixture('synthetic-slow'), 'x').session);
  const s2 = JSON.stringify(scoreRecording(fixture('synthetic-slow'), 'x').session);
  assert.equal(s1, s2);
});

test('fixtures on disk are exactly what the seeded generator produces', () => {
  for (const [name, opts] of Object.entries(FIXTURES)) {
    assert.deepEqual(fixture(name), JSON.parse(JSON.stringify(synthesize(opts).lines)), name);
  }
});
