// The first REAL recording (D1 spike, 2026-11-17): 60 s normal breathing, 3 × 5 s holds, 20 s counting
// aloud, 3 paced cycles. Numeric breathing/pulse/talking data only. Tolerances, not exact counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationFor } from '../src/core/calibration.ts';
import { classifyAt, detect } from '../src/core/detector.ts';
import { buildTrace, ofKind, unknownIntervals } from '../src/core/recording.ts';
import { scoreRecording } from '../src/core/scoring.ts';
import { summarizeSpike } from '../src/core/spike.ts';
import { breathOffset, MAX_OFFSET_PX } from '../src/core/sway.ts';
import { fixture } from './helpers.ts';

const lines = fixture('real-spike-1');
const cal = calibrationFor(lines);
const { samples } = buildTrace(lines);
const unknown = unknownIntervals(lines, cal.clock_ms);
const det = detect(samples, cal, unknown);
const mark = (name: string) => ofKind(lines, 'mark').find((m) => m.name === name)!.t - cal.clock_ms; // → sample clock

test('REAL: orientation by dwell (pause at the bottom), clock ≈ −413 ms, small jitter D', () => {
  assert.equal(cal.orient, 1);
  assert.match(cal.orient_by, /^dwell/);
  assert.ok(Math.abs(cal.clock_ms + 413) < 30, `clock ${cal.clock_ms}`);
  assert.ok(cal.D_ms >= 0 && cal.D_ms < 100 && cal.D_p95_ms < 400, `D ${cal.D_ms}/${cal.D_p95_ms}`);
});

test('REAL: about one pause per breath in the normal segment, opening on the exhale plateau', () => {
  const [a, b] = [mark('normal_start'), mark('normal_end')];
  const inNormal = det.pauses.filter((w) => w.start >= a && w.start < b);
  assert.ok(inNormal.length >= 7 && inNormal.length <= 12, `${inNormal.length} pauses in 60 s`);
  // every valid trough in the segment is followed by a pause within 1.5 s (≥ 70%)
  const troughs = det.troughs.filter((t) => t >= a && t < b && classifyAt(t, det) !== 'unknown');
  const hit = troughs.filter((t) => det.pauses.some((w) => w.end > t - 500 && w.start < t + 1500));
  assert.ok(hit.length / troughs.length >= 0.7, `${hit.length}/${troughs.length} troughs get a pause`);
  // and no pause opens high in the breath (top of inhale)
  for (const w of det.pauses) {
    const p = det.pts.find((q) => q.t >= w.start)!;
    assert.ok((p.x - p.trough) / p.A <= 0.35 + 1e-9, `pause at ${w.start} opens at level ${((p.x - p.trough) / p.A).toFixed(2)}`);
  }
});

test('REAL: every talking-flagged event is unknown; holds detectable; verdict GO', () => {
  for (const m of ofKind(lines, 'm').filter((x) => x.talking)) {
    assert.equal(classifyAt(m.t_arr - cal.clock_ms, det), 'unknown', `talking at ${m.t_arr}`);
  }
  const s = summarizeSpike(lines);
  assert.equal(s.holds.length, 3);
  for (const h of s.holds) assert.ok(h.flat_frac >= 0.7, `hold flat ${h.flat_frac}`);
  assert.equal(s.verdict, 'go');
});

test('REAL: position sway ≈ 0 in pause plateaus, large mid-breath', () => {
  const dy = (p: (typeof det.pts)[number]) => Math.abs(breathOffset(p.x, p.trough, p.A)[1]);
  const med = (xs: number[]) => [...xs].sort((u, v) => u - v)[xs.length >> 1];
  const inPause = det.pts.filter((p) => p.ok && det.pauses.some((w) => p.t >= w.start && p.t < w.end));
  const midBreath = det.pts.filter((p) => p.ok && Math.abs(p.slope) > 0.5 * p.A);
  assert.ok(med(inPause.map(dy)) < 0.05 * MAX_OFFSET_PX, `pause sway ${med(inPause.map(dy))}`);
  assert.ok(med(midBreath.map(dy)) > 0.35 * MAX_OFFSET_PX, `mid-breath sway ${med(midBreath.map(dy))}`);
});

test('REAL: replay is deterministic', () => {
  const run = () => JSON.stringify(scoreRecording(lines, 'real-spike-1.jsonl').session);
  assert.equal(run(), run());
});
