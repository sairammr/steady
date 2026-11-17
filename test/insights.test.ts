import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickInsight, type ScoredShot } from '../src/core/insights.ts';

const shot = (state: ScoredShot['state'], dtTarget = 2000, after_timeout = false): ScoredShot =>
  ({ t: 10000, t_target: 10000 - dtTarget, round: 'guided', state, after_timeout });
const none = { guided: null, nohud: null };

test('grey-dominant session asks for a better signal first', () => {
  assert.equal(pickInsight([shot('unknown'), shot('unknown'), shot('pause')], none).id, 'signal');
});
test('rushed red shots (<500 ms after target) → wait one breath', () => {
  const i = pickInsight([shot('breath', 300), shot('breath', 400), shot('pause')], none);
  assert.equal(i.id, 'rushed');
  assert.match(i.text, /Wait one breath/);
});
test('shots after a 5 s timeout → breathe again', () => {
  assert.equal(pickInsight([shot('breath', 2000, true), shot('breath', 2000, true), shot('pause'), shot('pause'), shot('pause')], none).id, 'held');
});
test('big Guided → No-HUD drop', () => {
  assert.equal(pickInsight([shot('pause'), shot('pause')], { guided: 80, nohud: 50 }).id, 'hud-drop');
});
test('mostly mid-breath, and the praise fallback', () => {
  assert.equal(pickInsight([shot('breath'), shot('breath'), shot('pause')], none).id, 'mid-breath');
  assert.equal(pickInsight([shot('pause'), shot('pause'), shot('breath')], none).id, 'steady');
});
