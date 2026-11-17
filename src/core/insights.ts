// One rule-based coaching insight per session (PRD §9). No LLM.
import type { LiveState, RoundType } from './recording.ts';

export type ScoredShot = { t: number; round: RoundType; t_target: number; state: LiveState; after_timeout: boolean };
export type Insight = { id: string; text: string };

export function pickInsight(shots: ScoredShot[], pct: { guided: number | null; nohud: number | null }): Insight {
  const scored = shots.filter((s) => s.state !== 'unknown');
  const red = scored.filter((s) => s.state === 'breath');
  if (shots.length && scored.length < shots.length / 2) {
    return { id: 'signal', text: 'Most shots could not be scored (talking or weak signal). Stay silent and still, face the camera in even light.' };
  }
  const rushed = red.filter((s) => s.t - s.t_target < 500);
  if (rushed.length >= 2) {
    return { id: 'rushed', text: `${rushed.length} red shots came less than half a second after the target appeared. Wait one breath before firing.` };
  }
  const late = red.filter((s) => s.after_timeout);
  if (late.length >= 2) {
    return { id: 'held', text: `${late.length} shots came after the pause ran past 5 s. If the pause runs long, breathe again rather than hold.` };
  }
  if (pct.guided !== null && pct.nohud !== null && pct.guided - pct.nohud >= 20) {
    return { id: 'hud-drop', text: `Pause timing fell from ${pct.guided}% with the HUD to ${pct.nohud}% without it. Feel the exhale settle before you squeeze.` };
  }
  if (red.length > scored.length / 2) {
    return { id: 'mid-breath', text: 'Most shots were fired mid-breath. Exhale normally, let the crosshair settle, then fire.' };
  }
  return { id: 'steady', text: 'Most shots landed in your natural pause. Keep the rhythm and try the No-HUD round again.' };
}
