// Position-based breath sway (PRD §8, v0.3): zero at the trough (the pause), max at full inhale.
export const MAX_OFFSET_PX = 42;
export const TREMOR_PX = 1.5;
// D1 real trace: exhale plateaus drift up to ~0.3 A above the 2-cycle trough, which left ~7 px median
// sway inside pause windows. The bottom DEAD_ZONE of A reads as zero offset.
export const DEAD_ZONE = 0.15;

/** Breath component only: mostly vertical (rifle rises with the chest), a little drift right. */
export function breathOffset(x: number, trough: number, A: number, maxOffset = MAX_OFFSET_PX): [number, number] {
  const frac = A > 0 ? Math.min(1, Math.max(0, ((x - trough) / A - DEAD_ZONE) / (1 - DEAD_ZONE))) : 0;
  return [round2(0.15 * frac * maxOffset), round2(-frac * maxOffset)];
}

/** Small fixed tremor, deterministic in time so replays match. */
export function tremor(tMs: number, amp = TREMOR_PX): [number, number] {
  const s = tMs / 1000;
  return [round2(amp * Math.sin(2 * Math.PI * 1.3 * s)), round2(amp * Math.sin(2 * Math.PI * 0.9 * s + 1))];
}

export function swayOffset(x: number, trough: number, A: number, tMs: number, maxOffset = MAX_OFFSET_PX): [number, number] {
  const [bx, by] = breathOffset(x, trough, A, maxOffset);
  const [tx, ty] = tremor(tMs);
  return [round2(bx + tx), round2(by + ty)];
}

/** Hit accuracy 0–100 from the swayed impact's distance to the target centre. */
export function accuracy(impact: [number, number], target: [number, number], radius: number): number {
  const d = Math.hypot(impact[0] - target[0], impact[1] - target[1]);
  return Math.round(Math.max(0, 100 * (1 - d / radius)));
}

const round2 = (v: number) => Math.round(v * 100) / 100 + 0; // + 0 normalises -0
