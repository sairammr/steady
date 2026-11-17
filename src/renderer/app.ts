// Renderer entry: screen routing. Screens: missing-key, consent, home, calibration + rounds
// (game.ts), report, settings, replay, D1 spike (spike.ts).
import { parseJsonl, type Cal, type MetaLine } from '../core/recording.ts';
import { scoreRecording, type Detail, type Session } from '../core/scoring.ts';
import { drawCurve } from './draw.ts';
import { calibrate, LiveSession, pacedSync, playRound, pulseBaseline, warmUp } from './game.ts';
import { preview } from './preview.ts';
import { runSpike } from './spike.ts';
import { api, esc, hidpi, liveLayout, page, show, stat, type Config, type Settings } from './ui.ts';

const SDK_VERSION = '3.5.x';
let cfg: Config;
let settings: Settings;
let live: LiveSession | null = null;

const NOT_MEDICAL = 'Training aid for breath timing. Not a medical device; not for diagnosis.';

const TARGET_ART = `<svg class="target-art" viewBox="0 0 200 200" aria-hidden="true">${
  Array.from({ length: 10 }, (_, i) => `<circle cx="100" cy="100" r="${(10 - i) * 10 - 0.5}" fill="${i === 5 ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="0.8"/>`).join('')}
  <path d="M100 0v200M0 100h200" stroke="currentColor" stroke-width="0.6"/></svg>`;

function missingKey() {
  show(page(`${TARGET_ART}<div class="hero">
    <div><div class="kicker">Seated breath-timing trainer</div>
      <h1 class="display">Fire in<br>the <em>pause.</em></h1>
      <p class="lead">Your breathing moves the crosshair, like it moves a rifle. STEADY reads it from your webcam, on this device.</p></div>
    <div class="stack">
      <div class="card"><div class="kicker">Live mode</div><h2>Set PRESAGE_API_KEY in .env</h2>
        <p class="dim" style="margin-top:8px">Live mode needs a Presage SmartSpectra API key (free at physiology.presagetech.com).</p>
        <ol><li>Copy <code>.env.example</code> to <code>.env</code> in the project folder.</li>
        <li>Paste your key after <code>PRESAGE_API_KEY=</code>.</li><li>Restart with <code>npm start</code>.</li></ol>
        ${cfg.sdkError ? `<p class="small dim" style="margin-top:12px">SDK runtime did not load on ${esc(cfg.platform)}: ${esc(cfg.sdkError)}</p>` : ''}</div>
      <div class="card inset"><div class="kicker">No key or camera?</div>
        <p>You can still replay a recording through the full detector and report.</p>
        <button id="replay" class="primary arrow">Replay a recording</button></div>
    </div></div>
    <p class="foot">${NOT_MEDICAL}</p>`), { replay: replayScreen });
}

function consent() {
  show(page(`<div class="consent-head"><div><div class="kicker">First run · nothing is recorded yet</div>
      <h1>Before the camera starts</h1></div>
    <div class="alert"><b>Be alone in frame.</b><span>The SDK tracks one face and the app cannot detect bystanders.</span></div></div>
    <div class="consent-grid">
      <div class="card"><div class="kicker">What STEADY measures</div><div class="gist">Breathing, measured on this device</div>
        <p>Your chest breathing motion (the breathing trace), breathing rate, pulse rate, whether you are talking, and whether your face is in position. The Presage SmartSpectra SDK computes these <b>on this device</b> from your webcam.</p></div>
      <div class="card"><div class="kicker">What is stored, only on this computer</div><div class="gist">Signal recordings and summaries</div>
        <p>Session summaries, and <b>raw signal recordings</b> (JSONL files: breathing trace, breathing rate, pulse, talking/validity flags, timestamps, your shots), used for replay and post-round scoring.</p>
        <p class="small">Folder: <code>${esc(cfg.dataDir)}</code></p></div>
      <div class="card"><div class="kicker">What leaves the device</div><div class="gist">Presage licence and usage checks only</div>
        <p>Presage SDK API-key verification, usage metering and model download (your key and device/licence information). SDK telemetry is <b>disabled</b> in STEADY's configuration (<code>enableTelemetry: false</code>); the licence and usage calls remain. See Presage's telemetry and privacy page: smartspectra.presagetech.com/docs/telemetry-and-privacy.</p></div>
      <div class="card"><div class="kicker">AI use</div><div class="gist">No AI runs in this app</div>
        <p>No AI or LLM service runs in this app; the coaching insight is rule-based. Presage's own on-device models compute the signals. The code was written with Claude Code (disclosed in the project post).</p></div>
      <div class="card"><div class="kicker">Never stored</div><div class="gist">No video, no images</div>
        <p><b>Never stored:</b> video frames or images. The small webcam picture is display only.</p></div>
      <div class="card"><div class="kicker">Shared</div><div class="gist">With nobody</div>
        <p>No analytics, no crash reporting, no cloud.</p></div>
      <div class="card"><div class="kicker">Retention and control</div><div class="gist">Kept until you delete it</div>
        <p>Settings → <b>Delete all data</b> removes session summaries and all raw recordings. A <b>Camera off</b> button is always visible, and you can withdraw consent in Settings.</p></div>
      <div class="card inset"><div class="kicker">Not medical</div><div class="gist">A training aid</div>
        <p>${NOT_MEDICAL} Pulse is shown only as calm/elevated relative to your own session baseline.</p></div>
    </div>
    <div class="actionbar"><button id="agree" class="primary big">I agree, continue</button>
      <button id="replay" class="ghost">Not now: replay a recording instead</button>
      <span class="foot">The camera starts only after you agree. Withdraw any time in Settings.</span></div>`, { title: 'Consent', cls: 'consent-page' }), {
    agree: async () => { settings = { ...settings, consent: true, consentAt: new Date().toISOString() }; await api().setSettings(settings); home(); },
    replay: replayScreen,
  });
}

const pctOr = (v: number | null) => (v === null ? 'n/a' : `${v}%`);

async function home() {
  const sessions = await api().listSessions();
  const rows = sessions.slice().reverse().map((s: Session) => `<tr>
    <td>${esc(s.date.slice(0, 16).replace('T', ' '))}${s.synthetic ? ' <span class="chip synthetic">Synthetic</span>' : ''}</td>
    <td class="n">${pctOr(s.guided.pct_pause)}</td><td class="n own">${pctOr(s.nohud.pct_pause)}</td></tr>`).join('');
  show(page(`${TARGET_ART}<div class="hero">
    <div><div class="kicker">Seated breath-timing trainer</div>
      <h1 class="display">Fire in<br>the <em>pause.</em></h1>
      <p class="lead"><b>Your breathing moves the crosshair, like it moves a rifle. Fire in your natural respiratory pause.</b></p>
      <div class="plan">
        <div><span class="num">≈45 s</span><span>Calibration</span></div>
        <div><span class="num">60 s</span><span>Guided round</span></div>
        <div><span class="num">60 s</span><span>No-HUD round</span></div>
        <div><span class="num">Report</span><span>Your timing</span></div></div>
      <div class="row"><button id="start" class="primary big arrow">Start session</button>
        <button id="replay">Replay a recording</button></div>
      <p class="small dim" style="margin-top:12px">Seated desk practice, ≈3 min of camera time per session.</p></div>
    <div class="card"><div class="kicker">Logbook</div><h2 style="margin-bottom:12px">Last sessions</h2>
      ${rows ? `<table class="log"><thead><tr><th>Date</th><th class="n">With help</th><th class="n">On your own</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="small dim" style="margin-top:10px">Share of scored shots fired in your breathing pause.</p>`
    : '<div class="empty">No sessions yet. Your log appears here after your first session.</div>'}</div>
    </div>
    <p class="foot">${NOT_MEDICAL}</p>`, { actions: '<button id="settings" class="ghost sm">Settings</button>' }),
  { start: startSession, replay: replayScreen, settings: settingsScreen });
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
      show(page(`<div class="card" style="max-width:640px;margin:48px auto"><div class="kicker">Breath sync</div><h1>Calibration did not work</h1>
        <p style="margin-top:16px">${esc(res.why)}</p><p>Follow the ring with slow, visible chest breaths, stay silent and still.</p>
        <div class="row" style="margin-top:16px"><button id="retry" class="primary">Try again</button><button id="home">Home</button></div></div>`), { retry: startSession, home });
      return;
    }
    const c = s.cal!;
    const base = pulseBaseline(s);
    await new Promise<void>((go) => show(calibrated(c), { go: () => go(), camoff: () => { s.aborted = true; go(); } }));
    if (s.aborted || !(await playRound(s, 'guided', settings, base))) return abortLive();
    await new Promise<void>((go) => show(nohudIntro(), { go: () => go(), camoff: () => { s.aborted = true; go(); } }));
    if (s.aborted || !(await playRound(s, 'nohud', settings, base))) return abortLive();
    await s.stop(); // camera off as soon as the last round ends
    live = null;
    const name = s.file.split('/').pop()!;
    const { session, detail } = scoreRecording(s.lines, name);
    await api().saveSession(session.id, JSON.stringify(session, null, 2) + '\n');
    report(session, detail, 'Your session', false);
  } catch (e) {
    await s.stop(); live = null;
    show(page(`<div class="card" style="max-width:640px;margin:48px auto"><div class="kicker">Camera stopped</div><h1>Something went wrong</h1>
      <p style="margin-top:16px">${esc((e as Error).message ?? e)}</p>
      <p class="dim">If this is an authentication or 503 error from the SDK, check the key in .env and try again in a minute.</p><button id="home">Home</button></div>`), { home });
  }
}

function calibrated(c: Cal) {
  return liveLayout(2, `<div class="kicker">Step 2 · Breath sync done</div>
    <div class="prompt">Calibrated</div>
    <p class="lead">Measured against the paced guide.</p>
    <div class="grid-2" style="max-width:640px">
      <div class="stat big"><div class="label">Signal delay</div><div class="value">≈ ${(c.D_ms / 1000).toFixed(1)}<small>s</small></div><div class="sub">camera to screen</div></div>
      <div class="stat big"><div class="label">Your timing offset</div><div class="value">≈ ${(c.L_ms / 1000).toFixed(1)}<small>s ±${(c.L_spread_ms / 1000).toFixed(1)}</small></div><div class="sub">how far you trail the guide, plus signal filtering</div></div>
    </div>
    <p class="small dim">Scores are provisional live, final after the round.</p>
    <div class="card" style="max-width:640px"><div class="kicker">Next · 60 s</div><h2>Guided round</h2>
      <p style="margin-top:8px">Aim with the mouse; the crosshair rises with your chest. Fire in the pause, where the sway stops.</p>
      <button id="go" class="primary big arrow">Start Guided round</button></div>`);
}

function nohudIntro() {
  return liveLayout(3, `<div class="kicker">Next · 60 s</div>
    <div class="prompt">No-HUD round</div>
    <p class="lead">Same sway and scoring, but no breathing curve, no green shading, no NOW, no tick. Can you find the pause on your own?</p>
    <div><button id="go" class="primary big arrow">Start No-HUD round</button></div>`);
}

function report(session: Session, detail: Detail, label: string, synthetic: boolean) {
  const g = session.guided, n = session.nohud;
  const pct = pctOr;
  const isReplay = label !== 'Your session';
  const banner = synthetic
    ? `<div class="banner synthetic">${isReplay ? `<span class="chip replay">Replay</span>${esc(label.replace(/^Replay: /, ''))}` : ''}<b>Synthetic test data</b><span>generated, not a real person</span></div>`
    : isReplay ? `<div class="banner replay"><span class="chip replay">Replay</span>${esc(label)}</div>` : '';
  show(page(`${banner}
    <div class="report-head"><div><div class="kicker">Shots fired in your breathing pause</div>
      <h1 class="headline"><span class="pct">${pct(g.pct_pause)}</span> <span class="soft">with help,</span> <span class="pct own">${pct(n.pct_pause)}</span> on your own</h1></div></div>
    <div class="report">
      <div class="curves">
        <div class="card"><canvas id="cg"></canvas></div>
        <div class="card"><canvas id="cn"></canvas></div>
        <div class="legend">Each dot is a shot: <span class="chip dot green">in pause ×1.0</span><span class="chip dot red">mid-breath ×0.3</span><span class="chip dot grey">not scored (talking / weak signal)</span> Green band = detected pause.</div>
      </div>
      <div class="stack">
        <div class="card insight"><div class="kicker">Coach</div><p>${esc(session.insight.text)}</p></div>
        <div class="stats">
          ${stat('Avg score', `${g.avg_score ?? 'n/a'}<small>/</small>${n.avg_score ?? 'n/a'}`, 'Guided / No-HUD')}
          ${stat('Trigger patience', `${g.patience_ms ?? 'n/a'}<small>/</small>${n.patience_ms ?? 'n/a'}<small>ms</small>`, 'pause opens → you fire')}
          ${stat('Rhythm', `${session.rhythm_cv ?? 'n/a'}`, 'breath-length variation (CV), lower = steadier')}
          ${stat('Pulse', esc(session.pulse_trend), 'vs your own baseline')}
          ${stat('Breathing rate', `${session.breathing_rate ?? 'n/a'}<small>/min</small>`, 'breaths per minute')}
          ${stat('Shots', `${g.n}<small>/</small>${n.n}`, `not scored ${g.n_grey} / ${n.n_grey}`)}
        </div>
      </div>
    </div>
    <p class="foot">Calibration: signal delay D ${session.cal.D_ms} ms (p95 ${session.cal.D_p95_ms}), timing offset L ${session.cal.L_ms} ± ${session.cal.L_spread_ms} ms. ${NOT_MEDICAL}</p>`,
  { title: 'Session report', cls: 'report-page', actions: '<button id="home" class="sm">Home</button>' }), { home });
  for (const [id, type] of [['cg', 'guided'], ['cn', 'nohud']] as const) {
    const r = detail.rounds.find((x) => x.type === type);
    const el = document.getElementById(id) as HTMLCanvasElement;
    const w = el.parentElement!.clientWidth - 24, h = 148;
    el.style.width = `${w}px`;
    const ctx = hidpi(el, w, h);
    if (!r) continue;
    // Round spans are wall time; the curve is in sample time, so shift by L to line shots up.
    const L = session.cal.L_ms;
    const st = type === 'guided' ? g : n;
    drawCurve(ctx, { x: 0, y: 0, w, h }, detail.det.pts, r.t_start + L, r.t_end + L, {
      pauses: detail.det.pauses, unknown: detail.unknown, axis: true,
      dots: detail.shots.filter((s) => s.round === type).map((s) => ({ t: s.judged_at, state: s.state })),
      label: type === 'guided' ? 'Guided round' : 'No-HUD round',
      sublabel: `${pct(st.pct_pause)} in pause · ${st.n} shots`,
    });
  }
}

async function replayScreen() {
  const files = await api().replayList();
  const items = files.map((f, i) => `<button id="f${i}" class="file"><span>${esc(f.name)}</span>
    <span class="meta">${f.synthetic ? '<span class="chip synthetic">Synthetic test data</span>' : ''}${esc(f.source)}</span></button>`).join('');
  const on: Record<string, () => void> = { home: () => (cfg.hasKey && settings.consent ? home() : cfg.hasKey ? consent() : missingKey()) };
  files.forEach((f, i) => { on[`f${i}`] = () => replayFile(f.path, f.name, f.synthetic); });
  show(page(`<div class="page-head"><div><div class="kicker">No camera, no key</div><h1>Replay a recording</h1>
      <p class="lead" style="margin-top:12px">Runs a saved recording through the same detector, sway check, scoring and report as a live session.</p></div></div>
    <div class="files">${items || '<div class="empty">No recordings found.</div>'}</div>`,
  { title: 'Replay', actions: '<button id="home" class="sm">Back</button>' }), on);
}

async function replayFile(path: string, name: string, synthetic: boolean) {
  try {
    const lines = parseJsonl(await api().replayRead(path));
    const meta = lines.find((l): l is MetaLine => l.k === 'meta');
    const { session, detail } = scoreRecording(lines, name);
    report(session, detail, `Replay: ${name}`, synthetic || meta?.synthetic === true);
  } catch (e) {
    show(page(`<div class="card" style="max-width:640px;margin:48px auto"><h1>Could not replay ${esc(name)}</h1><p style="margin-top:16px">${esc((e as Error).message ?? e)}</p><button id="back">Back</button></div>`), { back: replayScreen });
  }
}

function settingsScreen() {
  show(page(`<div class="page-head"><h1>Settings</h1></div>
    <div class="grid-2">
    <div class="card"><div class="kicker">Guided round</div>
      <label class="switch"><input type="checkbox" id="tick" ${settings.tick ? 'checked' : ''}> Soft tick when the pause opens (Guided round)</label></div>
    <div class="card"><div class="kicker">Camera</div><p>The camera only runs during calibration and rounds.</p><button id="camoff" class="danger camoff">Camera off now</button></div>
    <div class="card"><div class="kicker">Consent</div><p>${settings.consent ? `Given ${esc(settings.consentAt ?? '')}.` : 'Not given.'}</p><button id="withdraw" ${settings.consent ? '' : 'disabled'}>Withdraw consent</button></div>
    <div class="card danger-zone"><div class="kicker">Your data</div><p>Stored in <code>${esc(cfg.dataDir)}</code>: session summaries and raw signal recordings. No video or images.</p>
      <div class="row"><button id="delete" class="danger">Delete all data</button> <span id="deleted" class="done-note"></span></div></div>
    </div>
    <p class="foot">${NOT_MEDICAL}</p>`, { title: 'Settings', actions: '<button id="home" class="sm">Home</button>' }), {
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
  if (cfg.mode === 'preview') return preview(cfg.preview, { cfg, settings, missingKey, consent, home, replayScreen, replayFile, settingsScreen, calibrated, nohudIntro, report });
  if (!cfg.hasKey) return missingKey();
  if (cfg.mode === 'spike') return runSpike(cfg.key);
  if (!settings.consent) return consent();
  home();
})();
