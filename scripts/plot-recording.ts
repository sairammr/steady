// npm run plot -- <recording.jsonl> [out.svg]
// Renders the oriented trace (inhale = up) with detected pause windows (green), unknown spans (grey),
// non-stable samples (orange tick) and protocol marks, 30 s per row. View: qlmanage -t -s 2400 -o <dir> out.svg
import fs from 'node:fs';
import { calibrationFor } from '../src/core/calibration.ts';
import { detect } from '../src/core/detector.ts';
import { buildTrace, ofKind, parseJsonl, quantile, unknownIntervals } from '../src/core/recording.ts';
import { breathOffset, MAX_OFFSET_PX } from '../src/core/sway.ts';

const [file, out = 'plot.svg'] = process.argv.slice(2);
if (!file) { console.error('usage: npm run plot -- <recording.jsonl> [out.svg]'); process.exit(2); }
const lines = parseJsonl(fs.readFileSync(file, 'utf8'));
const cal = calibrationFor(lines);
const { samples } = buildTrace(lines);
const unknown = unknownIntervals(lines, cal.clock_ms);
const det = detect(samples, cal, unknown);
const toS = (wall: number) => wall - cal.clock_ms; // wall-clock mark → sample clock

const ROW_MS = 30_000, W = 2400, PAD = 40;
const t0 = samples[0].t, tN = samples.at(-1)!.t;
const rows = Math.ceil((tN - t0) / ROW_MS);
const RH = Math.floor((W - 30) / rows); // square canvas: qlmanage -t crops to a square thumbnail
const xs = det.pts.map((p) => p.x);
const lo = Math.min(...xs), hi = Math.max(...xs);
const X = (t: number) => PAD + ((t - t0) % ROW_MS) / ROW_MS * (W - 2 * PAD);
const Y = (r: number, v: number) => r * RH + RH - 30 - (v - lo) / (hi - lo) * (RH - 60);
const row = (t: number) => Math.floor((t - t0) / ROW_MS);
const svg: string[] = [];
/** Shade [a,b] (sample clock), split across rows. */
const band = (a: number, b: number, fill: string, y0 = 0, h = RH - 20) => {
  for (let s = Math.max(a, t0); s < Math.min(b, tN); ) {
    const r = row(s), e = Math.min(b, t0 + (r + 1) * ROW_MS);
    svg.push(`<rect x="${X(s).toFixed(1)}" y="${r * RH + y0}" width="${Math.max(1, X(e - 0.001) - X(s)).toFixed(1)}" height="${h}" fill="${fill}"/>`);
    s = e;
  }
};
for (const [a, b] of unknown) band(a, b, '#cccccc');
for (const p of det.pauses) band(p.start, p.end, p.closedBy === 'timeout' ? '#f5c242' : '#7ed687');
const marks = ofKind(lines, 'mark');
for (const m of marks) {
  if (!/_(start|end)$/.test(m.name)) continue;
  const t = toS(m.t);
  if (t < t0 || t > tN) continue;
  const r = row(t);
  svg.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${r * RH}" y2="${r * RH + RH - 20}" stroke="#d33" stroke-dasharray="4 3"/>`,
    `<text x="${X(t) + 3}" y="${r * RH + 14}" font-size="14" fill="#d33">${m.name}</text>`);
}
for (const p of ofKind(lines, 'pace')) band(toS(p.t), toS(p.t) + p.dur, p.phase === 'in' ? 'rgba(80,120,255,0.18)' : 'rgba(0,0,0,0)', RH - 40, 14);
for (const s of samples) if (!s.s) band(s.t, s.t + 34, '#f39c12', RH - 24, 4);
for (let r = 0; r < rows; r++) {
  const pts = det.pts.filter((p) => row(p.t) === r);
  svg.push(`<polyline fill="none" stroke="#123" stroke-width="2" points="${pts.map((p) => `${X(p.t).toFixed(1)},${Y(r, p.x).toFixed(1)}`).join(' ')}"/>`);
  for (let s = 0; s <= 30; s += 5) svg.push(`<text x="${X(t0 + r * ROW_MS + s * 1000 - (s === 30 ? 1 : 0))}" y="${r * RH + RH - 4}" font-size="12" fill="#555">${r * 30 + s}s</text>`);
}
for (const t of det.troughs) { const r = row(t); svg.push(`<circle cx="${X(t)}" cy="${r * RH + RH - 32}" r="3" fill="#06c"/>`); }
const title = `${file.split('/').pop()} · orient ${cal.orient} (${cal.orient_by}) · A ${cal.A} · pauses ${det.pauses.length} · unknown ${unknown.length} · green=pause yellow=timeout grey=unknown orange=!stable blue=paced inhale`;
fs.writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${rows * RH + 30}" viewBox="0 -30 ${W} ${rows * RH + 30}">
<rect x="0" y="-30" width="${W}" height="${rows * RH + 30}" fill="#fff"/><text x="${PAD}" y="-10" font-size="16">${title}</text>
${svg.join('\n')}
</svg>\n`);
console.log(`wrote ${out}: ${det.pauses.length} pauses, ${unknown.length} unknown spans`);

// Sway check (PRD §8): position-based vertical offset should be ~0 in pauses, large mid-breath.
const dy = (p: (typeof det.pts)[number]) => Math.abs(breathOffset(p.x, p.trough, p.A)[1]);
const inPause = (p: (typeof det.pts)[number]) => det.pauses.some((w) => p.t >= w.start && p.t < w.end);
const groups: [string, (p: (typeof det.pts)[number]) => boolean][] = [
  ['in pause window', inPause], ['mid-breath |slope|>0.5A/s', (p) => Math.abs(p.slope) > 0.5 * p.A], ['all valid', () => true]];
console.log(`sway |dy| px (max ${MAX_OFFSET_PX})   n   p10  median   p90`);
for (const [name, f] of groups) {
  const v = det.pts.filter((p) => p.ok && f(p)).map(dy);
  console.log(`${name.padEnd(26)}${String(v.length).padStart(6)}${[0.1, 0.5, 0.9].map((q) => quantile(v, q).toFixed(1).padStart(7)).join('')}`);
}
