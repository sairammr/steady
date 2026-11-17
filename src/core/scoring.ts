// The single scoring path (PRD §6.6): post-round, over the final trace. Live colours are provisional.
import { calibrationFor } from './calibration.ts';
import { classifyAt, detect, modelAt, pauseAt, type Detection, type Pause } from './detector.ts';
import { pickInsight, type Insight, type ScoredShot } from './insights.ts';
import { buildTrace, median, ofKind, unknownIntervals, type Cal, type Interval, type Line, type LiveState, type RoundType, type ShotLine } from './recording.ts';
import { swayOffset } from './sway.ts';

export const MULT: Record<LiveState, number | null> = { pause: 1.0, breath: 0.3, unknown: null };

export type RoundStats = { n: number; n_scored: number; n_grey: number; pct_pause: number | null; avg_score: number | null; patience_ms: number | null };
export type Session = {
  id: string; date: string; synthetic: boolean; cal: Cal;
  guided: RoundStats; nohud: RoundStats;
  breathing_rate: number | null; rhythm_cv: number | null; pulse_trend: 'calm' | 'elevated' | 'unknown';
  insight: Insight; recording_file: string;
};
export type FinalShot = ShotLine & { judged_at: number; state: LiveState; score: number | null; after_timeout: boolean };
export type Detail = { det: Detection; unknown: Interval[]; shots: FinalShot[]; rounds: { type: RoundType; t_start: number; t_end: number }[]; sway_check_px: number | null };

const r1 = (v: number) => Math.round(v * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const orNull = (v: number) => (Number.isFinite(v) ? v : null);

function roundStats(shots: FinalShot[], pauses: Pause[]): RoundStats {
  const scored = shots.filter((s) => s.state !== 'unknown');
  const inPause = scored.filter((s) => s.state === 'pause');
  const patience = inPause.map((s) => s.judged_at - pauseAt(pauses, s.judged_at)!.start);
  return {
    n: shots.length, n_scored: scored.length, n_grey: shots.length - scored.length,
    pct_pause: scored.length ? r1((100 * inPause.length) / scored.length) : null,
    avg_score: orNull(r1(mean(scored.map((s) => s.score!)))),
    patience_ms: orNull(Math.round(mean(patience))),
  };
}

export function scoreRecording(lines: Line[], recordingFile: string): { session: Session; detail: Detail } {
  const meta = ofKind(lines, 'meta')[0];
  if (!meta) throw new Error('recording has no meta line');
  const cal: Cal = calibrationFor(lines);
  const { samples } = buildTrace(lines);
  const unknown = unknownIntervals(lines, cal.clock_ms);
  const det = detect(samples, cal, unknown);
  const rounds = ofKind(lines, 'round').map(({ type, t_start, t_end }) => ({ type, t_start, t_end }));

  let swayDev = 0, swayN = 0;
  const shots: FinalShot[] = ofKind(lines, 'shot').map((s) => {
    const judged_at = s.t + cal.L_ms;
    const state = classifyAt(judged_at, det);
    const mult = MULT[state];
    const prev = det.pauses.filter((p) => p.end <= judged_at).at(-1);
    const after_timeout = state === 'breath' && !!prev && prev.closedBy === 'timeout' && judged_at - prev.end < 3000;
    // Sway consistency: recompute the offset from the final trace at the displayed time.
    const m = modelAt(det.pts, s.t_disp);
    if (m) {
      const o = swayOffset(m.x, m.trough, m.A, s.t_disp);
      swayDev = Math.max(swayDev, Math.hypot(o[0] - s.offset[0], o[1] - s.offset[1]));
      swayN++;
    }
    return { ...s, judged_at, state, score: mult === null ? null : Math.round(s.accuracy * mult), after_timeout };
  });

  const pulseIn = (pred: (t: number) => boolean) => median(ofKind(lines, 'm').filter((m) => m.pulse !== null && pred(m.t_arr)).map((m) => m.pulse!));
  const firstRound = rounds[0]?.t_start ?? Infinity;
  const inRound = (t: number) => rounds.some((r) => t >= r.t_start && t <= r.t_end);
  const pBase = pulseIn((t) => t < firstRound), pRound = pulseIn(inRound);
  const pulse_trend = Number.isFinite(pBase) && Number.isFinite(pRound) ? (pRound > pBase * 1.1 ? 'elevated' : 'calm') : 'unknown';
  const rate = median(ofKind(lines, 'm').filter((m) => m.rate !== null && inRound(m.t_arr)).map((m) => m.rate!));

  const troughs = det.troughs.filter(inRound);
  const periods = troughs.slice(1).map((t, i) => t - troughs[i]).filter((p) => p < 3 * cal.period_ms);
  const cv = periods.length >= 3 ? Math.sqrt(mean(periods.map((p) => (p - mean(periods)) ** 2))) / mean(periods) : NaN;

  const guided = roundStats(shots.filter((s) => s.round === 'guided'), det.pauses);
  const nohud = roundStats(shots.filter((s) => s.round === 'nohud'), det.pauses);
  const insight = pickInsight(shots as ScoredShot[], { guided: guided.pct_pause, nohud: nohud.pct_pause });

  const session: Session = {
    id: `S${meta.t0_wall}`, date: new Date(meta.t0_wall).toISOString(), synthetic: meta.synthetic === true, cal,
    guided, nohud, breathing_rate: orNull(r1(rate)), rhythm_cv: orNull(Math.round(cv * 1000) / 1000), pulse_trend,
    insight, recording_file: recordingFile,
  };
  return { session, detail: { det, unknown, shots, rounds, sway_check_px: swayN ? r1(swayDev) : null } };
}

/** Plain-text report, identical for identical input. */
export function formatReport(session: Session, detail: Detail, label: string): string {
  const s = session, c = s.cal;
  const pct = (v: number | null) => (v === null ? 'n/a' : `${v}%`);
  const row = (name: string, r: RoundStats) =>
    `  ${name.padEnd(7)} shots ${r.n} (scored ${r.n_scored}, grey ${r.n_grey})  in pause ${pct(r.pct_pause)}  avg score ${r.avg_score ?? 'n/a'}  patience ${r.patience_ms ?? 'n/a'} ms`;
  const dots = detail.shots.map((x) => ({ pause: 'G', breath: 'R', unknown: '.' })[x.state]).join('');
  return [
    `STEADY session report — ${label}`,
    s.synthetic ? '*** SYNTHETIC TEST DATA — not a real person ***' : '',
    `calibration: orient ${c.orient > 0 ? '+' : '-'}  A ${c.A}  period ${c.period_ms} ms  L ${c.L_ms} ± ${c.L_spread_ms} ms  D ${c.D_ms} ms (p95 ${c.D_p95_ms}, jitter only)  clock ${c.clock_ms} ms`,
    `detector: ${detail.det.pauses.length} pause windows, ${detail.unknown.length} unknown spans`,
    row('Guided', s.guided),
    row('No-HUD', s.nohud),
    `headline: ${pct(s.guided.pct_pause)} with help, ${pct(s.nohud.pct_pause)} on your own`,
    `breathing rate ${s.breathing_rate ?? 'n/a'}/min  rhythm CV ${s.rhythm_cv ?? 'n/a'}  pulse ${s.pulse_trend}`,
    `shots (G=pause R=breath .=grey): ${dots}`,
    `sway check (max |recorded − recomputed offset|): ${detail.sway_check_px ?? 'n/a'} px`,
    `insight: ${s.insight.text}`,
  ].filter(Boolean).join('\n');
}
