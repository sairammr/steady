// Electron main process. Pattern from Presage's nodejs/samples/electron-quickstart:
// the SDK runs behind bindSmartSpectraIpc; the renderer builds the SDK and decodes metrics.
// New here: .env key loading, local storage (settings, sessions, recordings), replay file access.
import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { makeStorage } from './storage.ts';

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: missing-key screen */ }
const KEY = (process.env.PRESAGE_API_KEY ?? '').trim();
// Dev-only: STEADY_PREVIEW=<screen> renders one screen with SYNTHETIC data. No SDK, no camera, no key,
// and a throwaway userData folder so it never touches real settings or sessions.
const PREVIEW = process.env.STEADY_PREVIEW ?? '';
const MODE = PREVIEW ? 'preview' : process.env.STEADY_MODE === 'spike' ? 'spike' : 'app';
if (PREVIEW) app.setPath('userData', path.join(app.getPath('temp'), 'steady-preview'));

let bindSmartSpectraIpc: ((w: BrowserWindow) => void) | null = null;
let sdkError = '';
if (!PREVIEW) try {
  // Loads the native runtime; may fail on unsupported platforms. Replay still works without it.
  bindSmartSpectraIpc = require('@smartspectra/node-sdk/main').bindSmartSpectraIpc;
} catch (e) {
  sdkError = String((e as Error).message ?? e);
}

let store: ReturnType<typeof makeStorage>;

function registerIpc() {
  store = makeStorage(path.join(app.getPath('userData'), 'steady'), path.join(ROOT, 'recordings'), path.join(ROOT, 'test', 'fixtures'));
  ipcMain.handle('steady:config', () => ({
    hasKey: !PREVIEW && KEY.length > 0, key: PREVIEW ? '' : KEY, mode: MODE, preview: PREVIEW, sdkError, platform: `${process.platform}-${process.arch}`, dataDir: store.base,
  }));
  ipcMain.handle('steady:settings:get', () => store.getSettings());
  ipcMain.handle('steady:settings:set', (_e, s: unknown) => store.setSettings(s));
  ipcMain.handle('steady:rec:open', (_e, name: string, kind: 'session' | 'spike') => store.recOpen(name, kind));
  ipcMain.handle('steady:rec:append', (_e, file: string, text: string) => store.recAppend(file, text));
  ipcMain.handle('steady:session:save', (_e, id: string, json: string) => store.saveSession(id, json));
  ipcMain.handle('steady:session:list', () => store.listSessions());
  ipcMain.handle('steady:data:deleteAll', () => store.deleteAll());
  ipcMain.handle('steady:replay:list', () => store.replayList());
  ipcMain.handle('steady:replay:read', (_e, file: string) => store.replayRead(file));
  ipcMain.handle('steady:log', (_e, text: string) => { console.log(text); });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 720, useContentSize: true, minWidth: 1024, minHeight: 640, backgroundColor: '#f1ede4', title: MODE === 'spike' ? 'STEADY D1 spike' : 'STEADY',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), // bundles @smartspectra/node-sdk/preload + our bridge
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: !process.env.STEADY_SNAPSHOT,
    },
  });
  if (bindSmartSpectraIpc && !PREVIEW) bindSmartSpectraIpc(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(ROOT, 'index.html'));
  if (process.env.SMARTSPECTRA_DIAGNOSTICS === '1') win.webContents.openDevTools({ mode: 'detach' });
  // Dev check: STEADY_SNAPSHOT=out.png saves a screenshot of the UI (not the camera) and prints the screen text.
  const snap = process.env.STEADY_SNAPSHOT;
  // STEADY_SNAPSHOT_CLICKS="replay,f2" clicks those element ids first (2 s apart);
  // STEADY_SNAPSHOT_WAIT=ms changes the initial wait (default 2500).
  if (snap) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    for (const id of (process.env.STEADY_SNAPSHOT_CLICKS ?? '').split(',').filter(Boolean)) {
      await win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)})?.click()`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    win.webContents.invalidate(); // occluded windows may not repaint on their own
    await new Promise((r) => setTimeout(r, 500));
    // Never capture while the webcam picture is on screen: no camera frame may reach the disk.
    const camOnScreen = await win.webContents.executeJavaScript(`!!document.getElementById('pip')`);
    if (!camOnScreen) fs.writeFileSync(snap, (await win.webContents.capturePage()).toPNG());
    console.log('[snapshot]', await win.webContents.executeJavaScript('document.body.innerText'));
    if (PREVIEW) app.quit();
  }, Number(process.env.STEADY_SNAPSHOT_WAIT) || 2500));
}

app.whenReady().then(() => {
  // Camera only (no mic), only for our bundled page.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = (details && (details as { requestingUrl?: string }).requestingUrl) || wc?.getURL() || '';
    const media = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    cb(!PREVIEW && permission === 'media' && media.length === 1 && media[0] === 'video' && url.startsWith('file://'));
  });
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
