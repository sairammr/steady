import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accuracy, breathOffset, MAX_OFFSET_PX, swayOffset, tremor } from '../src/core/sway.ts';
import { ofKind } from '../src/core/recording.ts';
import { fixture } from './helpers.ts';

test('breath offset is zero at the trough and maximal at full inhale', () => {
  assert.deepEqual(breathOffset(2, 2, 1), [0, 0]);
  const [dx, dy] = breathOffset(3, 2, 1);
  assert.equal(dy, -MAX_OFFSET_PX);
  assert.ok(Math.abs(dx) < Math.abs(dy), 'mostly vertical');
  assert.deepEqual(breathOffset(5, 2, 1), breathOffset(3, 2, 1), 'clamped above');
  assert.deepEqual(breathOffset(1, 2, 1), [0, 0], 'clamped below');
  const half = breathOffset(2.5, 2, 1)[1];
  assert.ok(half < 0 && half > -MAX_OFFSET_PX);
});

test('sway = breath offset + deterministic tremor', () => {
  const t = 12345;
  const s = swayOffset(2, 2, 1, t);
  assert.deepEqual(s, tremor(t));
  assert.deepEqual(swayOffset(2.7, 2, 1, t), swayOffset(2.7, 2, 1, t));
});

test('accuracy falls with distance; recorded impact = mouse + offset', () => {
  assert.equal(accuracy([10, 10], [10, 10], 60), 100);
  assert.equal(accuracy([40, 10], [10, 10], 60), 50);
  assert.equal(accuracy([200, 10], [10, 10], 60), 0);
  for (const s of ofKind(fixture('synthetic-clean'), 'shot')) {
    assert.ok(Math.abs(s.impact[0] - (s.mouse[0] + s.offset[0])) < 0.011);
    assert.ok(Math.abs(s.impact[1] - (s.mouse[1] + s.offset[1])) < 0.011);
  }
});
