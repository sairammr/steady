import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeStorage } from '../src/main/storage.ts';

test('delete all removes every session summary and raw recording (directory empty)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-'));
  const st = makeStorage(base, path.join(base, 'dev'), 'test/fixtures');
  st.setSettings({ consent: true, tick: true });
  const f = st.recOpen('session-1', 'session');
  st.recAppend(f, '{"k":"meta"}\n');
  st.saveSession('S1', '{}');
  assert.equal(st.listSessions().length, 1);
  assert.deepEqual(st.deleteAll(), { sessions: false, recordings: false });
  assert.deepEqual(fs.readdirSync(base), ['settings.json'], 'only settings remain');
  assert.throws(() => st.recAppend(f, 'x'), /not open/);
  fs.rmSync(base, { recursive: true });
});

test('replay can only read files it listed', () => {
  const st = makeStorage(fs.mkdtempSync(path.join(os.tmpdir(), 'steady-')), '/nonexistent', 'test/fixtures');
  const list = st.replayList();
  assert.ok(list.every((r) => r.synthetic));
  assert.ok(st.replayRead(list[0].path).startsWith('{"k":"meta"'));
  assert.throws(() => st.replayRead('/etc/passwd'), /not a replayable/);
});
