// Dev-only: STEADY_PREVIEW=<screen> renders one screen from the SYNTHETIC fixtures, so every screen
// can be screenshotted (STEADY_SNAPSHOT) without a camera, a key or a person. Never used in a live session.
import { ofKind, parseJsonl, type Cal, type Line, type MetaLine } from '../core/recording.ts';
import { scoreRecording, type Detail, type Session } from '../core/scoring.ts';
import { formatSpike, summarizeSpike } from '../core/spike.ts';
import { LiveSession, pacedSync, playRound, pulseBaseline, warmUp, type Bot } from './game.ts';
import type { Live } from './live.ts';
import { runSpike, spikeResult } from './spike.ts';
import { api, show, type Config, type Settings } from './ui.ts';

type Screens = {
  cfg: Config; settings: Settings;
  missingKey(): void; consent(): void; home(): Promise<void>; replayScreen(): Promise<void>; settingsScreen(): void;
  replayFile(path: string, name: string, synthetic: boolean): Promise<void>;
  calibrated(c: Cal): string; nohudIntro(): string;
  report(s: Session, d: Detail, label: string, synthetic: boolean): void;
};

async function fixture(name: string) {
  const f = (await api().replayList()).find((x) => x.name === `${name}.jsonl`)!;
  return { file: f, lines: parseJsonl(await api().replayRead(f.path)) };
}

/** A LiveSession fed in real time from a recording instead of the SDK. `at` = fixture time shown as "now". */
function fakeSession(lines: Line[], at: number, withCal: boolean) {
  const s = new LiveSession('');
  const fake = { valid: true, running: true, hint: '', talking: false, lastPulse: null as number | null, lastArrival: 0, start: async () => {}, stop: async () => {} };
  s.live = fake as unknown as Live;
  const meta = lines[0] as MetaLine;
  if (withCal && meta.cal) s.cal = meta.cal;
  const shift = Date.now() - at;
  const ms = ofKind(lines, 'm').map((m) => ({ ...m, t_arr: m.t_arr + shift, upper: m.upper.map((u) => ({ ...u, t: u.t + shift })) }));
  let i = 0;
  const pump = () => {
    while (i < ms.length && ms[i].t_arr <= Date.now()) {
      const l = ms[i++];
      fake.talking = l.talking; fake.lastPulse = l.pulse ?? fake.lastPulse; fake.lastArrival = Date.now();
      s.add(l);
    }
  };
  pump(); s.updateDet(); setInterval(pump, 50);
  return s;
}

/** Aims at each target and fires in the pause, or mid-breath if it waits too long. */
function autopilot(): Bot {
  let aim: [number, number] = [490, 250];
  return ({ target, now, state }) => {
    if (!target) return {};
    aim = [aim[0] + (target.x - aim[0]) * 0.15, aim[1] + (target.y - aim[1]) * 0.15];
    const age = now - target.t;
    return { aim, fire: age > 900 && ((state === 'pause' && age > 1400) || age > 4200) };
  };
}

export async function preview(name: string, x: Screens) {
  if (!x.settings.consent && name !== 'consent') { // throwaway preview profile: pretend consent was given
    await api().setSettings({ consent: true, consentAt: new Date().toISOString(), tick: true });
    return location.reload();
  }
  const fx = name.includes('talking') ? 'synthetic-talking' : name.startsWith('spike') ? 'synthetic-spike' : 'synthetic-clean';
  const { file, lines } = await fixture(fx);
  const round = (type: string) => ofKind(lines, 'round').find((r) => r.type === type)!;
  switch (name) {
    case 'missing': return x.missingKey();
    case 'consent': return x.consent();
    case 'settings': return x.settingsScreen();
    case 'replay': return x.replayScreen();
    case 'home': {
      for (const n of ['synthetic-slow', 'synthetic-talking', 'synthetic-clean']) {
        const { file: f, lines: l } = await fixture(n);
        const { session } = scoreRecording(l, f.name);
        await api().saveSession(session.id, JSON.stringify(session));
      }
      return x.home();
    }
    case 'report': case 'report-talking': return x.replayFile(file.path, file.name, true);
    case 'warmup': return void warmUp(fakeSession(lines, 12_000 + (lines[0] as MetaLine).t0_wall, false));
    case 'sync': {
      const s = fakeSession(lines, ofKind(lines, 'pace')[0].t, false);
      return void pacedSync(s, 400);
    }
    case 'calibrated': return show(x.calibrated((lines[0] as MetaLine).cal!), {});
    case 'nohud-intro': return show(x.nohudIntro(), {});
    case 'guided': case 'guided-talking': case 'nohud': {
      const type = name === 'nohud' ? 'nohud' : 'guided';
      const at = round(type).t_start + (name === 'guided-talking' ? 18_000 : 15_000);
      const s = fakeSession(lines, at, true);
      return void playRound(s, type, x.settings, pulseBaseline(s), autopilot());
    }
    case 'spike': return runSpike('');
    case 'spike-result': {
      const sum = summarizeSpike(lines);
      return spikeResult(sum, formatSpike(sum), file.path);
    }
    default: show(`<pre>Unknown STEADY_PREVIEW screen: ${name}</pre>`);
  }
}
