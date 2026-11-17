// Electron main process. Pattern from Presage's nodejs/samples/electron-quickstart:
// the SDK runs behind bindSmartSpectraIpc; the renderer builds the SDK and decodes metrics.
// New here: .env key loading, local storage (settings, sessions, recordings), replay file access.
import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, ipcMain, session } from 'electron';

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: missing-key screen */ }
const KEY = (process.env.PRESAGE_API_KEY ?? '').trim();
const MODE = process.env.STEADY_MODE === 'spike' ? 'spike' : 'app';

let bindSmartSpectraIpc: ((w: BrowserWindow) => void) | null = null;
let sdkError = '';
try {
  // Loads the native runtime; may fail on unsupported platforms. Replay still works without it.
  bindSmartSpectraIpc = require('@smartspectra/node-sdk/main').bindSmartSpectraIpc;
} catch (e) {
  sdkError = String((e as Error).message ?? e);
}

const dataDir = () => path.join(app.getPath('userData'), 'steady');
const sessionsDir = () => path.join(dataDir(), 'sessions');
const userRecDir = () => path.join(dataDir(), 'recordings');
const devRecDir = path.join(ROOT, 'recordings');
const fixturesDir = path.join(ROOT, 'test', 'fixtures');
const settingsFile = () => path.join(dataDir(), 'settings.json');

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

const openRecordings = new Map<string, string>();
const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

function listJsonl(dir: string, source: string) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
      .map((f) => ({ name: f, path: path.join(dir, f), source, synthetic: f.startsWith('synthetic-') }));
  } catch { return []; }
}
const replayable = () => [
  ...listJsonl(userRecDir(), 'your sessions'),
  ...listJsonl(devRecDir, 'dev recordings'),
  ...listJsonl(fixturesDir, 'synthetic test fixtures'),
];

function registerIpc() {
  ipcMain.handle('steady:config', () => ({
    hasKey: KEY.length > 0, key: KEY, mode: MODE, sdkError, platform: `${process.platform}-${process.arch}`, dataDir: dataDir(),
  }));
  ipcMain.handle('steady:settings:get', () => readJson(settingsFile(), { consent: false, tick: true }));
  ipcMain.handle('steady:settings:set', (_e, s: unknown) => {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  });
  // Recordings hold raw signal values only (JSONL). No frame or image is ever passed here.
  ipcMain.handle('steady:rec:open', (_e, name: string, kind: 'session' | 'spike') => {
    const dir = kind === 'spike' ? devRecDir : userRecDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeName(name) + '.jsonl');
    openRecordings.set(file, file);
    return file;
  });
  ipcMain.handle('steady:rec:append', (_e, file: string, text: string) => {
    if (!openRecordings.has(file)) throw new Error('recording not open');
    fs.appendFileSync(file, text);
  });
  ipcMain.handle('steady:session:save', (_e, id: string, json: string) => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), safeName(id) + '.json'), json);
  });
  ipcMain.handle('steady:session:list', () => {
    try {
      return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json')).sort().slice(-10)
        .map((f) => readJson(path.join(sessionsDir(), f), null)).filter(Boolean);
    } catch { return []; }
  });
  ipcMain.handle('steady:data:deleteAll', () => {
    for (const dir of [sessionsDir(), userRecDir()]) fs.rmSync(dir, { recursive: true, force: true });
    openRecordings.clear();
    return { sessions: fs.existsSync(sessionsDir()), recordings: fs.existsSync(userRecDir()) };
  });
  ipcMain.handle('steady:replay:list', () => replayable());
  ipcMain.handle('steady:replay:read', (_e, file: string) => {
    // Trust boundary: only files we listed ourselves can be read.
    if (!replayable().some((r) => r.path === file)) throw new Error('not a replayable file');
    return fs.readFileSync(file, 'utf8');
  });
  ipcMain.handle('steady:log', (_e, text: string) => { console.log(text); });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, backgroundColor: '#0e1014', title: MODE === 'spike' ? 'STEADY D1 spike' : 'STEADY',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), // bundles @smartspectra/node-sdk/preload + our bridge
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  if (bindSmartSpectraIpc) bindSmartSpectraIpc(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(ROOT, 'index.html'));
  if (process.env.SMARTSPECTRA_DIAGNOSTICS === '1') win.webContents.openDevTools({ mode: 'detach' });
  // Dev check: STEADY_SNAPSHOT=out.png saves a screenshot of the UI (not the camera) and prints the screen text.
  const snap = process.env.STEADY_SNAPSHOT;
  if (snap) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    fs.writeFileSync(snap, (await win.webContents.capturePage()).toPNG());
    console.log('[snapshot]', await win.webContents.executeJavaScript('document.body.innerText'));
  }, 2500));
}

app.whenReady().then(() => {
  // Camera only (no mic), only for our bundled page.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = (details && (details as { requestingUrl?: string }).requestingUrl) || wc?.getURL() || '';
    const media = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    cb(permission === 'media' && media.length === 1 && media[0] === 'video' && url.startsWith('file://'));
  });
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
