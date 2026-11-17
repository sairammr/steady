// Canvas drawing shared by the live HUD, calibration and the report hero curve.
// Colours come from the CSS tokens in styles.css (:root), so canvas and DOM always match.
import type { Pause, Pt } from '../core/detector.ts';
import type { Interval, LiveState } from '../core/recording.ts';

const css = (name: string, fallback: string) =>
  (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

// Evaluated at load: the bundle runs after styles.css is applied (script at the end of <body>).
export const COLORS = {
  paper: css('--paper', '#efebe2'), paperDeep: css('--paper-deep', '#e4dfd2'), card: css('--card', '#faf8f3'),
  line: css('--line', '#d3ccbb'), lineStrong: css('--line-strong', '#a9a08b'), ink: css('--ink', '#15181b'),
  ink2: css('--ink-2', '#45443e'), dim: css('--ink-3', '#5f5b50'), accent: css('--accent', '#d9480f'),
  green: css('--pause', '#1b7340'), red: css('--breath', '#b8321f'), grey: css('--unknown', '#6d695f'),
  pauseFill: css('--pause-tint', 'rgba(27,115,64,0.17)'), greyFill: css('--unknown-tint', 'rgba(109,105,95,0.2)'), onInk: css('--on-ink', '#f6f3ec'),
};
export const FONT = {
  display: (px: number) => `700 ${px}px "DIN Condensed", "Barlow Condensed", "Arial Narrow", sans-serif`,
  num: (px: number) => `700 ${px}px "DIN Alternate", "DIN Condensed", "Barlow", sans-serif`,
  body: (px: number, w = 600) => `${w} ${px}px "Avenir Next", "Segoe UI", system-ui, sans-serif`,
};
export const stateColor = (s: LiveState) => (s === 'pause' ? COLORS.green : s === 'breath' ? COLORS.red : COLORS.grey);
export const stateLabel = (s: LiveState) => (s === 'pause' ? 'In your pause' : s === 'breath' ? 'Mid-breath' : 'Not scored');

export type Rect = { x: number; y: number; w: number; h: number };
export type Dot = { t: number; state: LiveState };

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Pill with text, centred on (cx, cy). */
export function pill(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, o: { bg: string; fg: string; font: string; padX?: number; h?: number }) {
  ctx.save();
  ctx.font = o.font;
  const w = ctx.measureText(text).width + 2 * (o.padX ?? 14), h = o.h ?? 30;
  ctx.fillStyle = o.bg;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = o.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 1);
  ctx.restore();
  return w;
}

/** Breath curve over [t0, t1] with optional pause shading, grey spans, shot dots, a time axis and a "now" edge. */
export function drawCurve(ctx: CanvasRenderingContext2D, r: Rect, pts: Pt[], t0: number, t1: number,
  opts: { pauses?: Pause[]; unknown?: Interval[]; dots?: Dot[]; label?: string; sublabel?: string; axis?: boolean; nowEdge?: boolean; bg?: string } = {}) {
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.fillStyle = opts.bg ?? COLORS.card;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const axisH = opts.axis ? 18 : 0;
  const plot = { x: r.x, y: r.y + 26, w: r.w, h: r.h - 26 - axisH - 6 };
  const X = (t: number) => r.x + ((t - t0) / (t1 - t0)) * r.w;
  // graph-paper grid: one line per second, heavier every 5 s
  const first = Math.ceil(t0 / 1000) * 1000;
  for (let t = first; t <= t1; t += 1000) {
    const x = Math.round(X(t)) + 0.5;
    ctx.strokeStyle = Math.round(t / 1000) % 5 === 0 ? 'rgba(21,24,27,0.10)' : 'rgba(21,24,27,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h - axisH); ctx.stroke();
  }
  const span = (a: number, b: number, fill: string, edge?: string) => {
    const xa = Math.max(r.x, X(a)), xb = Math.min(r.x + r.w, X(b));
    if (xb <= xa) return;
    ctx.fillStyle = fill; ctx.fillRect(xa, r.y, xb - xa, r.h - axisH);
    if (edge) { ctx.fillStyle = edge; ctx.fillRect(xa, r.y, xb - xa, 3); }
  };
  for (const p of opts.pauses ?? []) span(p.start, p.end, COLORS.pauseFill, COLORS.green);
  for (const [a, b] of opts.unknown ?? []) span(a, b, COLORS.greyFill, COLORS.grey);
  const vis = pts.filter((p) => p.t >= t0 - 500 && p.t <= t1 + 500);
  if (vis.length > 1) {
    let lo = Infinity, hi = -Infinity;
    for (const p of vis) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }
    const pad = (hi - lo) * 0.08 || 1;
    const Y = (x: number) => plot.y + plot.h - ((x - lo + pad) / (hi - lo + 2 * pad)) * plot.h;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    vis.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.x)) : ctx.moveTo(X(p.t), Y(p.x))));
    ctx.strokeStyle = COLORS.ink; ctx.lineWidth = 2.25;
    ctx.stroke();
    for (const d of opts.dots ?? []) {
      if (d.t < t0 || d.t > t1) continue;
      const near = vis.reduce((a, b) => (Math.abs(b.t - d.t) < Math.abs(a.t - d.t) ? b : a));
      const x = X(d.t), y = Y(near.x);
      ctx.strokeStyle = stateColor(d.state); ctx.lineWidth = 1.5; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, r.y + r.h - axisH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.card;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = stateColor(d.state);
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (opts.nowEdge) {
    const x = r.x + r.w - 1.5;
    ctx.fillStyle = COLORS.accent; ctx.fillRect(x - 1.5, r.y, 3, r.h);
  }
  if (opts.axis) {
    ctx.fillStyle = COLORS.dim; ctx.font = FONT.num(11); ctx.textBaseline = 'bottom';
    for (let s = 0; s * 1000 <= t1 - t0; s += 10) {
      const x = X(t0 + s * 1000);
      ctx.textAlign = s === 0 ? 'left' : 'center';
      ctx.fillText(`${s} s`, Math.min(x + (s === 0 ? 4 : 0), r.x + r.w - 14), r.y + r.h - 2);
    }
  }
  if (opts.label) {
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.ink; ctx.font = FONT.display(16);
    ctx.fillText(opts.label.toUpperCase(), r.x + 10, r.y + 20);
    if (opts.sublabel) {
      const w = ctx.measureText(opts.label.toUpperCase()).width;
      ctx.fillStyle = COLORS.dim; ctx.font = FONT.body(12, 500);
      ctx.fillText(opts.sublabel, r.x + 22 + w, r.y + 19);
    }
  }
  ctx.restore();
}

