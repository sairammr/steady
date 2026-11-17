import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSpike, summarizeSpike } from '../src/core/spike.ts';
import type { Line, MLine } from '../src/core/recording.ts';
import { fixture } from './helpers.ts';

test('summarises the SYNTHETIC D1 protocol recording and says GO', () => {
  const s = summarizeSpike(fixture('synthetic-spike'));
  assert.equal(s.synthetic, true);
  assert.ok(Math.abs(s.cadence_ms - 500) < 30);
  assert.ok(Math.abs(s.sample_rate_hz - 30) < 1);
  assert.equal(s.holds.length, 3);
  assert.ok(s.holds_ok);
  assert.ok(s.talking_flagged_in_segment! > 0.5 && s.talking_false_positive! < 0.1);
  assert.equal(s.L_ms !== null && Math.abs(s.L_ms - 400) <= 60, true);
  assert.match(s.time_unit, /epoch-aligned/);
  assert.equal(s.verdict, 'go');
  assert.match(formatSpike(s), /SYNTHETIC/);
});

test('verdict degrades on slow delivery and is no-go on huge delay', () => {
  // delay hits 3 of every 4 events; the 4th arrives promptly, so D (jitter above the fastest) ≈ delay
  const slow = (cadence: number, delay: number, every = false): Line[] => {
    const out: Line[] = [{ k: 'meta', v: 1, sdk: 'x', t0_wall: 0, sdk_time_unit: 'ms', cal: null }];
    for (let i = 1; i <= 40; i++) {
      const upper = Array.from({ length: 5 }, (_, j) => ({ t: i * cadence - (5 - j) * 50, v: Math.sin(i + j), s: true }));
      out.push({ k: 'm', t_arr: i * cadence + (every || i % 4 ? delay : 0), upper, rate: null, pulse: null, talking: false, valid: true } as MLine);
    }
    return out;
  };
  assert.equal(summarizeSpike(slow(1500, 100)).verdict, 'degrade');
  assert.equal(summarizeSpike(slow(500, 2000)).verdict, 'degrade');
  assert.equal(summarizeSpike(slow(500, 4000)).verdict, 'no-go');
  assert.equal(summarizeSpike(slow(500, 100)).verdict, 'go');
  // a constant offset is indistinguishable from the SDK clock anchor: not a delay
  const constant = summarizeSpike(slow(500, 4000, true));
  assert.equal(constant.verdict, 'go');
  assert.ok(constant.D_ms < 300 && constant.clock_ms > 4000);
});
