// D1 spike summary (PRD §14): cadence, samples/event, time unit, revisions, D, holds, talking, L,
// and the go / degrade / no-go verdict.
import { deliveryDelay, estimateCalibration } from './calibration.ts';
import { DEFAULT_OPTS, detect, type Detection } from './detector.ts';
import { buildTrace, median, ofKind, quantile, unknownIntervals, type Line, type MarkLine } from './recording.ts';

export type Verdict = 'go' | 'degrade' | 'no-go';
export type SpikeSummary = {
  synthetic: boolean;
  events: number; duration_s: number;
  cadence_ms: number; cadence_p90_ms: number; samples_per_event: number; sample_rate_hz: number;
  time_unit: string; revisions: number; stable_flips: number; unstable_frac: number;
  D_ms: number; D_p95_ms: number; clock_ms: number;
  holds: { start: number; flat_frac: number; valid_frac: number; pause_frac: number }[]; holds_ok: boolean;
  talking_flagged_in_segment: number | null; talking_false_positive: number | null;
  orient: number | null; orient_by: string | null; L_ms: number | null; L_spread_ms: number | null; L_cycles: number[];
  pauses_normal: number | null;
  pip: string;
  verdict: Verdict; reasons: string[];
};

const HOLD_SETTLE_MS = 1000; // the user finishes the exhale after HOLD appears
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A hold is judged on the sample-clock span [a + settle, b] by LOW SLOPE, not range: the trace drifts
 * slowly during a hold (D1: ~35% of A) but stays flat by the detector's own |slope| < k·A rule.
 * flat_frac ignores SDK validity (it asks "is the pause visible in the trace?"); valid_frac reports the
 * guard separately; pause_frac = share inside a detected pause window (also needs the level test).
 */
function judgeHold(det: Detection, a: number, b: number): { flat_frac: number; valid_frac: number; pause_frac: number } {
  const pts = det.pts.filter((p) => p.t >= a + HOLD_SETTLE_MS && p.t < b);
  if (!pts.length) return { flat_frac: 0, valid_frac: 0, pause_frac: 0 };
  const share = (f: (p: Detection['pts'][number]) => boolean) => r2(pts.filter(f).length / pts.length);
  return {
    flat_frac: share((p) => Math.abs(p.slope) < DEFAULT_OPTS.k * p.A),
    valid_frac: share((p) => p.ok),
    pause_frac: share((p) => det.pauses.some((w) => p.t >= w.start && p.t < w.end)),
  };
}

