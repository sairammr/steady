// Renderer entry: screen routing. Screens: missing-key, consent, home, calibration + rounds
// (game.ts), report, settings, replay, D1 spike (spike.ts).
import { parseJsonl, type MetaLine } from '../core/recording.ts';
import { scoreRecording, type Detail, type Session } from '../core/scoring.ts';
import { drawCurve } from './draw.ts';
import { calibrate, LiveSession, pacedSync, playRound, pulseBaseline, warmUp } from './game.ts';
import { runSpike } from './spike.ts';
import { api, esc, show, type Config, type Settings } from './ui.ts';

const SDK_VERSION = '3.5.x';
let cfg: Config;
let settings: Settings;
let live: LiveSession | null = null;

const NOT_MEDICAL = 'Training aid for breath timing. Not a medical device; not for diagnosis.';

function missingKey() {
  show(`<h1>STEADY</h1>
    <div class="panel"><h2>Set PRESAGE_API_KEY in .env</h2>
    <p>Live mode needs a Presage SmartSpectra API key (free at physiology.presagetech.com).</p>
    <ol><li>Copy <code>.env.example</code> to <code>.env</code> in the project folder.</li>
    <li>Paste your key after <code>PRESAGE_API_KEY=</code>.</li><li>Restart with <code>npm start</code>.</li></ol>
    ${cfg.sdkError ? `<p class="dim">SDK runtime did not load on ${esc(cfg.platform)}: ${esc(cfg.sdkError)}</p>` : ''}
    </div>
    <div class="panel"><p>No key or camera? You can still replay a recording through the full detector and report.</p>
    <button id="replay" class="primary">Replay a recording</button></div>
    <p class="dim">${NOT_MEDICAL}</p>`, { replay: replayScreen });
}

function consent() {
  show(`<h1>Before the camera starts</h1>
    <div class="panel">
    <h2>What STEADY measures</h2>
    <p>Your chest breathing motion (the breathing trace), breathing rate, pulse rate, whether you are talking, and whether your face is in position. The Presage SmartSpectra SDK computes these <b>on this device</b> from your webcam.</p>
    <p><b>Be alone in frame.</b> The SDK tracks one face and the app cannot detect bystanders.</p>
    <h2>What is stored, only on this computer</h2>
    <p>Session summaries, and <b>raw signal recordings</b> (JSONL files: breathing trace, breathing rate, pulse, talking/validity flags, timestamps, your shots), used for replay and post-round scoring. Folder: <code>${esc(cfg.dataDir)}</code>.</p>
    <p><b>Never stored:</b> video frames or images. The small webcam picture is display only.</p>
    <h2>Shared</h2><p>With nobody. No analytics, no crash reporting, no cloud.</p>
    <h2>What leaves the device</h2>
    <p>Presage SDK API-key verification, usage metering and model download (your key and device/licence information). SDK telemetry is <b>disabled</b> in STEADY's configuration (<code>enableTelemetry: false</code>); the licence and usage calls remain. See Presage's telemetry and privacy page: smartspectra.presagetech.com/docs/telemetry-and-privacy.</p>
    <h2>AI use</h2>
    <p>No AI or LLM service runs in this app; the coaching insight is rule-based. Presage's own on-device models compute the signals. The code was written with Claude Code (disclosed in the project post).</p>
    <h2>Retention and control</h2>
    <p>Kept until you delete it. Settings → <b>Delete all data</b> removes session summaries and all raw recordings. A <b>Camera off</b> button is always visible, and you can withdraw consent in Settings.</p>
    <p>${NOT_MEDICAL} Pulse is shown only as calm/elevated relative to your own session baseline.</p>
    </div>
    <button id="agree" class="primary">I agree, continue</button>
    <button id="replay">Not now: replay a recording instead</button>`, {
    agree: async () => { settings = { ...settings, consent: true, consentAt: new Date().toISOString() }; await api().setSettings(settings); home(); },
    replay: replayScreen,
  });
}

async function home() {
  const sessions = await api().listSessions();
  const hist = sessions.slice().reverse().map((s: Session) =>
    `<li>${esc(s.date.slice(0, 16).replace('T', ' '))}: ${s.guided.pct_pause ?? 'n/a'}% with help, <b>${s.nohud.pct_pause ?? 'n/a'}%</b> on your own${s.synthetic ? ' <span class="chip">SYNTHETIC</span>' : ''}</li>`).join('');
  show(`<h1>STEADY</h1>
    <p><b>Your breathing moves the crosshair, like it moves a rifle. Fire in your natural respiratory pause.</b></p>
    <p class="dim">Seated desk practice. Session: ≈45 s calibration, a 60 s Guided round, a 60 s No-HUD round, then your report (≈3 min of camera time).</p>
    <button id="start" class="primary">Start session</button>
    <button id="replay">Replay a recording</button>
    <button id="settings">Settings</button>
    ${hist ? `<div class="panel"><h2>Last sessions</h2><ul>${hist}</ul></div>` : ''}
    <p class="dim">${NOT_MEDICAL}</p>`, { start: startSession, replay: replayScreen, settings: settingsScreen });
}

