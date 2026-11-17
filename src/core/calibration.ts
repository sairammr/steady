// Calibration (PRD §7): orientation, amplitude, period, timing offset L, delivery delay D.
import { detect, prepare } from './detector.ts';
import { buildTrace, median, ofKind, quantile, type Cal, type Line, type PaceLine, type Sample } from './recording.ts';

/** Reference pacer waveform: 0 at rest, ramps up over "in", down over "out". */
export function paceRef(pace: PaceLine[], t: number): number | null {
  for (const p of pace) {
    if (t < p.t || t >= p.t + p.dur) continue;
    const f = (t - p.t) / p.dur;
    return p.phase === 'in' ? f : p.phase === 'out' ? 1 - f : 0;
  }
  return null;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Best (sign, lag) correlating the trace with the pacer over 0–3 s lags, optionally one cycle only. */
export function orientAndLag(samples: Sample[], pace: PaceLine[], step = 50, fixedOrient?: 1 | -1): { orient: 1 | -1; lag: number; r: number } {
  let best = { orient: 1 as 1 | -1, lag: 0, r: 0 };
  for (let lag = 0; lag <= 3000; lag += step) {
    const a: number[] = [], b: number[] = [];
    for (const s of samples) {
      const r = paceRef(pace, s.t - lag);
      if (r !== null) { a.push(s.v); b.push(r); }
    }
    const r = pearson(a, b);
    const score = fixedOrient ? r * fixedOrient : Math.abs(r);
    if (score > (fixedOrient ? best.r * fixedOrient : Math.abs(best.r))) best = { orient: fixedOrient ?? (r >= 0 ? 1 : -1), lag, r };
  }
  return best;
}

/**
 * Per paced cycle (in/out/rest), the lag that best aligns the trace with the pacer.
 * Correlation over the whole cycle is used instead of an onset threshold: a threshold crossing
 * lags by an amount that depends on inhale speed (≈0.8 s on a 4 s paced inhale), cross-correlation
 * against a symmetric ramp does not.
 */
export function cycleLags(samples: Sample[], pace: PaceLine[], orient: 1 | -1): number[] {
  const out: number[] = [];
  for (let i = 0; i < pace.length; i++) {
    if (pace[i].phase !== 'in') continue;
    const cycle = pace.slice(i, i + 3);
    const end = cycle[cycle.length - 1].t + cycle[cycle.length - 1].dur + 3000;
    const win = samples.filter((s) => s.t >= pace[i].t && s.t < end);
    const { lag, r } = orientAndLag(win, cycle, 10, orient);
    if (r * orient > 0.5) out.push(lag);
  }
  return out;
}

/**
 * Clock map and delivery delay from (arrival wall-clock − sample timestamp), first delivery of each sample.
 * The SDK anchors sample time to wall clock with an unknown offset (D1: samples ran ~413 ms AHEAD of
 * arrival), so arrival − t is NOT a delay. `clock_ms` (median) / `clock_p95_ms` map wall clock ↔ sample
 * clock (sample t ≈ wall − clock_ms). D is only the part we can see: delivery jitter above the fastest
 * sample (median − min, p95 − min), a lower bound. Absolute sensor delay is folded into L (paced cycles).
 */
export function deliveryDelay(lines: Line[]): { D_ms: number; D_p95_ms: number; clock_ms: number; clock_p95_ms: number } {
  const seen = new Set<number>();
  const d: number[] = [];
  for (const m of ofKind(lines, 'm')) for (const s of m.upper) {
    if (seen.has(s.t)) continue;
    seen.add(s.t);
    d.push(m.t_arr - s.t);
  }
  const min = d.reduce((a, b) => Math.min(a, b), Infinity);
  const med = median(d), p95 = quantile(d, 0.95);
  return { D_ms: Math.round(med - min), D_p95_ms: Math.round(p95 - min), clock_ms: Math.round(med), clock_p95_ms: Math.round(p95) };
}

/**
 * Which extreme is the pause, from dwell asymmetry: breathing spends longer near the end-of-exhale
 * extreme than near the top. Returns +1 if the raw trace dwells at its bottom, and the dwell ratio.
 */
export function orientByDwell(samples: Sample[]): { orient: 1 | -1; ratio: number } {
  const pts = prepare(samples, { orient: 1, A: 0, period_ms: 6000 });
  let bottom = 0, top = 0;
  for (const p of pts) {
    const f = p.A > 0 ? (p.x - p.trough) / p.A : 0.5;
    if (f < 0.25) bottom++; else if (f > 0.75) top++;
  }
  const ratio = Math.max(bottom, top) / Math.max(1, Math.min(bottom, top));
  return { orient: bottom >= top ? 1 : -1, ratio: round4(ratio) };
}

/**
 * Orientation: dwell asymmetry on natural breathing vs the pacer correlation. The pacer wins only
 * when it is strong (|r| ≥ 0.6, lag not at the search edge) and dwell is weak (ratio < 1.5).
 */
export function chooseOrient(dwell: { orient: 1 | -1; ratio: number }, paced: { orient: 1 | -1; r: number; lag: number } | null): { orient: 1 | -1; by: string } {
  if (!paced) return { orient: dwell.orient, by: `dwell ${dwell.ratio}` };
  if (paced.orient === dwell.orient) return { orient: dwell.orient, by: `dwell ${dwell.ratio} + paced r ${round2(paced.r)}` };
  const pacedStrong = Math.abs(paced.r) >= 0.6 && paced.lag < 3000;
  if (pacedStrong && dwell.ratio < 1.5) return { orient: paced.orient, by: `paced r ${round2(paced.r)} (dwell ${dwell.ratio} disagrees, weak)` };
  if (dwell.ratio >= 1.2 || !pacedStrong) return { orient: dwell.orient, by: `dwell ${dwell.ratio} (paced r ${round2(paced.r)} disagrees, weak)` };
  return { orient: paced.orient, by: `paced r ${round2(paced.r)}` };
}

export type CalResult = Cal & { lags: number[]; r: number };

/** Inhale onsets matched to scheduled inhale starts: returns per-cycle (onset − scheduled). */
export function onsetLags(onsets: number[], pace: PaceLine[], around: number, tol = 2000): number[] {
  const out: number[] = [];
  for (const p of pace) {
    if (p.phase !== 'in') continue;
    const c = onsets.filter((o) => Math.abs(o - (p.t + around)) <= tol);
    if (!c.length) continue;
    const best = c.reduce((u, v) => (Math.abs(v - p.t - around) < Math.abs(u - p.t - around) ? v : u));
    out.push(best - p.t);
  }
  return out;
}

export function estimateCalibration(lines: Line[]): CalResult {
  const { samples } = buildTrace(lines);
  const pace = ofKind(lines, 'pace');
  if (!pace.length) throw new Error('no paced cycles in recording');
  const natural = samples.filter((s) => s.t < pace[0].t);
  const paced = orientAndLag(samples, pace);
  const { orient, by: orient_by } = chooseOrient(orientByDwell(natural.length > 600 ? natural : samples), paced);
  const { lag, r } = orient === paced.orient ? paced : orientAndLag(samples, pace, 50, orient);
  const { D_ms, D_p95_ms, clock_ms, clock_p95_ms } = deliveryDelay(lines);

  // Amplitude: median per-cycle range of the smoothed, oriented trace over each paced cycle.
  const roughPts = prepare(samples, { orient, A: 1, period_ms: 10000 });
  const ranges: number[] = [];
  for (const p of pace) {
    if (p.phase !== 'in') continue;
    const xs = roughPts.filter((q) => q.t >= p.t + lag && q.t < p.t + lag + 10000).map((q) => q.x);
    if (xs.length > 10) ranges.push(Math.max(...xs) - Math.min(...xs));
  }
  const A = median(ranges) || 1;

  // Period from natural breathing outside the paced block (trough-to-trough), else a default.
  const paceStart = pace[0].t, paceEnd = pace[pace.length - 1].t + pace[pace.length - 1].dur + lag;
  const det = detect(samples, { orient, A, period_ms: 6000 });
  const nat = det.troughs.filter((t) => t < paceStart || t > paceEnd);
  const periods = nat.slice(1).map((t, i) => t - nat[i]).filter((p) => p > 1500 && p < 15000);
  const period_ms = Math.round(periods.length >= 2 ? median(periods) : 5000);

  const lags = cycleLags(samples, pace, orient);
  const L = lags.length ? median(lags) : lag;
  const spread = lags.length ? median(lags.map((v) => Math.abs(v - L))) : NaN;
  return {
    orient, orient_by, A: round4(A), period_ms, L_ms: Math.round(L), L_spread_ms: Math.round(spread),
    D_ms, D_p95_ms, clock_ms, clock_p95_ms, lags: lags.map(Math.round), r: round4(r),
  };
}

/** Median (detected inhale onset − scheduled inhale start) over a recording's paced cycles. */
export function onsetOffset(lines: Line[], cal: Cal): number {
  const det = detect(buildTrace(lines).samples, cal);
  return median(onsetLags(det.onsets, ofKind(lines, 'pace'), cal.L_ms + 800, 2000));
}

/**
 * Detector agreement (PRD §12) on a held-out recording: fraction of its paced inhales whose detected
 * onset, corrected by the onset offset measured on a *different* (calibration) recording, lands
 * within ±tol of the scheduled start. Onset-vs-onset, so the threshold bias cancels.
 */
export function agreement(heldOut: Line[], cal: Cal, onsetOffsetMs: number, tol = 500): { hits: number; n: number } {
  const det = detect(buildTrace(heldOut).samples, cal);
  const pace = ofKind(heldOut, 'pace');
  const lags = onsetLags(det.onsets, pace, onsetOffsetMs, 2000);
  const n = pace.filter((p) => p.phase === 'in').length;
  return { hits: lags.filter((l) => Math.abs(l - onsetOffsetMs) <= tol).length, n };
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** The recording's calibration: meta.cal if written live, else estimated from its paced cycles. */
export function calibrationFor(lines: Line[]): Cal {
  const meta = ofKind(lines, 'meta')[0];
  if (meta?.cal) return meta.cal;
  const { lags: _l, r: _r, ...c } = estimateCalibration(lines);
  return c;
}
