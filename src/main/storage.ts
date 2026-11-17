// Local storage (no Electron imports, so it is unit-testable). Everything lives under `base`
// except dev spike recordings (repo recordings/, gitignored) and the bundled synthetic fixtures.
import fs from 'node:fs';
import path from 'node:path';

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');
function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function listJsonl(dir: string, source: string) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
      .map((f) => ({ name: f, path: path.join(dir, f), source, synthetic: f.startsWith('synthetic-') }));
  } catch { return []; }
}

export function makeStorage(base: string, devRecDir: string, fixturesDir: string) {
  const sessionsDir = path.join(base, 'sessions');
  const recDir = path.join(base, 'recordings');
  const settingsFile = path.join(base, 'settings.json');
  const open = new Set<string>();
  const replayable = () => [
    ...listJsonl(recDir, 'your sessions'), ...listJsonl(devRecDir, 'dev recordings'), ...listJsonl(fixturesDir, 'synthetic test fixtures'),
  ];
  return {
    base,
    getSettings: () => readJson(settingsFile, { consent: false, tick: true }),
    setSettings(s: unknown) { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); },
    // Recordings hold raw signal values only (JSONL). No frame or image is ever passed here.
    recOpen(name: string, kind: 'session' | 'spike') {
      const dir = kind === 'spike' ? devRecDir : recDir;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, safeName(name) + '.jsonl');
      open.add(file);
      return file;
    },
    recAppend(file: string, text: string) {
      if (!open.has(file)) throw new Error('recording not open');
      fs.appendFileSync(file, text);
    },
    saveSession(id: string, json: string) {
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, safeName(id) + '.json'), json);
    },
    listSessions() {
      try {
        return fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).sort().slice(-10)
          .map((f) => readJson(path.join(sessionsDir, f), null)).filter(Boolean);
      } catch { return []; }
    },
    /** Removes every session summary and every raw recording of the app user. */
    deleteAll() {
      for (const dir of [sessionsDir, recDir]) fs.rmSync(dir, { recursive: true, force: true });
      open.clear();
      return { sessions: fs.existsSync(sessionsDir), recordings: fs.existsSync(recDir) };
    },
    replayList: replayable,
    replayRead(file: string) {
      // Trust boundary: only files we listed ourselves can be read.
      if (!replayable().some((r) => r.path === file)) throw new Error('not a replayable file');
      return fs.readFileSync(file, 'utf8');
    },
  };
}
