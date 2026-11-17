// Tiny DOM helpers and the preload API type.
export type Config = { hasKey: boolean; key: string; mode: 'app' | 'spike' | 'preview'; preview: string; sdkError: string; platform: string; dataDir: string };
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
  root().innerHTML = `<div class="screen">${html}</div>`;
  window.scrollTo(0, 0);
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

// ---- shared markup (styles in styles.css) ----

/** The STEADY mark: a reticle over a target ring. */
export const BRAND = `<div class="brand" aria-label="STEADY"><svg viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2"/>
  <circle cx="16" cy="16" r="6.5" fill="currentColor"/>
  <path d="M16 0v9M16 23v9M0 16h9M23 16h9" stroke="currentColor" stroke-width="2"/>
  <circle cx="16" cy="16" r="2.2" fill="#d9480f"/></svg>STEADY</div>`;

export const STEPS = ['Warm-up', 'Breath sync', 'Guided round', 'No-HUD round', 'Report'];
const steps = (on: number) => `<ol class="steps">${STEPS.map((s, i) =>
  `<li class="${i < on ? 'done' : i === on ? 'on' : ''}"><i>${i < on ? '✓' : i + 1}</i><span>${s}</span></li>`).join('')}</ol>`;

/** Header bar: brand, a title or the session steps, and right-hand actions. */
export const header = (o: { title?: string; step?: number; actions?: string }) => `<header class="header">${BRAND}
  ${o.step !== undefined ? steps(o.step) : o.title ? `<div class="title">${esc(o.title)}</div>` : ''}
  <div class="spacer"></div><div class="actions">${o.actions ?? ''}</div></header>`;

/** Content page: header + centred column. */
export const page = (body: string, o: { title?: string; actions?: string; cls?: string } = {}) => `${header(o)}<main class="page ${o.cls ?? ''}">${body}</main>`;

export const CAMOFF = '<span id="err"></span><button id="camoff" class="danger camoff">Camera off</button>';

/** Live-camera layout: stage on the left, rail on the right whose first slot sits under the webcam picture. */
export const liveLayout = (step: number, stage: string, rail = '') => `${header({ step, actions: CAMOFF })}
  <main class="live"><section class="stage">${stage}</section>
  <aside class="rail"><div class="pip-slot">Your camera picture shows here. Display only, never saved.</div>
  <div class="pip-note">Webcam picture: display only, never saved.</div>${rail}</aside></main>`;

export const stat = (label: string, value: string, sub = '') =>
  `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

/** Canvas sized in CSS px, backed at device resolution so lines stay crisp. */
export function hidpi(canvas: HTMLCanvasElement, w: number, h: number) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.aspectRatio = `${w} / ${h}`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
