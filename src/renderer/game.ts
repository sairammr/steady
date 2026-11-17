// Live session: warm-up → paced calibration → Guided round → No-HUD round. PRD §7, §8.
import { estimateCalibration } from '../core/calibration.ts';
import { classifyAt, DEFAULT_OPTS, detect, modelAt, prepare, type Detection } from '../core/detector.ts';
import { buildTrace, median, ofKind, Recorder, unknownIntervals, type Cal, type Line, type LiveState, type MetaLine, type PaceLine, type RoundType, type ShotLine } from '../core/recording.ts';
import { accuracy, swayOffset } from '../core/sway.ts';
import { COLORS, drawCrosshair, drawCurve, drawHole, drawTarget, drawTimeArc, fieldBackground, FONT, pill, stateColor, stateLabel } from './draw.ts';
import { Live } from './live.ts';
import { api, beep, hidpi, liveLayout, pip, show, sleep, type Settings } from './ui.ts';

export const ROUND_MS = 60_000;
const TARGET_MS = 8_000;
const TARGET_R = 60;
export const W = 980;
const H = 620, HUD_H = 120;

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
    const cal = this.cal ?? { orient: 1 as const, A: 1, period_ms: 6000, D_ms: 600 };
    if (this.cal) this.det = detect(samples, cal, unknownIntervals(recent, cal.D_ms));
    else this.det = { pts: prepare(samples, cal, [], detectOptsLoose), pauses: [], onsets: [], troughs: [] };
  }

  lastSampleT() { return this.det?.pts.at(-1)?.t ?? 0; }
  /** Latest time the live state can be read at. A pause still open at the end of the buffer is
   *  closed at the last sample (end exclusive), so read 1 ms before it or it never shows as a pause. */
  liveT() { return this.lastSampleT() - 1; }
  signalOk() { return this.live.valid && this.live.running && Date.now() - this.live.lastArrival < 2500; }
  async stop() { await this.live.stop(); pip(null); }
}
const detectOptsLoose = { ...DEFAULT_OPTS, requireStable: false };

/** Warm-up until the SDK reports a valid face/chest for 5 s and samples are flowing. */
export async function warmUp(s: LiveSession): Promise<boolean> {
  show(liveLayout(0, `<div class="kicker">Step 1 · Warm-up</div>
    <div class="prompt">Get in position</div>
    <ul class="checks"><li>Sit still, face the camera</li><li>Chest visible, even light</li><li>Stay silent</li><li>Be alone in frame</li></ul>
    <div class="card tight"><div id="hint" class="status">Starting camera…</div>
      <div class="bar" style="margin-top:12px"><i id="hold"></i></div>
      <div class="small dim" style="margin-top:6px">Needs 5 s of steady signal before the breath sync starts.</div></div>
    <canvas id="c"></canvas>`), { camoff: () => { s.aborted = true; } });
  const c = hidpi(document.getElementById('c') as HTMLCanvasElement, W, 200);
  await s.live.start();
  let validSince = 0;
  while (!s.aborted) {
    await sleep(100);
    const ok = s.signalOk() && s.lastSampleT() > 0;
    validSince = ok ? validSince || Date.now() : 0;
    const held = validSince ? Math.min(5, (Date.now() - validSince) / 1000) : 0;
    const hint = document.getElementById('hint')!;
    hint.textContent = ok ? `Signal good. Hold still… ${(5 - held).toFixed(1)} s` : s.live.hint || 'Waiting for signal…';
    hint.classList.toggle('ok', ok);
    (document.getElementById('hold') as HTMLElement).style.width = `${(held / 5) * 100}%`;
    if (s.det) drawCurve(c, { x: 0, y: 0, w: W, h: 200 }, s.det.pts, s.lastSampleT() - 15000, s.lastSampleT(), { label: 'Chest breathing trace', sublabel: 'raw, before calibration' });
    if (validSince && Date.now() - validSince >= 5000) return true;
  }
  return false;
}

