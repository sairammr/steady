import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAt, detect } from '../src/core/detector.ts';
import { simpleTrace } from './helpers.ts';

const cal = { orient: 1 as const, A: 1, period_ms: 6200 };

test('finds every natural pause (synthetic) and never opens at the top of an inhale', () => {
  const { samples, pauses, peaks } = simpleTrace(10);
  const det = detect(samples, cal);
  // the first cycle has no prior exhale; every pause after an exhale must be found
  for (const [a, b] of pauses) {
    const mid = (a + b) / 2 + 300;
    assert.equal(classifyAt(mid, det), 'pause', `pause around ${mid}`);
  }
  for (const p of peaks) assert.equal(classifyAt(p, det), 'breath', `peak at ${p}`);
});

test('pause opens near the end of the exhale and closes when the inhale starts', () => {
  const { samples, pauses } = simpleTrace(5);
  const det = detect(samples, cal);
  for (const w of det.pauses) {
    // the last few hundred ms of a cosine exhale are already flat, so opening slightly early is right
    const truth = pauses.find(([a, b]) => w.start >= a - 500 && w.start <= b)!;
    assert.ok(truth, 'window inside a true pause');
    assert.ok(w.start - truth[0] <= 700, `opens promptly (${w.start - truth[0]} ms)`);
    assert.ok(Math.abs(w.end - truth[1]) < 500, `closes near inhale start (${w.end} vs ${truth[1]})`);
    assert.equal(w.closedBy === 'inhale' || w.closedBy === 'end', true);
  }
});

test('a long hold closes the pause at 5 s ("breathe again")', () => {
  const { samples, pauses } = simpleTrace(4, { holdAfter: 2, holdMs: 9000 });
  const det = detect(samples, cal);
  const hold = pauses[2];
  const w = det.pauses.find((p) => p.start >= hold[0] && p.start < hold[1])!;
  assert.equal(w.closedBy, 'timeout');
  assert.ok(Math.abs(w.end - w.start - 5000) < 1);
  assert.equal(classifyAt(hold[0] + 7000, det), 'breath');
});

test('talking interval, unstable samples and gaps are unknown', () => {
  const { samples, pauses } = simpleTrace(6);
  const [a, b] = pauses[3];
  const det = detect(samples, cal, [[a - 100, b + 100]]);
  assert.equal(classifyAt((a + b) / 2, det), 'unknown');
  const unstable = samples.map((s) => ({ ...s, s: s.t < 5000 ? false : s.s }));
  assert.equal(classifyAt(1000, detect(unstable, cal)), 'unknown');
  const gappy = samples.filter((s) => s.t < 10000 || s.t > 11000);
  assert.equal(classifyAt(10500, detect(gappy, cal)), 'unknown');
  assert.equal(classifyAt(samples.at(-1)!.t + 2000, det), 'unknown', 'beyond the trace');
});

test('orientation flip is handled by cal.orient', () => {
  const { samples, pauses } = simpleTrace(6);
  const flipped = samples.map((s) => ({ ...s, v: 5 - 2 * s.v }));
  const det = detect(flipped, { orient: -1, A: 2, period_ms: 6200 });
  const [a, b] = pauses[3];
  assert.equal(classifyAt((a + b) / 2 + 300, det), 'pause');
});

test('live (prefix) detection agrees with post-round detection for closed windows', () => {
  const { samples } = simpleTrace(8);
  const full = detect(samples, cal);
  const prefix = detect(samples.filter((s) => s.t < 20000), cal);
  for (const w of prefix.pauses.filter((p) => p.closedBy !== 'end')) {
    assert.ok(full.pauses.some((f) => f.start === w.start && f.end === w.end));
  }
});
