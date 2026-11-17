// Live session: warm-up → paced calibration → Guided round → No-HUD round. PRD §7, §8.
import { estimateCalibration } from '../core/calibration.ts';
import { classifyAt, DEFAULT_OPTS, detect, modelAt, prepare, type Detection } from '../core/detector.ts';
import { buildTrace, median, ofKind, Recorder, unknownIntervals, type Cal, type Line, type MetaLine, type PaceLine, type RoundType, type ShotLine } from '../core/recording.ts';
import { accuracy, swayOffset } from '../core/sway.ts';
import { COLORS, drawCrosshair, drawCurve, drawTarget, stateColor } from './draw.ts';
import { Live } from './live.ts';
import { api, beep, esc, pip, show, sleep, type Settings } from './ui.ts';

export const ROUND_MS = 60_000;
const TARGET_MS = 8_000;
const TARGET_R = 60;
const W = 1150, H = 640, HUD_H = 110;

export class LiveSession {
  lines: Line[] = [];
  cal: Cal | null = null;
  det: Detection | null = null;
  live: Live;
  file = '';
  t0 = Date.now();
  aborted = false;
  private rec!: Recorder;
  private lastDet = 0;
  constructor(key: string) {
    this.live = new Live(key, {
      onLine: (l) => this.add(l),
      onStream: (s) => pip(s),
      onError: (msg) => { const e = document.getElementById('err'); if (e) e.textContent = msg; },
    });
  }

  async open(kind: 'session' | 'spike') {
    this.file = await api().recOpen(`${kind}-${new Date(this.t0).toISOString().replace(/[:.]/g, '-')}`, kind);
    this.rec = new Recorder((text) => { void api().recAppend(this.file, text); });
  }

  add(l: Line) {
    this.lines.push(l);
    this.rec?.push(l);
    if (l.k === 'm' && Date.now() - this.lastDet > 200) this.updateDet();
  }

  begin(meta: MetaLine) {
    this.lines.unshift(meta);
    this.rec.begin(meta);
  }

  /** Live detection over the last 30 s (same detector as post-round). */
  updateDet() {
    this.lastDet = Date.now();
    const cutoff = Date.now() - 30_000;
    const recent = this.lines.filter((l) => l.k !== 'm' || l.t_arr > cutoff);
    const { samples } = buildTrace(recent);
    const cal = this.cal ?? { orient: 1 as const, A: 1, period_ms: 6000 };
    if (this.cal) this.det = detect(samples, cal, unknownIntervals(recent, this.cal.clock_ms));
    else this.det = { pts: prepare(samples, cal, [], detectOptsLoose), pauses: [], onsets: [], troughs: [] };
  }

  lastSampleT() { return this.det?.pts.at(-1)?.t ?? 0; }
  signalOk() { return this.live.valid && this.live.running && Date.now() - this.live.lastArrival < 2500; }
  async stop() { await this.live.stop(); pip(null); }
}
const detectOptsLoose = { ...DEFAULT_OPTS, requireStable: false };

const topbar = (title: string) => `<div class="topbar"><h1>${esc(title)}</h1><div><span id="err" class="dim"></span> <button id="camoff" class="danger">Camera off</button></div></div>`;

/** Warm-up until the SDK reports a valid face/chest for 5 s and samples are flowing. */
export async function warmUp(s: LiveSession): Promise<boolean> {
  show(`${topbar('Warm-up')}
    <p>Sit still, face the camera, chest visible, even light. Stay silent. Be alone in frame.</p>
    <div class="panel"><b id="hint">Starting camera…</b></div>
    <canvas id="c" width="${W}" height="200"></canvas>`, { camoff: () => { s.aborted = true; } });
  await s.live.start();
  const c = (document.getElementById('c') as HTMLCanvasElement).getContext('2d')!;
  let validSince = 0;
  while (!s.aborted) {
    await sleep(100);
    const ok = s.signalOk() && s.lastSampleT() > 0;
    validSince = ok ? validSince || Date.now() : 0;
    const left = validSince ? Math.max(0, 5 - (Date.now() - validSince) / 1000) : 5;
    document.getElementById('hint')!.textContent = ok ? `Signal good. Hold still… ${left.toFixed(1)} s` : s.live.hint || 'Waiting for signal…';
    if (s.det) drawCurve(c, { x: 0, y: 0, w: W, h: 200 }, s.det.pts, s.lastSampleT() - 15000, s.lastSampleT(), { label: 'chest breathing trace (raw, uncalibrated)' });
    if (validSince && Date.now() - validSince >= 5000) return true;
  }
  return false;
}