/** Pistol-style target face: white card, black aiming bull, ring lines. Scoring radius = R. */
export function drawTarget(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, alpha = 1, scale = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y); ctx.scale(scale, scale);
  ctx.shadowColor = 'rgba(21,24,27,0.25)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  ctx.fillStyle = COLORS.card;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = COLORS.ink;
  ctx.beginPath(); ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 1;
  for (let k = 1; k <= 10; k++) {
    const rr = (R * k) / 10;
    ctx.strokeStyle = rr <= R * 0.5 ? 'rgba(246,243,236,0.55)' : 'rgba(21,24,27,0.45)';
    ctx.beginPath(); ctx.arc(0, 0, rr - 0.5, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.strokeStyle = COLORS.ink; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

/** Time-left arc around a target (0..1 remaining). */
export function drawTimeArc(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, left: number) {
  ctx.save();
  ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(x, y, R + 8, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * left); ctx.stroke();
  ctx.restore();
}

/** Duplex scope reticle: thick outer posts, fine inner lines, lit centre dot. A paper halo keeps it readable on the black bull. */
export function drawCrosshair(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.lineCap = 'butt';
  const seg = (a: number, b: number, w: number, color: string) => {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x - b, y); ctx.lineTo(x - a, y); ctx.moveTo(x + a, y); ctx.lineTo(x + b, y);
    ctx.moveTo(x, y - b); ctx.lineTo(x, y - a); ctx.moveTo(x, y + a); ctx.lineTo(x, y + b);
    ctx.stroke();
  };
  seg(19, 40, 7, 'rgba(250,248,243,0.9)'); seg(5, 19, 4, 'rgba(250,248,243,0.9)');
  seg(20, 40, 4, COLORS.ink); seg(5, 20, 1.5, COLORS.ink);
  ctx.strokeStyle = 'rgba(250,248,243,0.9)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = COLORS.ink; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = COLORS.card;
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = COLORS.accent;
  ctx.beginPath(); ctx.arc(x, y, 2.75, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** Shot hole: dark pellet hole with a coloured ring (state colour in Guided, ink in No-HUD). */
export function drawHole(ctx: CanvasRenderingContext2D, x: number, y: number, ring: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = COLORS.card;
  ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = ring; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(x, y, 8.5, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = COLORS.ink;
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** Sighting-grid paper for the firing field, rendered once and blitted each frame. */
export function fieldBackground(w: number, h: number): HTMLCanvasElement {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  g.fillStyle = COLORS.paper; g.fillRect(0, 0, w, h);
  for (let x = 0; x <= w; x += 20) {
    g.fillStyle = x % 100 === 0 ? 'rgba(21,24,27,0.09)' : 'rgba(21,24,27,0.04)';
    g.fillRect(x, 0, 1, h);
  }
  for (let y = 0; y <= h; y += 20) {
    g.fillStyle = y % 100 === 0 ? 'rgba(21,24,27,0.09)' : 'rgba(21,24,27,0.04)';
    g.fillRect(0, y, w, 1);
  }
  return c;
}
