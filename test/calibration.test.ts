import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreement, estimateCalibration, onsetOffset } from '../src/core/calibration.ts';
import { FIXTURES } from '../src/core/synth.ts';
import { fixture } from './helpers.ts';

const names = ['synthetic-clean', 'synthetic-talking', 'synthetic-slow'];

test('recovers orientation, L (±60 ms) and D on synthetic recordings', () => {
  for (const n of names) {
    const o = FIXTURES[n];
    const c = estimateCalibration(fixture(n));
    assert.equal(c.orient, o.orient, n);
    assert.ok(Math.abs(c.L_ms - (o.userLag + o.filterDelay)) <= 60, `${n}: L ${c.L_ms} vs truth ${o.userLag + o.filterDelay}`);
    const dTruth = o.cadence / 2 + o.procDelay + o.jitter / 2;
    assert.ok(Math.abs(c.D_ms - dTruth) <= 60, `${n}: D ${c.D_ms} vs ~${dTruth}`);
    assert.ok(c.D_p95_ms >= c.D_ms);
    assert.ok(Math.abs(c.A - o.amp) / o.amp < 0.1, `${n}: A ${c.A}`);
  }
});

test('meta.cal written into each fixture matches a fresh estimate', () => {
  for (const n of names) {
    const lines = fixture(n);
    const { lags: _l, r: _r, ...fresh } = estimateCalibration(lines);
    assert.deepEqual((lines[0] as { cal: unknown }).cal, fresh);
  }
});

test('detector agreement on held-out synthetic recordings (PRD §12 metric)', () => {
  let hits = 0, n = 0;
  // same simulated user (pacer-following lag) across 3 recordings; slow fixture is a different user
  const same = ['synthetic-clean', 'synthetic-talking', 'synthetic-spike'];
  for (const calName of same) {
    const calLines = fixture(calName);
    const { lags: _l, r: _r, ...cal } = estimateCalibration(calLines);
    const off = onsetOffset(calLines, cal);
    for (const held of same.filter((x) => x !== calName)) {
      const a = agreement(fixture(held), cal, off);
      hits += a.hits; n += a.n;
    }
  }
  console.log(`# SYNTHETIC agreement: ${hits}/${n} paced inhales within ±500 ms (${Math.round((100 * hits) / n)}%)`);
  assert.ok(n >= 3 && hits / n >= 0.8);
});
