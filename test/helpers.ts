// Test helpers. Every trace built here is SYNTHETIC.
import fs from 'node:fs';
import { parseJsonl, type Line, type Sample } from '../src/core/recording.ts';

export const fixture = (name: string): Line[] => parseJsonl(fs.readFileSync(`test/fixtures/${name}.jsonl`, 'utf8'));

/** Minimal synthetic trace: inhale/exhale cosine ramps, flat pauses, optional hold, 30 Hz. */
export function simpleTrace(cycles: number, opts: { pause?: number; holdAfter?: number; holdMs?: number; noise?: number } = {}): { samples: Sample[]; pauses: [number, number][]; peaks: number[] } {
  const samples: Sample[] = [], pauses: [number, number][] = [], peaks: number[] = [];
  const segs: [string, number][] = [];
  for (let c = 0; c < cycles; c++) {
    segs.push(['in', 1800], ['top', 200], ['out', 2200]);
    segs.push(['flat', c === opts.holdAfter ? opts.holdMs ?? 8000 : opts.pause ?? 2000]);
  }
  let t = 0, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (const [kind, dur] of segs) {
    if (kind === 'flat') pauses.push([t, t + dur]);
    if (kind === 'top') peaks.push(t + dur / 2);
    for (let u = 0; u < dur; u += 1000 / 30) {
      const f = u / dur;
      const p = kind === 'in' ? 0.5 - 0.5 * Math.cos(Math.PI * f) : kind === 'out' ? 0.5 + 0.5 * Math.cos(Math.PI * f) : kind === 'top' ? 1 : 0;
      samples.push({ t: Math.round(t + u), v: p + (opts.noise ?? 0.01) * rnd(), s: true });
    }
    t += dur;
  }
  return { samples, pauses, peaks };
}