/** 3 paced cycles: 4 s in, 4 s out, 2 s rest. Scheduled timestamps are recorded as `pace` lines. */
export async function pacedSync(s: LiveSession, startIn = 3000): Promise<PaceLine[]> {
  show(liveLayout(1, `<div class="kicker">Step 2 · Breath sync · about 30 s</div>
    <div class="prompt">Follow the ring</div>
    <p class="lead">Breathe <b>in</b> as it grows, <b>out</b> as it shrinks, and rest while it holds. Stay silent. No keys needed.</p>
    <canvas id="c"></canvas>`, `<div class="card"><h3>Why this step</h3><p>STEADY times your breathing against this guide to measure the signal delay and your personal timing offset. It takes three breaths.</p></div>`),
  { camoff: () => { s.aborted = true; } });
  const CH = 440;
  const c = hidpi(document.getElementById('c') as HTMLCanvasElement, W, CH);
  const T = Date.now() + startIn;
  const pace: PaceLine[] = [];
  for (let i = 0; i < 3; i++) {
    const b = T + i * 10_000;
    pace.push({ k: 'pace', phase: 'in', t: b, dur: 4000 }, { k: 'pace', phase: 'out', t: b + 4000, dur: 4000 }, { k: 'pace', phase: 'rest', t: b + 8000, dur: 2000 });
  }
  pace.forEach((p) => s.add(p));
  const end = T + 30_000 + 3000; // + tail so delayed samples of the last cycle arrive
  const cx = W / 2, cy = 170;
  while (!s.aborted && Date.now() < end) {
    await new Promise(requestAnimationFrame);
    const now = Date.now();
    const p = pace.find((q) => now >= q.t && now < q.t + q.dur);
    const f = p ? (now - p.t) / p.dur : 0;
    const ease = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * x);
    const size = !p ? 0 : p.phase === 'in' ? ease(f) : p.phase === 'out' ? 1 - ease(f) : 0;
    const label = now < T ? 'Get ready' : !p ? 'Done, hold still…' : p.phase === 'in' ? 'Breathe in' : p.phase === 'out' ? 'Breathe out' : 'Rest';
    const secs = now < T ? Math.ceil((T - now) / 1000) : p ? Math.ceil((p.t + p.dur - now) / 1000) : 0;
    const rest = p?.phase === 'rest';
    c.fillStyle = COLORS.paper; c.fillRect(0, 0, W, CH);
    // guide rings, like a target face
    c.lineWidth = 1;
    for (let rr = 40; rr <= 160; rr += 20) {
      c.strokeStyle = rr % 40 === 0 ? 'rgba(21,24,27,0.18)' : 'rgba(21,24,27,0.08)';
      c.beginPath(); c.arc(cx, cy, rr, 0, Math.PI * 2); c.stroke();
    }
    const R = 40 + 120 * size;
    c.fillStyle = rest ? COLORS.pauseFill : 'rgba(217,72,15,0.16)';
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
    c.strokeStyle = rest ? COLORS.green : COLORS.accent; c.lineWidth = 4;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    c.fillStyle = COLORS.ink; c.textAlign = 'center'; c.textBaseline = 'middle';
    if (secs) { c.font = FONT.num(34); c.fillText(String(secs), cx, cy + 2); }
    c.font = FONT.display(48); c.textBaseline = 'alphabetic';
    c.fillStyle = rest ? COLORS.green : COLORS.ink;
    c.fillText(label.toUpperCase(), cx, cy + 222);
    // timeline: 3 × (in 4 s, out 4 s, rest 2 s)
    const tl = { x: cx - 330, y: 412, w: 660, h: 16 };
    const X = (t: number) => tl.x + ((t - T) / 30_000) * tl.w;
    for (const q of pace) {
      const xa = X(q.t), xb = X(q.t + q.dur);
      c.fillStyle = q.phase === 'rest' ? COLORS.pauseFill : q.phase === 'in' ? 'rgba(217,72,15,0.22)' : 'rgba(217,72,15,0.10)';
      c.fillRect(xa + 1, tl.y, xb - xa - 2, tl.h);
      if (now >= q.t) {
        c.fillStyle = q.phase === 'rest' ? COLORS.green : COLORS.accent;
        c.fillRect(xa + 1, tl.y, Math.min(xb, X(now)) - xa - 2 > 0 ? Math.min(xb, X(now)) - xa - 2 : 0, tl.h);
      }
    }
    c.font = FONT.display(13); c.fillStyle = COLORS.dim; c.textAlign = 'left';
    const cyc = pace.filter((q) => q.phase === 'in' && q.t <= now).length;
    c.fillText(`CYCLE ${Math.max(1, cyc)} OF 3`, tl.x, tl.y - 8);
    c.textAlign = 'right';
    c.fillText('IN · OUT · REST', tl.x + tl.w, tl.y - 8);
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

/** Dev-only autopilot for STEADY_PREVIEW: aims and fires so screens can be captured without a person. */
export type Bot = (o: { target: { x: number; y: number; t: number } | null; now: number; state: LiveState }) => { aim?: [number, number]; fire?: boolean };

/** One 60 s round. Fire = any key (except Esc) or mouse button. */
export async function playRound(s: LiveSession, type: RoundType, settings: Settings, pulseBase: number | null, bot?: Bot): Promise<boolean> {
  const cal = s.cal!;
  const guided = type === 'guided';
  const Ddisp = cal.D_p95_ms + 100;
  show(liveLayout(guided ? 2 : 3, '<canvas id="c" style="cursor:none"></canvas>', `<div class="card">
      <h3>${guided ? 'Guided round' : 'No-HUD round'}</h3>
      <p>${guided ? 'Fire when the crosshair settles in the green pause.' : 'No help this time: same sway, same scoring. Find the pause on your own.'}</p>
      <p class="keys">Aim with the mouse. <kbd>any key</kbd> or click fires. Stay silent.</p></div>
    ${guided ? `<div class="card tight"><div class="kicker">Hit marks</div>
      <div class="legend-col"><span class="chip dot green">In your pause ×1.0</span><span class="chip dot red">Mid-breath ×0.3</span><span class="chip dot grey">Not scored</span></div><div class="small dim" style="margin-top:6px">Not scored: talking or weak signal.</div></div>`
    : '<div class="card tight small">Hit marks stay neutral this round. Your breath timing for every shot is in the report.</div>'}
    <div class="small dim">${guided ? `Breathing is shown ${(Ddisp / 1000).toFixed(1)} s behind live. ` : ''}Scores are provisional until the round ends.</div>`),
  { camoff: () => { s.aborted = true; } });
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const c = hidpi(canvas, W, H);
  const field = H - HUD_H;
  const bg = fieldBackground(W, field);
  let mouse: [number, number] = [W / 2, field / 2];
  let offset: [number, number] = [0, 0];
  let target: { x: number; y: number; t: number } | null = null;
  let nextTarget = Date.now() + 1000;
  let elapsed = 0, last = Date.now();
  let flash = null as { x: number; y: number; tx: number; ty: number; color: string; state: LiveState; at: number } | null;
  const tally: string[] = [];
  const trail: [number, number][] = [];
  let wasNow = false;
  const t_start = Date.now();

  if (!bot) canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse = [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  });
  const fire = () => {
    const now = Date.now();
    if (!target || !s.signalOk()) return;
    const impact: [number, number] = [Math.round((mouse[0] + offset[0]) * 100) / 100, Math.round((mouse[1] + offset[1]) * 100) / 100];
    const judged = now + cal.L_ms;
    const live_state = s.det ? classifyAt(Math.min(judged, s.liveT()), s.det) : 'unknown'; // provisional
    const shot: ShotLine = {
      k: 'shot', t: now, round: type, t_target: target.t, target: [Math.round(target.x), Math.round(target.y)],
      mouse: [Math.round(mouse[0]), Math.round(mouse[1])], offset: [...offset], impact, t_disp: Math.round(now - Ddisp),
      accuracy: accuracy(impact, [target.x, target.y], TARGET_R), live_state,
    };
    s.add(shot);
    // No-HUD: neutral marks, the live state is not revealed during the round.
    const color = guided ? stateColor(live_state) : COLORS.ink;
    flash = { x: impact[0], y: impact[1], tx: target.x, ty: target.y, color, state: live_state, at: now };
    tally.push(color);
    target = null;
    nextTarget = now + 600;
  };
  const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape' && !e.repeat) fire(); };
  if (!bot) { // the preview autopilot ignores real input
    canvas.addEventListener('mousedown', fire);
    window.addEventListener('keydown', onKey);
  }

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
      const latest: LiveState = s.det ? classifyAt(s.liveT(), s.det) : 'unknown';
      if (bot) {
        const b = bot({ target, now, state: latest });
        if (b.aim) mouse = b.aim;
        if (b.fire) fire();
      }

      // field
      c.drawImage(bg, 0, 0, W, field);
      if (flash && now - flash.at < 900) {
        const a = 1 - Math.max(0, (now - flash.at - 500) / 400);
        drawTarget(c, flash.tx, flash.ty, TARGET_R, a);
        drawHole(c, flash.x, flash.y, flash.color, a);
        // label above the target, or below it near the top so it never sits under the NOW pill
        if (guided) pill(c, stateLabel(flash.state).toUpperCase(), flash.tx, flash.ty < 170 ? flash.ty + TARGET_R + 24 : flash.ty - TARGET_R - 22,
          { bg: flash.color, fg: '#fff', font: FONT.display(16), h: 26, padX: 12 });
      }
      if (target) {
        const age = now - target.t;
        drawTarget(c, target.x, target.y, TARGET_R, Math.min(1, age / 150), 0.9 + 0.1 * Math.min(1, age / 150));
        drawTimeArc(c, target.x, target.y, TARGET_R, 1 - age / TARGET_MS);
      }
      const cx = mouse[0] + offset[0], cy = mouse[1] + offset[1];
      trail.push([cx, cy]); if (trail.length > 16) trail.shift();
      c.fillStyle = COLORS.ink;
      trail.forEach(([x, y], i) => { c.globalAlpha = (i / trail.length) * 0.22; c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fill(); });
      c.globalAlpha = 1;
      drawCrosshair(c, cx, cy);

      // HUD: progress, timer, tally, settle
      const isNow = latest === 'pause';
      if (guided && isNow && !wasNow && settings.tick) beep();
      wasNow = isNow;
      c.fillStyle = 'rgba(21,24,27,0.1)'; c.fillRect(0, 0, W, 4);
      c.fillStyle = COLORS.accent; c.fillRect(0, 0, (W * elapsed) / ROUND_MS, 4);
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.fillStyle = COLORS.dim; c.font = FONT.display(13); c.fillText('TIME LEFT', 18, 28);
      c.fillStyle = COLORS.ink; c.font = FONT.num(36); c.fillText(`${Math.ceil((ROUND_MS - elapsed) / 1000)} s`, 18, 64);
      c.fillStyle = COLORS.dim; c.font = FONT.display(13); c.fillText('SHOTS', 112, 28);
      tally.slice(-14).forEach((col, i) => { c.fillStyle = col; c.beginPath(); c.arc(118 + i * 15, 50, 5, 0, Math.PI * 2); c.fill(); });
      if (pulseBase !== null && s.live.lastPulse !== null) {
        const elevated = s.live.lastPulse > pulseBase * 1.1;
        c.textAlign = 'right'; c.fillStyle = COLORS.dim; c.font = FONT.display(13); c.fillText('SETTLE', W - 18, 28);
        pill(c, elevated ? 'ELEVATED' : 'CALM', W - 18 - 44, 50, { bg: elevated ? COLORS.red : COLORS.green, fg: '#fff', font: FONT.display(16), h: 26, padX: 12 });
      }
      if (guided && isNow) {
        c.strokeStyle = COLORS.green; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, field - 6);
        pill(c, 'NOW', W / 2, 44, { bg: COLORS.green, fg: '#fff', font: FONT.display(36), h: 52, padX: 26 });
      }
      if (s.live.talking) pill(c, 'Stay silent: shots are not scored while you talk', W / 2, guided && isNow ? 100 : 44,
        { bg: COLORS.ink, fg: COLORS.onInk, font: FONT.body(16), h: 36, padX: 18 });

      // breathing strip. No-HUD hides the waveform too: the curve itself is a timing cue. Sway is the only feedback.
      if (guided) drawCurve(c, { x: 0, y: field, w: W, h: HUD_H }, s.det?.pts ?? [], tDisp - 12_000, tDisp,
        { pauses: s.det?.pauses, unknown: unknownIntervals(s.lines.slice(-200), cal.D_ms), label: 'Breathing', sublabel: 'green band = your pause · right edge = now', nowEdge: true });
      else {
        c.fillStyle = COLORS.paperDeep; c.fillRect(0, field, W, HUD_H);
        c.textAlign = 'center'; c.fillStyle = COLORS.ink2; c.font = FONT.display(20);
        c.fillText('NO-HUD ROUND', W / 2, field + 52);
        c.fillStyle = COLORS.dim; c.font = FONT.body(14, 500);
        c.fillText('No breathing curve, no green band, no NOW, no tick. Same sway, same scoring.', W / 2, field + 78);
      }
      c.fillStyle = COLORS.ink; c.fillRect(0, field, W, 1.5);
      if (!ok) {
        c.fillStyle = 'rgba(239,235,226,0.9)'; c.fillRect(0, 0, W, field);
        c.textAlign = 'center'; c.fillStyle = COLORS.ink; c.font = FONT.display(44);
        c.fillText('ROUND PAUSED', W / 2, field / 2 - 6);
        c.font = FONT.body(18); c.fillStyle = COLORS.ink2;
        c.fillText(s.live.hint || 'Waiting for a valid signal', W / 2, field / 2 + 28);
      }
    }
  } finally {
    window.removeEventListener('keydown', onKey);
  }
  s.add({ k: 'round', type, t_start, t_end: Date.now() });
  return !s.aborted;
}
