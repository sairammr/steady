// SYNTHETIC breathing recordings for tests and the no-camera demo path. Not real data.
// Model: chest position p(t) ∈ [0,1] (cosine inhale/exhale ramps, flat pauses), seen by the
// "SDK" with a filter delay, Gaussian noise, chunked delivery, early unstable samples and
// occasional revisions of the previous chunk's tail.
import { estimateCalibration } from './calibration.ts';
import { accuracy, swayOffset } from './sway.ts';
import { detect, modelAt } from './detector.ts';
import type { Line, LiveState, MLine, MarkLine, MetaLine, PaceLine, RoundLine, RoundType, Sample, ShotLine } from './recording.ts';

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, gauss, range: (lo: number, hi: number) => lo + (hi - lo) * next() };
}

type Seg = { kind: 'in' | 'out' | 'flat'; t: number; dur: number; from: number; to: number };

export type SynthOpts = {
  seed: number; t0: number;
  orient: 1 | -1; amp: number; offset: number; noise: number;
  filterDelay: number; userLag: number; // ms
  cadence: number; procDelay: number; jitter: number; // ms
  revisionProb: number;
  script: Step[];
};
export type Step =
  | { do: 'natural'; ms: number; inhale?: number; exhale?: number; pause?: [number, number] }
  | { do: 'paced'; cycles: number }
  | { do: 'hold'; ms: number }
  | { do: 'talk'; ms: number }
  | { do: 'round'; type: RoundType; ms: number; inPauseFrac: number; rushed: number; talkAt?: number; talkMs?: number };

export type SynthTruth = { pauses: [number, number][]; talk: [number, number][] };