/** 3 paced cycles: 4 s in, 4 s out, 2 s rest. Scheduled timestamps are recorded as `pace` lines. */
export async function pacedSync(s: LiveSession): Promise<PaceLine[]> {
  show(`${topbar('Breath sync')}
    <p>Follow the circle: breathe <b>in</b> as it grows, <b>out</b> as it shrinks, rest when it holds. Stay silent. No keys needed.</p>
    <canvas id="c" width="${W}" height="380"></canvas>`, { camoff: () => { s.aborted = true; } });
  const c = (document.getElementById('c') as HTMLCanvasElement).getContext('2d')!;
  const T = Date.now() + 3000;
  const pace: PaceLine[] = [];
  for (let i = 0; i < 3; i++) {
    const b = T + i * 10_000;
    pace.push({ k: 'pace', phase: 'in', t: b, dur: 4000 }, { k: 'pace', phase: 'out', t: b + 4000, dur: 4000 }, { k: 'pace', phase: 'rest', t: b + 8000, dur: 2000 });
  }
  pace.forEach((p) => s.add(p));
  const end = T + 30_000 + 3000; // + tail so delayed samples of the last cycle arrive
  while (!s.aborted && Date.now() < end) {
    await new Promise(requestAnimationFrame);
    const now = Date.now();
    const p = pace.find((q) => now >= q.t && now < q.t + q.dur);
    const f = p ? (now - p.t) / p.dur : 0;
    const size = !p ? 0 : p.phase === 'in' ? f : p.phase === 'out' ? 1 - f : 0;
    const label = now < T ? `Get ready… ${Math.ceil((T - now) / 1000)}` : !p ? 'Done, hold still…' : p.phase === 'in' ? 'Breathe in' : p.phase === 'out' ? 'Breathe out' : 'Rest';
    c.fillStyle = '#0b0d11'; c.fillRect(0, 0, W, 380);
    c.fillStyle = 'rgba(242,193,78,0.85)';
    c.beginPath(); c.arc(W / 2, 190, 40 + 130 * size, 0, Math.PI * 2); c.fill();
    c.fillStyle = COLORS.ink; c.font = '28px system-ui'; c.textAlign = 'center';
    c.fillText(label, W / 2, 360);
    const cyc = pace.filter((q) => q.phase === 'in' && q.t <= now).length;
    c.font = '15px system-ui'; c.fillText(`cycle ${Math.max(1, cyc)} of 3`, W / 2, 30);
  }
  return pace;
}

export function calibrate(s: LiveSession, sdkVersion: string): { ok: boolean; why?: string } {
  try {
    const { lags, r, ...cal } = estimateCalibration(s.lines);
    if (Math.abs(r) < 0.3 || lags.length < 2) return { ok: false, why: `breath did not follow the pacer clearly (r=${r}, ${lags.length}/3 cycles)` };
    s.cal = cal;
    s.begin({ k: 'meta', v: 1, sdk: sdkVersion, t0_wall: s.t0, sdk_time_unit: 'ms', cal });
    s.updateDet();
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String((e as Error).message ?? e) };
  }
}

export function pulseBaseline(s: LiveSession): number | null {
  const v = median(ofKind(s.lines, 'm').map((m) => m.pulse).filter((p): p is number => p !== null));
  return Number.isFinite(v) ? v : null;
}