async function abortLive() {
  if (live) { await live.stop(); live = null; }
  home();
}

async function startSession() {
  const s = new LiveSession(cfg.key);
  live = s;
  await s.open('session');
  try {
    if (!(await warmUp(s))) return abortLive();
    await pacedSync(s);
    if (s.aborted) return abortLive();
    const res = calibrate(s, SDK_VERSION);
    if (!res.ok) {
      await s.stop(); live = null;
      show(`<h1>Calibration did not work</h1><div class="panel"><p>${esc(res.why)}</p><p>Follow the circle with slow, visible chest breaths, stay silent and still.</p></div>
        <button id="retry" class="primary">Try again</button><button id="home">Home</button>`, { retry: startSession, home });
      return;
    }
    const c = s.cal!;
    const base = pulseBaseline(s);
    await new Promise<void>((go) => show(`<h1>Calibrated</h1><div class="panel">
      <p>Signal delay ≈ <b>${(c.D_ms / 1000).toFixed(1)} s</b>. Your timing offset ≈ <b>${(c.L_ms / 1000).toFixed(1)} s</b> (±${(c.L_spread_ms / 1000).toFixed(1)}).</p>
      <p>Scores are provisional live, final after the round.</p></div>
      <p>Next: <b>Guided round</b> (60 s). Aim with the mouse; the crosshair rises with your chest. Fire in the pause, where the sway stops.</p>
      <button id="go" class="primary">Start Guided round</button> <button id="camoff" class="danger">Camera off</button>`,
    { go: () => go(), camoff: () => { s.aborted = true; go(); } }));
    if (s.aborted || !(await playRound(s, 'guided', settings, base))) return abortLive();
    await new Promise<void>((go) => show(`<h1>No-HUD round next</h1><p>Same sway and scoring, but no breathing curve, no green shading, no NOW, no tick. Can you find the pause on your own?</p>
      <button id="go" class="primary">Start No-HUD round</button> <button id="camoff" class="danger">Camera off</button>`,
    { go: () => go(), camoff: () => { s.aborted = true; go(); } }));
    if (s.aborted || !(await playRound(s, 'nohud', settings, base))) return abortLive();
    await s.stop(); // camera off as soon as the last round ends
    live = null;
    const name = s.file.split('/').pop()!;
    const { session, detail } = scoreRecording(s.lines, name);
    await api().saveSession(session.id, JSON.stringify(session, null, 2) + '\n');
    report(session, detail, 'Your session', false);
  } catch (e) {
    await s.stop(); live = null;
    show(`<h1>Something went wrong</h1><div class="panel"><p>${esc((e as Error).message ?? e)}</p>
      <p class="dim">If this is an authentication or 503 error from the SDK, check the key in .env and try again in a minute.</p></div><button id="home">Home</button>`, { home });
  }
}

function report(session: Session, detail: Detail, label: string, synthetic: boolean) {
  const g = session.guided, n = session.nohud;
  const pct = (v: number | null) => (v === null ? 'n/a' : `${v}%`);
  show(`<div class="topbar"><h1>Session report</h1><button id="home">Home</button></div>
    ${label !== 'Your session' ? `<div class="banner replay">${esc(label)}</div>` : ''}
    ${synthetic ? '<div class="banner synthetic">SYNTHETIC TEST DATA: generated, not a real person</div>' : ''}
    <h2>${pct(g.pct_pause)} in your pause with help, <b>${pct(n.pct_pause)}</b> on your own</h2>
    <canvas id="cg" width="1150" height="210"></canvas><div style="height:8px"></div>
    <canvas id="cn" width="1150" height="210"></canvas>
    <p class="dim">Dots: <span class="chip green">in pause ×1.0</span><span class="chip red">mid-breath ×0.3</span><span class="chip grey">not scored (talking / weak signal)</span> Green shading = detected pause windows.</p>
    <div class="panel"><b>Coach:</b> ${esc(session.insight.text)}</div>
    <div class="row">
      <div class="stat">Avg score<b>${g.avg_score ?? 'n/a'} / ${n.avg_score ?? 'n/a'}</b><span class="dim">Guided / No-HUD</span></div>
      <div class="stat">Trigger patience<b>${g.patience_ms ?? 'n/a'} / ${n.patience_ms ?? 'n/a'} ms</b><span class="dim">pause open → shot</span></div>
      <div class="stat">Rhythm consistency<b>${session.rhythm_cv ?? 'n/a'}</b><span class="dim">CV of breath periods (lower = steadier)</span></div>
      <div class="stat">Pulse<b>${esc(session.pulse_trend)}</b><span class="dim">vs your own baseline</span></div>
      <div class="stat">Breathing rate<b>${session.breathing_rate ?? 'n/a'}</b><span class="dim">per min</span></div>
      <div class="stat">Shots<b>${g.n} / ${n.n}</b><span class="dim">grey ${g.n_grey} / ${n.n_grey}</span></div>
    </div>
    <p class="dim">Calibration: signal delay D ${session.cal.D_ms} ms (p95 ${session.cal.D_p95_ms}), timing offset L ${session.cal.L_ms} ± ${session.cal.L_spread_ms} ms. ${NOT_MEDICAL}</p>`, { home });
  for (const [id, type] of [['cg', 'guided'], ['cn', 'nohud']] as const) {
    const r = detail.rounds.find((x) => x.type === type);
    const ctx = (document.getElementById(id) as HTMLCanvasElement).getContext('2d')!;
    if (!r) continue;
    // Round spans are wall time; the curve is in sample time, so shift by L to line shots up.
    const L = session.cal.L_ms;
    drawCurve(ctx, { x: 0, y: 0, w: 1150, h: 210 }, detail.det.pts, r.t_start + L, r.t_end + L, {
      pauses: detail.det.pauses, unknown: detail.unknown,
      dots: detail.shots.filter((s) => s.round === type).map((s) => ({ t: s.judged_at, state: s.state })),
      label: type === 'guided' ? 'Guided round' : 'No-HUD round',
    });
  }
}

