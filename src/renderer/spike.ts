// D1 spike (PRD §14), run with `npm run spike`. The developer sits in front of the camera and
// follows on-screen prompts (~3.5 min): 60 s normal breathing, 3 × 5 s post-exhale holds,
// 20 s counting aloud, 3 paced cycles. Writes recordings/spike-<time>.jsonl and prints a summary.
import { formatSpike, summarizeSpike } from '../core/spike.ts';
import type { MarkLine } from '../core/recording.ts';
import { drawCurve } from './draw.ts';
import { LiveSession, pacedSync, W } from './game.ts';
import { api, esc, header, hidpi, page, show, sleep } from './ui.ts';
import type { SpikeSummary } from '../core/spike.ts';

export function runSpike(key: string) {
  show(page(`<div class="card" style="max-width:720px;margin:32px auto"><div class="kicker">Developer check · D1</div><h1>STEADY D1 spike</h1>
    <p style="margin-top:16px">About 3.5 minutes of live camera (counts against your Presage credits). Raw signal values only are written to <code>recordings/</code>; no video or images. SDK telemetry is disabled.</p>
    <p>Sit still, chest visible, even light, alone in frame. Follow the prompts: normal breathing, three short holds after a normal exhale, counting aloud, then three paced breaths.</p>
    <button id="go" class="primary big arrow">Start spike</button></div>`, { title: 'D1 spike' }), { go: () => void spike(key) });
}

async function spike(key: string) {
  const s = new LiveSession(key);
  await s.open('spike');
  s.begin({ k: 'meta', v: 1, sdk: '3.5.x', t0_wall: s.t0, sdk_time_unit: 'ms', cal: null, note: 'D1 spike recording' });
  const mark = (name: string, detail?: string) => s.add({ k: 'mark', name, t: Date.now(), ...(detail ? { detail } : {}) } as MarkLine);
  show(`${header({ title: 'D1 spike', actions: '<button id="stop" class="danger camoff">Stop</button>' })}
    <main class="live"><section class="stage"><div class="kicker">Follow the prompt</div><div id="prompt" class="prompt">Starting…</div>
    <p id="sub" class="lead"></p><div class="card tight"><b id="hint"></b> <span id="stats" class="dim"></span></div>
    <canvas id="c"></canvas></section><aside class="rail"><div class="pip-slot">Your camera picture shows here. Display only, never saved.</div></aside></main>`, { stop: () => { s.aborted = true; } });
  const $ = (id: string) => document.getElementById(id)!;
  const ctx = hidpi($('c') as HTMLCanvasElement, W, 260);
  let drawing = true;
  (async () => {
    while (drawing) {
      await new Promise(requestAnimationFrame);
      $('hint').textContent = s.live.valid ? 'signal valid' : s.live.hint;
      $('stats').textContent = ` · events ${s.lines.filter((l) => l.k === 'm').length} · talking ${s.live.talking ? 'YES' : 'no'}`;
      if (s.det) drawCurve(ctx, { x: 0, y: 0, w: W, h: 260 }, s.det.pts, s.lastSampleT() - 20000, s.lastSampleT(), { label: 'Raw chest trace', sublabel: 'smoothed, uncalibrated' });
    }
  })();
  const say = (p: string, sub = '') => { $('prompt').textContent = p; $('sub').textContent = sub; };
  const countdown = async (p: string, secs: number, sub = '') => {
    for (let i = secs; i > 0 && !s.aborted; i--) { say(`${p} ${i}`, sub); await sleep(1000); }
  };

  try {
    say('Starting camera…');
    await s.live.start();
    // PiP feasibility: the SDK hands us its own stream (streamAvailable). Also try a second getUserMedia.
    await sleep(2000);
    const v = document.getElementById('pip') as HTMLVideoElement | null;
    mark(v && v.videoWidth > 0 ? 'pip_ok' : 'pip_fail', v ? `sdk stream ${v.videoWidth}x${v.videoHeight}` : 'no streamAvailable');
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: true });
      st.getTracks().forEach((t) => t.stop()); // display test only, never read
      mark('gum_second_ok');
    } catch (e) { mark('gum_second_fail', String((e as Error).name)); }

    const warmEnd = Date.now() + 30_000;
    while (!s.aborted && !s.live.valid && Date.now() < warmEnd) { say('Warm-up: get a valid signal', s.live.hint); await sleep(250); }
    mark('normal_start');
    await countdown('Breathe normally, stay silent', 60);
    mark('normal_end');
    for (let i = 1; i <= 3 && !s.aborted; i++) {
      await countdown(`Hold ${i}/3: breathe normally, get ready`, 6, 'When HOLD appears, finish a normal exhale and hold still, lungs relaxed.');
      mark('hold_start');
      await countdown('HOLD', 5, 'hold after the exhale');
      mark('hold_end');
      await countdown('Breathe normally', 8);
    }
    say('Count aloud slowly from 1 to 20', 'one number per second, watch the stopwatch');
    mark('talk_start');
    const ts = Date.now();
    while (!s.aborted && Date.now() - ts < 20_000) { $('sub').textContent = `stopwatch ${((Date.now() - ts) / 1000).toFixed(1)} s`; await sleep(100); }
    mark('talk_end');
    await countdown('Silent now. Paced breathing starts in', 5);
    drawing = false;
    if (!s.aborted) await pacedSync(s);
  } catch (e) {
    mark('spike_error', String((e as Error).message ?? e));
  } finally {
    drawing = false;
    await s.stop();
  }
  const summary = summarizeSpike(s.lines);
  const text = formatSpike(summary);
  await api().log(`\n${text}\nrecording: ${s.file}\n`);
  spikeResult(summary, text, s.file);
}

export function spikeResult(summary: SpikeSummary, text: string, file: string) {
  show(page(`<div class="page-head"><div><div class="kicker">D1 spike result</div><h1>D1 spike: ${esc(summary.verdict.toUpperCase())}</h1></div></div>
    <pre class="card">${esc(text)}</pre>
    <p class="foot">Recording: <code>${esc(file)}</code>. Re-print with <code>npm run spike:summary -- ${esc(file)}</code>.</p>`, { title: 'D1 spike' }));
}
