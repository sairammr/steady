import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrace, parseJsonl, Recorder, toJsonl, unknownIntervals, type Line, type MetaLine } from '../src/core/recording.ts';

const meta: MetaLine = { k: 'meta', v: 1, sdk: 'test', t0_wall: 0, sdk_time_unit: 'ms', cal: null, synthetic: true };

test('recorder buffers until begin(meta) so meta is the first line', () => {
  let out = '';
  const r = new Recorder((t) => { out += t; });
  r.push({ k: 'mark', name: 'a', t: 1 });
  assert.equal(out, '');
  r.begin(meta);
  r.push({ k: 'mark', name: 'b', t: 2 });
  const lines = parseJsonl(out);
  assert.deepEqual(lines.map((l) => l.k), ['meta', 'mark', 'mark']);
  assert.equal(toJsonl(lines), out);
});

test('parse rejects bad lines with a line number', () => {
  assert.throws(() => parseJsonl('{"k":"meta"}\nnope'), /line 2/);
  assert.throws(() => parseJsonl('{"x":1}'), /line 1/);
});

test('revisions: the latest delivery of a timestamp wins and flips are counted', () => {
  const lines: Line[] = [
    { k: 'm', t_arr: 100, upper: [{ t: 1, v: 1, s: false }, { t: 2, v: 2, s: false }], rate: null, pulse: null, talking: false, valid: true },
    { k: 'm', t_arr: 200, upper: [{ t: 2, v: 2.5, s: true }, { t: 3, v: 3, s: true }], rate: null, pulse: null, talking: false, valid: true },
  ];
  const tr = buildTrace(lines);
  assert.deepEqual(tr.samples.map((s) => s.v), [1, 2.5, 3]);
  assert.equal(tr.revisions, 1);
  assert.equal(tr.stableFlips, 1);
});

test('talking and invalid events become merged unknown spans with a 2 s talking hold-off', () => {
  const m = (t_arr: number, talking: boolean, valid = true): Line => ({ k: 'm', t_arr, upper: [], rate: null, pulse: null, talking, valid });
  const ivs = unknownIntervals([m(1000, false), m(1500, true), m(2000, true), m(2500, false), m(8500, false), m(9000, false, false), m(9500, false)], 300);
  assert.deepEqual(ivs, [[700, 3700], [8200, 8700]]);
});