export function synthesize(o: SynthOpts): { lines: Line[]; truth: SynthTruth } {
  const R = rng(o.seed);
  const segs: Seg[] = [];
  const pace: PaceLine[] = [];
  const marks: MarkLine[] = [];
  const rounds: RoundLine[] = [];
  const talk: [number, number][] = [];
  const truthPauses: [number, number][] = [];
  const roundPlans: { type: RoundType; start: number; end: number; inPauseFrac: number; rushed: number }[] = [];
  let t = o.t0, level = 0;
  const push = (kind: Seg['kind'], dur: number, to: number) => {
    segs.push({ kind, t, dur, from: level, to });
    if (kind === 'flat' && level === 0 && dur >= 800) truthPauses.push([t, t + dur]);
    t += dur; level = to;
  };
  const natural = (until: number, s: Extract<Step, { do: 'natural' }> | { inhale?: number; exhale?: number; pause?: [number, number] }) => {
    while (t < until) {
      push('in', R.range(0.9, 1.1) * (s.inhale ?? 1700), 1);
      push('flat', R.range(150, 350), 1);
      push('out', R.range(0.9, 1.1) * (s.exhale ?? 2100), 0);
      const [a, b] = s.pause ?? [1400, 2600];
      push('flat', R.range(a, b), 0);
    }
  };
  for (const st of o.script) {
    if (st.do === 'natural') natural(t + st.ms, st);
    else if (st.do === 'hold') {
      marks.push({ k: 'mark', name: 'hold_start', t: Math.round(t) });
      push('flat', st.ms, 0);
      marks.push({ k: 'mark', name: 'hold_end', t: Math.round(t) });
      push('in', 1800, 1); push('out', 2200, 0); push('flat', 1500, 0);
    } else if (st.do === 'talk') {
      marks.push({ k: 'mark', name: 'talk_start', t: Math.round(t) });
      talk.push([t, t + st.ms]);
      natural(t + st.ms, {});
      marks.push({ k: 'mark', name: 'talk_end', t: Math.round(t) });
    } else if (st.do === 'paced') {
      // the user follows the pacer userLag late; pace lines carry the scheduled times
      let lag = o.userLag;
      push('flat', lag, 0);
      for (let c = 0; c < st.cycles; c++) {
        const s = t - lag;
        pace.push({ k: 'pace', phase: 'in', t: Math.round(s), dur: 4000 });
        pace.push({ k: 'pace', phase: 'out', t: Math.round(s + 4000), dur: 4000 });
        pace.push({ k: 'pace', phase: 'rest', t: Math.round(s + 8000), dur: 2000 });
        const next = o.userLag + Math.round(R.gauss() * 80); // per-cycle pacer-following jitter
        push('in', 4000, 1); push('out', 4000, 0); push('flat', 2000 + next - lag, 0);
        lag = next;
      }
    } else {
      const start = t;
      if (st.talkAt !== undefined) talk.push([start + st.talkAt, start + st.talkAt + (st.talkMs ?? 6000)]);
      natural(t + st.ms, {});
      rounds.push({ k: 'round', type: st.type, t_start: Math.round(start), t_end: Math.round(start + st.ms) });
      roundPlans.push({ type: st.type, start, end: start + st.ms, inPauseFrac: st.inPauseFrac, rushed: st.rushed });
    }
  }
  const tEnd = t;
  const posAt = (tt: number): number => {
    const s = segs.find((g) => tt >= g.t && tt < g.t + g.dur);
    if (!s) return 0;
    if (s.kind === 'flat') return s.from;
    const f = (tt - s.t) / s.dur;
    return s.from + (s.to - s.from) * (0.5 - 0.5 * Math.cos(Math.PI * f));
  };
  const inTalk = (tt: number) => talk.some(([a, b]) => tt >= a && tt < b);

  // SDK sampling at 30 Hz with filter delay; unstable for the first 6 s.
  const samples: Sample[] = [];
  for (let ts = o.t0; ts < tEnd; ts += 1000 / 30) {
    const noise = o.noise * R.gauss() * (inTalk(ts) ? 6 : 1);
    const v = o.offset + o.orient * o.amp * (posAt(ts - o.filterDelay) + noise);
    samples.push({ t: Math.round(ts * 10) / 10, v: Math.round(v * 1e5) / 1e5, s: ts - o.t0 > 6000 });
  }
  // Chunked delivery.
  const ms: MLine[] = [];
  let idx = 0, prevTail: Sample[] = [];
  for (let edge = o.t0 + o.cadence; idx < samples.length; edge += o.cadence) {
    const chunk: Sample[] = [];
    while (idx < samples.length && samples[idx].t < edge) chunk.push(samples[idx++]);
    let upper = chunk;
    if (prevTail.length && R.next() < o.revisionProb) {
      // revision: re-deliver the previous tail, now stable, slightly adjusted
      upper = [...prevTail.map((s) => ({ t: s.t, v: Math.round((s.v + o.amp * 0.01) * 1e5) / 1e5, s: true })), ...chunk];
    }
    prevTail = chunk.slice(-3).filter((s) => !s.s);
    const t_arr = Math.round(edge + o.procDelay + o.jitter * R.next());
    const talking = inTalk(edge - o.cadence / 2);
    ms.push({ k: 'm', t_arr, upper, rate: 14 + Math.round(R.gauss() * 10) / 10, pulse: 68 + Math.round(R.gauss() * 20) / 10, talking, valid: true });
  }

  // Shots: placed against ground truth, scored later by the real pipeline.
  const cal0 = { orient: o.orient, A: o.amp, period_ms: 6000 };
  const det = detect(samples, cal0);
  const shots: ShotLine[] = [];
  for (const rp of roundPlans) {
    let ta = rp.start + 800;
    let rushedLeft = rp.rushed;
    while (ta < rp.end - 1500) {
      let ts: number;
      if (rushedLeft > 0 && R.next() < 0.4) { ts = ta + R.range(200, 450); rushedLeft--; }
      else if (R.next() < rp.inPauseFrac) {
        const p = truthPauses.find(([a, b]) => a > ta + 300 && b - a >= 1300 && a < ta + 7000);
        ts = p ? p[0] + 0.45 * (p[1] - p[0]) : ta + R.range(1000, 6000);
      } else {
        const sp = segs.find((g) => g.kind === 'in' && g.t > ta + 300 && g.t < ta + 7000);
        ts = sp ? sp.t + 0.6 * sp.dur : ta + R.range(1000, 6000);
      }
      if (ts >= rp.end) break;
      const target: [number, number] = [Math.round(R.range(150, 1050)), Math.round(R.range(120, 520))];
      const mouse: [number, number] = [Math.round(target[0] + R.gauss() * 6), Math.round(target[1] + R.gauss() * 6)];
      const t_disp = Math.round(ts - 600);
      const m = modelAt(det.pts, t_disp);
      const offset = m ? swayOffset(m.x, m.trough, m.A, t_disp) : [0, 0] as [number, number];
      const impact: [number, number] = [Math.round((mouse[0] + offset[0]) * 100) / 100, Math.round((mouse[1] + offset[1]) * 100) / 100];
      const live: LiveState = inTalk(ts) ? 'unknown' : truthPauses.some(([a, b]) => ts >= a && ts < b) ? 'pause' : 'breath';
      shots.push({ k: 'shot', t: Math.round(ts), round: rp.type, t_target: Math.round(ta), target, mouse, offset, impact, t_disp, accuracy: accuracy(impact, target, 60), live_state: live });
      ta = ts + 700;
    }
  }

  // Interleave by time like the live recorder would, then put meta (with calibration) first.
  const timed = [...ms.map((l) => [l.t_arr, l] as const), ...pace.map((l) => [l.t, l] as const),
    ...marks.map((l) => [l.t, l] as const), ...shots.map((l) => [l.t, l] as const),
    ...rounds.map((l) => [l.t_end, l] as const)].sort((a, b) => a[0] - b[0]).map(([, l]) => l as Line);
  const meta: MetaLine = { k: 'meta', v: 1, sdk: 'synthetic', t0_wall: o.t0, sdk_time_unit: 'ms', cal: null, synthetic: true,
    note: 'SYNTHETIC TEST DATA generated by src/core/synth.ts; not a real person' };
  const lines: Line[] = [meta, ...timed];
  if (pace.length) {
    const { lags: _l, r: _r, ...cal } = estimateCalibration(lines);
    meta.cal = cal;
  }
  return { lines, truth: { pauses: truthPauses, talk } };
}