export function summarizeSpike(lines: Line[]): SpikeSummary {
  const meta = ofKind(lines, 'meta')[0];
  const ms = ofKind(lines, 'm');
  const marks = ofKind(lines, 'mark');
  const { samples, revisions, stableFlips } = buildTrace(lines);
  const arr = ms.map((m) => m.t_arr);
  const gaps = arr.slice(1).map((t, i) => t - arr[i]);
  const { D_ms, D_p95_ms, clock_ms } = deliveryDelay(lines);
  const dur = samples.length ? (samples[samples.length - 1].t - samples[0].t) / 1000 : 0;
  const lag0 = samples.length ? arr[0] - samples[0].t : NaN;

  const span = (a: string, b: string) => {
    const out: [number, number][] = [];
    marks.forEach((m, i) => {
      if (m.name !== a) return;
      const end = marks.slice(i + 1).find((x: MarkLine) => x.name === b);
      if (end) out.push([m.t, end.t]);
    });
    return out;
  };
  const pace = ofKind(lines, 'pace');
  const cal = pace.length && samples.length ? estimateCalibration(lines) : null;
  const det = cal ? detect(samples, cal, unknownIntervals(lines, cal.clock_ms)) : null;
  // Marks are wall clock; sample t ≈ wall − clock_ms (the SDK's anchor offset, see deliveryDelay).
  const holds = det ? span('hold_start', 'hold_end').map(([a, b]) => ({ start: a, ...judgeHold(det, a - clock_ms, b - clock_ms) })) : [];
  const holds_ok = holds.length > 0 && holds.every((h) => h.flat_frac >= 0.7);
  const normal = span('normal_start', 'normal_end')[0];
  const pauses_normal = det && normal ? det.pauses.filter((w) => w.start >= normal[0] - clock_ms && w.start < normal[1] - clock_ms).length : null;

  const talks = span('talk_start', 'talk_end');
  const inTalk = (t: number) => talks.some(([a, b]) => t >= a && t <= b + D_ms);
  const tIn = ms.filter((m) => inTalk(m.t_arr)), tOut = ms.filter((m) => !inTalk(m.t_arr));
  const frac = (xs: typeof ms) => (xs.length ? Math.round((xs.filter((m) => m.talking).length / xs.length) * 100) / 100 : null);

  const pip = marks.find((m) => m.name.startsWith('pip_'));

  const cadence = median(gaps);
  const reasons: string[] = [];
  let verdict: Verdict = 'go';
  const worse = (v: Verdict) => { if (v === 'no-go' || (v === 'degrade' && verdict === 'go')) verdict = v; };
  if (!samples.length) { worse('no-go'); reasons.push('no chest-trace samples received'); }
  if (holds.length && !holds_ok) { worse('no-go'); reasons.push('pause not detectable during post-exhale holds (needs ≥70% low-slope each)'); }
  const invalid = holds.filter((h) => h.valid_frac < 0.8).length;
  if (invalid) reasons.push(`${invalid}/${holds.length} holds mostly SDK-invalid (greyed live; check validation marks)`);
  if (!holds.length) reasons.push('no hold markers or paced cycles: hold detectability untested');
  // D here is delivery jitter only (absolute delay is unobservable, see deliveryDelay); rules apply to it.
  if (!(D_ms <= 3000)) { worse('no-go'); reasons.push(`D ${D_ms} ms > 3 s`); }
  else if (D_ms > 1500) { worse('degrade'); reasons.push(`D ${D_ms} ms in 1.5–3 s`); }
  // PRD gives no band above 2 s cadence; treated as no-go here (sway would be unusable).
  if (!(cadence <= 2000)) { worse('no-go'); reasons.push(`cadence ${cadence} ms > 2 s`); }
  else if (cadence > 1000) { worse('degrade'); reasons.push(`cadence ${cadence} ms in 1–2 s`); }
  if (verdict === 'go') reasons.unshift('pause detectable (low slope) in holds, D (jitter) ≤ 1.5 s, cadence ≤ 1 s');

  return {
    synthetic: meta?.synthetic === true,
    events: ms.length, duration_s: Math.round(dur),
    cadence_ms: Math.round(cadence), cadence_p90_ms: Math.round(quantile(gaps, 0.9)),
    samples_per_event: median(ms.map((m) => m.upper.length)),
    sample_rate_hz: dur > 0 ? Math.round((samples.length / dur) * 10) / 10 : 0,
    time_unit: Math.abs(lag0) < 60_000 ? 'epoch-aligned (µs since epoch ÷ 1000 → ms)' : `NOT wall-aligned (first arrival − first t = ${Math.round(lag0)} ms)`,
    revisions, stable_flips: stableFlips,
    unstable_frac: samples.length ? Math.round((samples.filter((s) => !s.s).length / samples.length) * 100) / 100 : 0,
    D_ms, D_p95_ms, clock_ms, holds, holds_ok,
    talking_flagged_in_segment: talks.length ? frac(tIn) : null, talking_false_positive: talks.length ? frac(tOut) : null,
    orient: cal?.orient ?? null, orient_by: cal?.orient_by ?? null,
    L_ms: cal && Number.isFinite(cal.L_ms) ? cal.L_ms : null, L_spread_ms: cal && Number.isFinite(cal.L_spread_ms) ? cal.L_spread_ms : null,
    L_cycles: cal?.lags ?? [], pauses_normal,
    pip: pip ? pip.name + (pip.detail ? ` (${pip.detail})` : '') : 'not checked',
    verdict, reasons,
  };
}

export function formatSpike(s: SpikeSummary): string {
  return [
    `STEADY D1 spike summary${s.synthetic ? '  *** SYNTHETIC TEST DATA ***' : ''}`,
    `events ${s.events} over ${s.duration_s} s · cadence median ${s.cadence_ms} ms (p90 ${s.cadence_p90_ms}) · samples/event ${s.samples_per_event} · ~${s.sample_rate_hz} Hz`,
    `time: ${s.time_unit}`,
    `revisions ${s.revisions} (stable false→true ${s.stable_flips}) · unstable samples ${Math.round(s.unstable_frac * 100)}%`,
    `clock: arrival − sample t median ${s.clock_ms} ms (SDK anchor offset + delay; not separable)`,
    `D (delivery jitter above fastest sample) median ${s.D_ms} ms, p95 ${s.D_p95_ms} ms`,
    `holds (low-slope / SDK-valid / in pause window): ${s.holds.map((h) => [h.flat_frac, h.valid_frac, h.pause_frac].map((v) => `${Math.round(v * 100)}%`).join('/')).join(', ') || 'none'} → ${s.holds_ok ? 'pause detectable' : 'NOT detectable'}`,
    `pause windows in the normal-breathing segment: ${s.pauses_normal ?? 'n/a'}`,
    `talking flag: ${s.talking_flagged_in_segment ?? 'n/a'} of events in the talking segment, ${s.talking_false_positive ?? 'n/a'} outside`,
    `orientation ${s.orient ?? 'n/a'} by ${s.orient_by ?? 'n/a'} · paced L ${s.L_ms ?? 'n/a'} ± ${s.L_spread_ms ?? 'n/a'} ms (cycles ${s.L_cycles.join(', ') || 'none'})`,
    `picture-in-picture: ${s.pip}`,
    `VERDICT: ${s.verdict.toUpperCase()} — ${s.reasons.join('; ')}`,
  ].join('\n');
}