/** One 60 s round. Fire = any key (except Esc) or mouse button. */
export async function playRound(s: LiveSession, type: RoundType, settings: Settings, pulseBase: number | null): Promise<boolean> {
  const cal = s.cal!;
  const guided = type === 'guided';
  show(`${topbar(guided ? 'Guided round' : 'No-HUD round')}
    <p class="dim">${guided ? 'Fire when the crosshair settles in the green pause. ' : 'No help this time: same sway, same scoring. '}Any key or mouse button fires. Stay silent.</p>
    <canvas id="c" width="${W}" height="${H}" style="cursor:none"></canvas>`, { camoff: () => { s.aborted = true; } });
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const c = canvas.getContext('2d')!;
  // Sample clock = wall − clock_ms; show the trace where 95% of samples have arrived, + 100 ms margin.
  const Ddisp = cal.clock_p95_ms + 100;
  const behind = cal.clock_p95_ms - cal.clock_ms + 100; // display lag behind the newest sample
  const field = H - HUD_H;
  let mouse: [number, number] = [W / 2, field / 2];
  let offset: [number, number] = [0, 0];
  let target: { x: number; y: number; t: number } | null = null;
  let nextTarget = Date.now() + 1000;
  let elapsed = 0, last = Date.now();
  let flash = null as { x: number; y: number; color: string; until: number } | null;
  let wasNow = false;
  const t_start = Date.now();

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse = [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  });
  const fire = () => {
    const now = Date.now();
    if (!target || !s.signalOk()) return;
    const impact: [number, number] = [Math.round((mouse[0] + offset[0]) * 100) / 100, Math.round((mouse[1] + offset[1]) * 100) / 100];
    const judged = now + cal.L_ms;
    const live_state = s.det ? classifyAt(Math.min(judged, s.lastSampleT()), s.det) : 'unknown'; // provisional
    const shot: ShotLine = {
      k: 'shot', t: now, round: type, t_target: target.t, target: [Math.round(target.x), Math.round(target.y)],
      mouse: [Math.round(mouse[0]), Math.round(mouse[1])], offset: [...offset], impact, t_disp: Math.round(now - Ddisp),
      accuracy: accuracy(impact, [target.x, target.y], TARGET_R), live_state,
    };
    s.add(shot);
    flash = { x: impact[0], y: impact[1], color: guided ? stateColor(live_state) : '#ffffff', until: now + 500 };
    target = null;
    nextTarget = now + 600;
  };
  const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape' && !e.repeat) fire(); };
  canvas.addEventListener('mousedown', fire);
  window.addEventListener('keydown', onKey);

  try {
    while (!s.aborted && elapsed < ROUND_MS) {
      await new Promise(requestAnimationFrame);
      const now = Date.now();
      const tDisp = now - Ddisp;
      const m = s.det ? modelAt(s.det.pts, tDisp) : null;
      const ok = s.signalOk() && !!m;
      if (ok) elapsed += now - last; // invalid signal pauses the round and freezes sway
      last = now;
      if (ok) offset = swayOffset(m!.x, m!.trough, m!.A, tDisp);
      if (!target && ok && now >= nextTarget) target = { x: 120 + Math.random() * (W - 240), y: 90 + Math.random() * (field - 180), t: now };
      if (target && now - target.t > TARGET_MS) { target = null; nextTarget = now + 500; }

      c.fillStyle = '#12151b'; c.fillRect(0, 0, W, field);
      if (target) drawTarget(c, target.x, target.y, TARGET_R);
      if (flash && now < flash.until) { c.fillStyle = flash.color; c.beginPath(); c.arc(flash.x, flash.y, 7, 0, Math.PI * 2); c.fill(); }
      drawCrosshair(c, mouse[0] + offset[0], mouse[1] + offset[1]);

      // HUD
      const latest = s.det ? classifyAt(s.lastSampleT(), s.det) : 'unknown';
      const isNow = latest === 'pause';
      if (guided && isNow && !wasNow && settings.tick) beep();
      wasNow = isNow;
      // No-HUD hides the waveform too: the curve itself is a timing cue. Sway is the only feedback.
      if (guided) drawCurve(c, { x: 0, y: field, w: W, h: HUD_H }, s.det?.pts ?? [], tDisp - 12_000, tDisp,
        { pauses: s.det?.pauses, unknown: unknownIntervals(s.lines.slice(-200), cal.clock_ms) });
      c.font = '16px system-ui'; c.textAlign = 'left'; c.fillStyle = COLORS.ink;
      c.fillText(`${Math.ceil((ROUND_MS - elapsed) / 1000)} s`, 16, 28);
      c.fillStyle = COLORS.dim;
      c.fillText(`trace shown ${(behind / 1000).toFixed(1)} s behind live`, 16, field - 12);
      if (pulseBase !== null && s.live.lastPulse !== null) {
        const elevated = s.live.lastPulse > pulseBase * 1.1;
        c.fillStyle = elevated ? COLORS.red : COLORS.green;
        c.fillText(`settle: ${elevated ? 'elevated' : 'calm'}`, W - 160, 28);
      }
      if (guided && isNow) { c.fillStyle = COLORS.green; c.font = 'bold 30px system-ui'; c.fillText('NOW', W / 2 - 34, 40); }
      if (s.live.talking) { c.fillStyle = COLORS.grey; c.font = 'bold 20px system-ui'; c.fillText('Stay silent: shots are not scored while talking', W / 2 - 220, 70); }
      if (!ok) {
        c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(0, 0, W, field);
        c.fillStyle = COLORS.ink; c.font = '22px system-ui';
        c.fillText(`Round paused: ${s.live.hint || 'waiting for a valid signal'}`, 40, field / 2);
      }
    }
  } finally {
    window.removeEventListener('keydown', onKey);
  }
  s.add({ k: 'round', type, t_start, t_end: Date.now() });
  return !s.aborted;
}
