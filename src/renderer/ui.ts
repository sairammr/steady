// Tiny DOM helpers and the preload API type.
export type Config = { hasKey: boolean; key: string; mode: 'app' | 'spike'; sdkError: string; platform: string; dataDir: string };
export type Settings = { consent: boolean; consentAt?: string; tick: boolean };
export type ReplayFile = { name: string; path: string; source: string; synthetic: boolean };
export type SteadyApi = {
  config(): Promise<Config>;
  getSettings(): Promise<Settings>;
  setSettings(s: Settings): Promise<void>;
  recOpen(name: string, kind: 'session' | 'spike'): Promise<string>;
  recAppend(file: string, text: string): Promise<void>;
  saveSession(id: string, json: string): Promise<void>;
  listSessions(): Promise<any[]>;
  deleteAll(): Promise<{ sessions: boolean; recordings: boolean }>;
  replayList(): Promise<ReplayFile[]>;
  replayRead(path: string): Promise<string>;
  log(text: string): Promise<void>;
};
declare global { interface Window { steady: SteadyApi } }
export const api = () => window.steady;

export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const root = () => document.getElementById('app')!;

/** Replace the screen; `on` maps element ids to click handlers. */
export function show(html: string, on: Record<string, () => void> = {}) {
  root().innerHTML = html;
  for (const [id, fn] of Object.entries(on)) document.getElementById(id)?.addEventListener('click', fn);
}

export function pip(stream: MediaStream | null) {
  let v = document.getElementById('pip') as HTMLVideoElement | null;
  if (!stream) { v?.remove(); return; }
  if (!v) {
    v = document.createElement('video');
    v.id = 'pip'; v.muted = true; v.autoplay = true; v.playsInline = true;
    document.body.appendChild(v);
  }
  v.srcObject = stream; // display only: frames are never read, copied or written anywhere
  v.play().catch(() => {});
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function beep() {
  try {
    const a = new AudioContext();
    const o = a.createOscillator(), g = a.createGain();
    o.frequency.value = 880; g.gain.value = 0.05;
    o.connect(g).connect(a.destination);
    o.start(); o.stop(a.currentTime + 0.05);
    o.onended = () => a.close();
  } catch { /* audio unavailable */ }
}
