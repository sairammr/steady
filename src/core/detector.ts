// Pause detector (PRD §6). Pure: same function live (over the buffer so far) and post-round.
import { inIntervals, type Interval, type LiveState, type Sample } from './recording.ts';

export type DetectOpts = {
  smoothMs: number;     // centred moving-average width
  slopeMs: number;      // half-width for the slope estimate
  k: number;            // flat threshold: |slope| < k·A per second
  minFlatMs: number;    // flat for this long before a pause opens
  levelFrac: number;    // must be within the bottom levelFrac of A
  maxPauseMs: number;   // pause closes after this ("breathe again")
  maxGapMs: number;     // sample gap that counts as signal loss
  requireStable: boolean;
};
// ponytail: thresholds are first guesses tuned on synthetic data; retune on D1 recordings.
export const DEFAULT_OPTS: DetectOpts = {
  smoothMs: 200, slopeMs: 150, k: 0.15, minFlatMs: 300, levelFrac: 0.3,
  maxPauseMs: 5000, maxGapMs: 500, requireStable: true,
};

export type BreathModel = { orient: 1 | -1; A: number; period_ms: number };
export type Pt = { t: number; x: number; slope: number; trough: number; A: number; ok: boolean };
export type Pause = { start: number; end: number; closedBy: 'inhale' | 'timeout' | 'unknown' | 'end' };
export type Detection = { pts: Pt[]; pauses: Pause[]; onsets: number[]; troughs: number[] };

/** Oriented (inhale = up), smoothed trace with slope and a trailing 2-cycle min/max breath model. */
export function prepare(samples: Sample[], cal: BreathModel, unknown: Interval[] = [],
  opts: DetectOpts = DEFAULT_OPTS): Pt[] {
  const n = samples.length;
  const t = samples.map((s) => s.t);
  const raw = samples.map((s) => cal.orient * s.v);
  // centred moving average (two pointers)
  const x = new Array<number>(n);
  let lo = 0, hi = 0, sum = 0;
  const h = opts.smoothMs / 2;
  for (let i = 0; i < n; i++) {
    while (hi < n && t[hi] <= t[i] + h) sum += raw[hi++];
    while (t[lo] < t[i] - h) sum -= raw[lo++];
    x[i] = sum / (hi - lo);
  }
  // slope per second over ±slopeMs
  const slope = new Array<number>(n);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    while (t[a] < t[i] - opts.slopeMs) a++;
    while (b + 1 < n && t[b + 1] <= t[i] + opts.slopeMs) b++;
    slope[i] = t[b] > t[a] ? ((x[b] - x[a]) / (t[b] - t[a])) * 1000 : 0;
  }
  // trailing rolling min/max over 2 breath periods (monotonic deques)
  const win = 2 * cal.period_ms;
  const minQ: number[] = [], maxQ: number[] = [];
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    while (minQ.length && x[minQ[minQ.length - 1]] >= x[i]) minQ.pop();
    minQ.push(i);
    while (maxQ.length && x[maxQ[maxQ.length - 1]] <= x[i]) maxQ.pop();
    maxQ.push(i);
    while (t[minQ[0]] < t[i] - win) minQ.shift();
    while (t[maxQ[0]] < t[i] - win) maxQ.shift();
    const trough = x[minQ[0]];
    const localA = x[maxQ[0]] - trough;
    // Early in a buffer or during a hold the window is flat: fall back to calibrated amplitude.
    const A = localA < 0.5 * cal.A ? cal.A : localA;
    const gap = i > 0 && t[i] - t[i - 1] > opts.maxGapMs;
    const ok = (!opts.requireStable || samples[i].s) && !gap && !inIntervals(t[i], unknown);
    pts.push({ t: t[i], x: x[i], slope: slope[i], trough, A, ok });
  }
  return pts;
}

export function detect(samples: Sample[], cal: BreathModel, unknown: Interval[] = [],
  opts: DetectOpts = DEFAULT_OPTS): Detection {
  const pts = prepare(samples, cal, unknown, opts);
  const pauses: Pause[] = [];
  let open: number | null = null;
  let sawFalling = false;
  let flatStart: number | null = null;
  let prevT = pts[0]?.t ?? 0;
  const close = (end: number, closedBy: Pause['closedBy']) => {
    pauses.push({ start: open!, end, closedBy });
    open = null;
  };
  for (const p of pts) {
    const thr = opts.k * p.A;
    if (!p.ok) {
      if (open !== null) close(prevT, 'unknown');
      flatStart = null; sawFalling = false; prevT = p.t;
      continue;
    }
    if (open !== null) {
      if (p.slope > thr) close(p.t, 'inhale');
      else if (p.t - open >= opts.maxPauseMs) { close(open + opts.maxPauseMs, 'timeout'); sawFalling = false; }
      prevT = p.t;
      continue;
    }
    if (p.slope < -thr) { sawFalling = true; flatStart = null; }
    else if (p.slope > thr) { sawFalling = false; flatStart = null; }
    else if (sawFalling && p.x - p.trough <= opts.levelFrac * p.A) {
      flatStart ??= p.t;
      if (p.t - flatStart >= opts.minFlatMs) { open = p.t; sawFalling = false; flatStart = null; }
    } else flatStart = null;
    prevT = p.t;
  }
  if (open !== null) close(prevT, 'end');

  // Inhale onsets and troughs by hysteresis (±50% A), onset = first crossing of trough + 10% A.
  const onsets: number[] = [], troughs: number[] = [];
  let seekingTrough = true;
  let ext = 0; // index of running min (seeking trough) or max (seeking peak)
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p.ok) { seekingTrough = true; ext = i; continue; }
    if (seekingTrough) {
      if (p.x < pts[ext].x || !pts[ext].ok) ext = i;
      else if (p.x > pts[ext].x + 0.5 * p.A) {
        troughs.push(pts[ext].t);
        let j = ext;
        while (j < i && pts[j].x < pts[ext].x + 0.1 * p.A) j++;
        onsets.push(pts[j].t);
        seekingTrough = false; ext = i;
      }
    } else if (p.x > pts[ext].x) ext = i;
    else if (p.x < pts[ext].x - 0.5 * p.A) { seekingTrough = true; ext = i; }
  }
  return { pts, pauses, onsets, troughs };
}

/** State at sample time t. Beyond the trace, in a gap, unstable or talking → unknown. */
export function classifyAt(t: number, det: Detection, opts: DetectOpts = DEFAULT_OPTS): LiveState {
  const p = nearest(det.pts, t);
  if (!p || Math.abs(p.t - t) > opts.maxGapMs / 2 || !p.ok) return 'unknown';
  return pauseAt(det.pauses, t) ? 'pause' : 'breath';
}

export const pauseAt = (pauses: Pause[], t: number) => pauses.find((w) => t >= w.start && t < w.end);

export function nearest<T extends { t: number }>(arr: T[], t: number): T | undefined {
  if (!arr.length) return undefined;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1].t - t) <= Math.abs(arr[lo].t - t)) lo--;
  return arr[lo];
}

/** Linear interpolation of the breath model at t (for sway rendering). */
export function modelAt(pts: Pt[], t: number): { x: number; trough: number; A: number } | null {
  if (!pts.length || t < pts[0].t || t > pts[pts.length - 1].t) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const lerp = (u: number, v: number) => u + (v - u) * f;
  return { x: lerp(a.x, b.x), trough: lerp(a.trough, b.trough), A: lerp(a.A, b.A) };
}
