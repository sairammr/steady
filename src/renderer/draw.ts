// Canvas drawing shared by the live HUD and the report hero curve.
import type { Pause, Pt } from '../core/detector.ts';
import type { Interval, LiveState } from '../core/recording.ts';

export const COLORS = { green: '#3ecf7a', red: '#ef5b5b', grey: '#6b7080', ink: '#e8eaf0', dim: '#8b91a3', pauseFill: 'rgba(62,207,122,0.18)', greyFill: 'rgba(120,120,135,0.25)' };
export const stateColor = (s: LiveState) => (s === 'pause' ? COLORS.green : s === 'breath' ? COLORS.red : COLORS.grey);

export type Rect = { x: number; y: number; w: number; h: number };
export type Dot = { t: number; state: LiveState };

/** Breath curve over [t0, t1] with optional pause shading, grey spans and shot dots. */
export function drawCurve(ctx: CanvasRenderingContext2D, r: Rect, pts: Pt[], t0: number, t1: number,
  opts: { pauses?: Pause[]; unknown?: Interval[]; dots?: Dot[]; label?: string } = {}) {
  ctx.save();
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const X = (t: number) => r.x + ((t - t0) / (t1 - t0)) * r.w;
  const span = (a: number, b: number, fill: string) => {
    const xa = Math.max(r.x, X(a)), xb = Math.min(r.x + r.w, X(b));
    if (xb > xa) { ctx.fillStyle = fill; ctx.fillRect(xa, r.y, xb - xa, r.h); }
  };
  for (const p of opts.pauses ?? []) span(p.start, p.end, COLORS.pauseFill);
  for (const [a, b] of opts.unknown ?? []) span(a, b, COLORS.greyFill);
  const vis = pts.filter((p) => p.t >= t0 && p.t <= t1);
  if (vis.length > 1) {
    let lo = Infinity, hi = -Infinity;
    for (const p of vis) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }
    const pad = (hi - lo) * 0.1 || 1;
    const Y = (x: number) => r.y + r.h - ((x - lo + pad) / (hi - lo + 2 * pad)) * r.h;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    vis.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.x)) : ctx.moveTo(X(p.t), Y(p.x))));
    ctx.stroke();
    for (const d of opts.dots ?? []) {
      if (d.t < t0 || d.t > t1) continue;
      const near = vis.reduce((a, b) => (Math.abs(b.t - d.t) < Math.abs(a.t - d.t) ? b : a));
      ctx.fillStyle = stateColor(d.state);
      ctx.beginPath();
      ctx.arc(X(d.t), Y(near.x), 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  if (opts.label) {
    ctx.fillStyle = COLORS.dim;
    ctx.font = '13px system-ui';
    ctx.fillText(opts.label, r.x + 8, r.y + 16);
  }
  ctx.restore();
}

export function drawTarget(ctx: CanvasRenderingContext2D, x: number, y: number, R: number) {
  for (const [f, c] of [[1, '#c94a4a'], [0.66, '#eee'], [0.33, '#c94a4a']] as const) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, R * f, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawCrosshair(ctx: CanvasRenderingContext2D, x: number, y: number, color = '#f2c14e') {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.moveTo(x - 24, y); ctx.lineTo(x - 6, y);
  ctx.moveTo(x + 6, y); ctx.lineTo(x + 24, y);
  ctx.moveTo(x, y - 24); ctx.lineTo(x, y - 6);
  ctx.moveTo(x, y + 6); ctx.lineTo(x, y + 24);
  ctx.stroke();
  ctx.restore();
}
