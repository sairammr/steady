// D1 spike summary (PRD §14): cadence, samples/event, time unit, revisions, D, holds, talking, L,
// and the go / degrade / no-go verdict.
import { cycleLags, deliveryDelay, orientAndLag } from './calibration.ts';
import { buildTrace, median, ofKind, quantile, type Line, type MarkLine, type Sample } from './recording.ts';

export type Verdict = 'go' | 'degrade' | 'no-go';
export type SpikeSummary = {
  synthetic: boolean;
  events: number; duration_s: number;
  cadence_ms: number; cadence_p90_ms: number; samples_per_event: number; sample_rate_hz: number;
  time_unit: string; revisions: number; stable_flips: number; unstable_frac: number;
  D_ms: number; D_p95_ms: number;
  holds: { start: number; valid_frac: number }[]; holds_ok: boolean;
  talking_flagged_in_segment: number | null; talking_false_positive: number | null;
  orient: number | null; L_ms: number | null; L_cycles: number[];
  pip: string;
  verdict: Verdict; reasons: string[];
};

/** Fraction of a [a,b] span covered by a stable sample within 300 ms, on a 100 ms grid. */
function coverage(samples: Sample[], a: number, b: number): number {
  let ok = 0, n = 0, j = 0;
  for (let t = a; t < b; t += 100, n++) {
    while (j + 1 < samples.length && samples[j + 1].t <= t) j++;
    const near = [samples[j], samples[j + 1]].some((s) => s && Math.abs(s.t - t) <= 300 && s.s);
    if (near) ok++;
  }
  return n ? ok / n : 0;
}

export function summarizeSpike(lines: Line[]): SpikeSummary {
  const meta = ofKind(lines, 'meta')[0];
  const ms = ofKind(lines, 'm');
  const marks = ofKind(lines, 'mark');
  const { samples, revisions, stableFlips } = buildTrace(lines);
  const arr = ms.map((m) => m.t_arr);
  const gaps = arr.slice(1).map((t, i) => t - arr[i]);
  const { D_ms, D_p95_ms } = deliveryDelay(lines);
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
  // Holds are judged at sample time ≈ wall time (SDK anchors frame timestamps to wall clock).
  const holds = span('hold_start', 'hold_end').map(([a, b]) => ({ start: a, valid_frac: Math.round(coverage(samples, a, b) * 100) / 100 }));
  const holds_ok = holds.length > 0 && holds.every((h) => h.valid_frac >= 0.8);

  const talks = span('talk_start', 'talk_end');
  const inTalk = (t: number) => talks.some(([a, b]) => t >= a && t <= b + D_ms);
  const tIn = ms.filter((m) => inTalk(m.t_arr)), tOut = ms.filter((m) => !inTalk(m.t_arr));
  const frac = (xs: typeof ms) => (xs.length ? Math.round((xs.filter((m) => m.talking).length / xs.length) * 100) / 100 : null);

  const pace = ofKind(lines, 'pace');
  let orient: number | null = null, L: number | null = null, Lc: number[] = [];
  if (pace.length && samples.length) {
    orient = orientAndLag(samples, pace).orient;
    Lc = cycleLags(samples, pace, orient as 1 | -1);
    L = Lc.length ? median(Lc) : null;
  }
  const pip = marks.find((m) => m.name.startsWith('pip_'));

  const cadence = median(gaps);
  const reasons: string[] = [];
  let verdict: Verdict = 'go';
  const worse = (v: Verdict) => { if (v === 'no-go' || (v === 'degrade' && verdict === 'go')) verdict = v; };
  if (!samples.length) { worse('no-go'); reasons.push('no chest-trace samples received'); }
  if (holds.length && !holds_ok) { worse('no-go'); reasons.push('trace not valid during post-exhale holds (<80% coverage)'); }
  if (!holds.length) reasons.push('no hold markers: hold validity untested');
  if (!(D_ms <= 3000)) { worse('no-go'); reasons.push(`D ${D_ms} ms > 3 s`); }
  else if (D_ms > 1500) { worse('degrade'); reasons.push(`D ${D_ms} ms in 1.5–3 s`); }
  // PRD gives no band above 2 s cadence; treated as no-go here (sway would be unusable).
  if (!(cadence <= 2000)) { worse('no-go'); reasons.push(`cadence ${cadence} ms > 2 s`); }
  else if (cadence > 1000) { worse('degrade'); reasons.push(`cadence ${cadence} ms in 1–2 s`); }
  if (!reasons.length) reasons.push('holds valid, D ≤ 1.5 s, cadence ≤ 1 s');

  return {
    synthetic: meta?.synthetic === true,
    events: ms.length, duration_s: Math.round(dur),
    cadence_ms: Math.round(cadence), cadence_p90_ms: Math.round(quantile(gaps, 0.9)),
    samples_per_event: median(ms.map((m) => m.upper.length)),
    sample_rate_hz: dur > 0 ? Math.round((samples.length / dur) * 10) / 10 : 0,
    time_unit: Math.abs(lag0) < 60_000 ? 'epoch-aligned (µs since epoch ÷ 1000 → ms)' : `NOT wall-aligned (first arrival − first t = ${Math.round(lag0)} ms)`,
    revisions, stable_flips: stableFlips,
    unstable_frac: samples.length ? Math.round((samples.filter((s) => !s.s).length / samples.length) * 100) / 100 : 0,
    D_ms, D_p95_ms, holds, holds_ok,
    talking_flagged_in_segment: talks.length ? frac(tIn) : null, talking_false_positive: talks.length ? frac(tOut) : null,
    orient, L_ms: L === null ? null : Math.round(L), L_cycles: Lc,
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
    `D (delivery delay) median ${s.D_ms} ms, p95 ${s.D_p95_ms} ms`,
    `holds: ${s.holds.map((h) => `${Math.round(h.valid_frac * 100)}%`).join(', ') || 'none'} valid → ${s.holds_ok ? 'OK' : 'NOT OK'}`,
    `talking flag: ${s.talking_flagged_in_segment ?? 'n/a'} of events in the talking segment, ${s.talking_false_positive ?? 'n/a'} outside`,
    `paced: orientation ${s.orient ?? 'n/a'} · L ${s.L_ms ?? 'n/a'} ms (cycles ${s.L_cycles.join(', ') || 'none'})`,
    `picture-in-picture: ${s.pip}`,
    `VERDICT: ${s.verdict.toUpperCase()} — ${s.reasons.join('; ')}`,
  ].join('\n');
}