async function replayScreen() {
  const files = await api().replayList();
  const items = files.map((f, i) => `<li><button id="f${i}">${esc(f.name)}</button> <span class="dim">${esc(f.source)}</span>${f.synthetic ? ' <span class="chip">SYNTHETIC TEST DATA</span>' : ''}</li>`).join('');
  const on: Record<string, () => void> = { home: () => (cfg.hasKey && settings.consent ? home() : cfg.hasKey ? consent() : missingKey()) };
  files.forEach((f, i) => { on[`f${i}`] = () => replayFile(f.path, f.name, f.synthetic); });
  show(`<div class="topbar"><h1>Replay</h1><button id="home">Back</button></div>
    <p>Runs a saved recording through the same detector, sway check, scoring and report as a live session. No camera, no key.</p>
    <ul>${items || '<li class="dim">No recordings found.</li>'}</ul>`, on);
}

async function replayFile(path: string, name: string, synthetic: boolean) {
  try {
    const lines = parseJsonl(await api().replayRead(path));
    const meta = lines.find((l): l is MetaLine => l.k === 'meta');
    const { session, detail } = scoreRecording(lines, name);
    report(session, detail, `Replay: ${name}`, synthetic || meta?.synthetic === true);
  } catch (e) {
    show(`<h1>Could not replay ${esc(name)}</h1><p>${esc((e as Error).message ?? e)}</p><button id="back">Back</button>`, { back: replayScreen });
  }
}

function settingsScreen() {
  show(`<div class="topbar"><h1>Settings</h1><button id="home">Home</button></div>
    <div class="panel"><label><input type="checkbox" id="tick" ${settings.tick ? 'checked' : ''}> Soft tick when the pause opens (Guided round)</label></div>
    <div class="panel"><h2>Camera</h2><p>The camera only runs during calibration and rounds.</p><button id="camoff">Camera off now</button></div>
    <div class="panel"><h2>Consent</h2><p>${settings.consent ? `Given ${esc(settings.consentAt ?? '')}.` : 'Not given.'}</p><button id="withdraw" ${settings.consent ? '' : 'disabled'}>Withdraw consent</button></div>
    <div class="panel"><h2>Your data</h2><p>Stored in <code>${esc(cfg.dataDir)}</code>: session summaries and raw signal recordings. No video or images.</p>
    <button id="delete" class="danger">Delete all data</button> <span id="deleted" class="dim"></span></div>`, {
    home,
    camoff: async () => { if (live) { live.aborted = true; await live.stop(); live = null; } },
    withdraw: async () => {
      if (live) { live.aborted = true; await live.stop(); live = null; }
      settings = { ...settings, consent: false, consentAt: undefined };
      await api().setSettings(settings);
      if (confirm('Consent withdrawn. Also delete all session summaries and raw recordings now?')) await api().deleteAll();
      consent();
    },
    delete: async () => {
      if (!confirm('Delete all session summaries and raw recordings? This cannot be undone.')) return;
      const left = await api().deleteAll();
      document.getElementById('deleted')!.textContent = left.sessions || left.recordings ? 'Some files could not be removed.' : 'Deleted. The sessions and recordings folders are gone.';
    },
  });
  document.getElementById('tick')!.addEventListener('change', async (e) => {
    settings = { ...settings, tick: (e.target as HTMLInputElement).checked };
    await api().setSettings(settings);
  });
}

(async () => {
  cfg = await api().config();
  settings = await api().getSettings();
  if (!cfg.hasKey) return missingKey();
  if (cfg.mode === 'spike') return runSpike(cfg.key);
  if (!settings.consent) return consent();
  home();
})();