const base = { t0: 1763337600000, orient: -1 as const, amp: 0.8, offset: 2, noise: 0.015, filterDelay: 250, userLag: 150, cadence: 500, procDelay: 300, jitter: 120, revisionProb: 0.1 };
const warmAndPace: Step[] = [{ do: 'natural', ms: 15000 }, { do: 'paced', cycles: 3 }];

export const FIXTURES: Record<string, SynthOpts> = {
  'synthetic-clean': { ...base, seed: 1, script: [...warmAndPace,
    { do: 'round', type: 'guided', ms: 60000, inPauseFrac: 0.8, rushed: 1 },
    { do: 'round', type: 'nohud', ms: 60000, inPauseFrac: 0.55, rushed: 3 }] },
  'synthetic-talking': { ...base, seed: 2, script: [...warmAndPace,
    { do: 'round', type: 'guided', ms: 60000, inPauseFrac: 0.8, rushed: 0, talkAt: 20000, talkMs: 8000 },
    { do: 'round', type: 'nohud', ms: 60000, inPauseFrac: 0.6, rushed: 1 }] },
  'synthetic-slow': { ...base, seed: 3, orient: 1, amp: 1.3, filterDelay: 400, userLag: 250, cadence: 800, procDelay: 450,
    script: [{ do: 'natural', ms: 15000, inhale: 2200, exhale: 2800, pause: [1800, 3000] }, { do: 'paced', cycles: 3 },
      { do: 'round', type: 'guided', ms: 60000, inPauseFrac: 0.7, rushed: 0 },
      { do: 'round', type: 'nohud', ms: 60000, inPauseFrac: 0.5, rushed: 0 }] },
  'synthetic-spike': { ...base, seed: 4, script: [{ do: 'natural', ms: 60000 },
    { do: 'hold', ms: 5000 }, { do: 'hold', ms: 5000 }, { do: 'hold', ms: 5000 },
    { do: 'talk', ms: 20000 }, { do: 'paced', cycles: 3 }] },
};
