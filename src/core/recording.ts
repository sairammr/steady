// Recording format (PRD §11), parsing, trace assembly and the streaming recorder.
// All times are ms. Sample `t` is the SDK Measurement.timestamp (µs since epoch, anchored to
// wall clock by the SDK's FrameTimestampAnchor) divided by 1000.

export type Sample = { t: number; v: number; s: boolean };
export type Cal = {
  orient: 1 | -1; orient_by: string; A: number; period_ms: number;
  L_ms: number; L_spread_ms: number;
  D_ms: number; D_p95_ms: number;        // delivery jitter above the fastest sample (lower bound on delay)
  clock_ms: number; clock_p95_ms: number; // arrival − sample t: maps wall clock → sample clock (t ≈ wall − clock_ms)
};
export type RoundType = 'guided' | 'nohud';
export type LiveState = 'pause' | 'breath' | 'unknown';

export type MetaLine = {
  k: 'meta'; v: 1; sdk: string; t0_wall: number; sdk_time_unit: 'ms'; cal: Cal | null;
  synthetic?: boolean; note?: string;
};
export type MLine = {
  k: 'm'; t_arr: number; upper: Sample[]; rate: number | null; pulse: number | null;
  talking: boolean; valid: boolean;
};
export type ShotLine = {
  k: 'shot'; t: number; round: RoundType; t_target: number; target: [number, number];
  mouse: [number, number]; offset: [number, number]; impact: [number, number];
  t_disp: number; accuracy: number; live_state: LiveState;
};
export type RoundLine = { k: 'round'; type: RoundType; t_start: number; t_end: number };
export type PaceLine = { k: 'pace'; phase: 'in' | 'out' | 'rest'; t: number; dur: number };
export type MarkLine = { k: 'mark'; name: string; t: number; detail?: string };
export type Line = MetaLine | MLine | ShotLine | RoundLine | PaceLine | MarkLine;

export function parseJsonl(text: string): Line[] {
  const out: Line[] = [];
  text.split('\n').forEach((raw, i) => {
    const s = raw.trim();
    if (!s) return;
    let o: unknown;
    try { o = JSON.parse(s); } catch { throw new Error(`line ${i + 1}: invalid JSON`); }
    if (!o || typeof o !== 'object' || typeof (o as { k?: unknown }).k !== 'string') {
      throw new Error(`line ${i + 1}: missing "k"`);
    }
    out.push(o as Line);
  });
  return out;
}

export const toJsonl = (lines: Line[]) => lines.map((l) => JSON.stringify(l) + '\n').join('');

export const ofKind = <K extends Line['k']>(lines: Line[], k: K) =>
  lines.filter((l): l is Extract<Line, { k: K }> => l.k === k);

/** Final trace: one sample per timestamp, the latest delivery wins (handles revisions). */
export function buildTrace(lines: Line[]): { samples: Sample[]; revisions: number; stableFlips: number } {
  const byT = new Map<number, Sample>();
  let revisions = 0, stableFlips = 0;
  for (const m of ofKind(lines, 'm')) {
    for (const s of m.upper) {
      const prev = byT.get(s.t);
      if (prev) {
        revisions++;
        if (!prev.s && s.s) stableFlips++;
      }
      byT.set(s.t, s);
    }
  }
  const samples = [...byT.values()].sort((a, b) => a.t - b.t);
  return { samples, revisions, stableFlips };
}

export type Interval = [number, number];
export const TALK_HOLDOFF_MS = 2000;

/**
 * Intervals (sample time) where scoring is suspended: SDK invalid or talking (+2 s hold-off).
 * An event covers arrival span (prev t_arr, t_arr], mapped to sample clock by clock_ms (Cal).
 */
export function unknownIntervals(lines: Line[], clock_ms: number): Interval[] {
  const ms = ofKind(lines, 'm');
  const raw: Interval[] = [];
  ms.forEach((m, i) => {
    if (m.valid && !m.talking) return;
    const start = (i > 0 ? ms[i - 1].t_arr : m.t_arr - 1000) - clock_ms;
    const end = m.t_arr - clock_ms + (m.talking ? TALK_HOLDOFF_MS : 0);
    raw.push([start, end]);
  });
  raw.sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

export const inIntervals = (t: number, ivs: Interval[]) => ivs.some(([a, b]) => t >= a && t <= b);

/**
 * Streams lines to a sink. Lines pushed before begin(meta) are buffered, so the meta line
 * (which carries calibration) is always first in the file even though calibration runs first.
 */
export class Recorder {
  private buf: Line[] = [];
  private started = false;
  private sink: (text: string) => void;
  constructor(sink: (text: string) => void) { this.sink = sink; }
  push(line: Line) {
    if (this.started) this.sink(toJsonl([line]));
    else this.buf.push(line);
  }
  begin(meta: MetaLine) {
    if (this.started) return;
    this.started = true;
    this.sink(toJsonl([meta, ...this.buf]));
    this.buf = [];
  }
}

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
