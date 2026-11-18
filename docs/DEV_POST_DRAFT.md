---
title: "STEADY: your breathing moves the crosshair"
tags: presagechallenge, devchallenge, electron, typescript
---

## What I Built

**Your breathing moves the crosshair, the way it moves a rifle.** STEADY is a seated breath-timing trainer for rifle and pistol shooters. Your webcam reads your chest breathing trace through Presage SmartSpectra, and that trace physically offsets the crosshair: zero sway in your natural respiratory pause (the still point after a normal exhale), maximum sway at full inhale. Fire in the pause and you hit; fire mid-breath and you miss red.

Shooters are coached to release the shot in the natural respiratory pause. Beginners can't see whether they do it; they only feel unsteady. Today that feedback needs a coach watching or a chest strap. A webcam is something every shooter already owns.

A session is consent → 45 s calibration → a 60 s **Guided** round (pause shaded green) → a 60 s **No-HUD** round (no help) → a report with every shot placed on your breathing curve.

## Demo

{{VIDEO_EMBED}}

## Code

https://github.com/sairammr/steady

```bash
npm install
cp .env.example .env   # add PRESAGE_API_KEY
npm start
```

No key or camera? `npm run replay -- recordings/real-session-1.jsonl` runs the whole detector and report on a bundled recording (a real 171 s session of mine: breathing trace, pulse, shots; numbers only, no video).

## How It Responds to Human Signals

**Signals used:** chest breathing trace (`breathing.upperTrace`, the core), breathing rate, pulse rate (calm/elevated vs your own baseline only), talking (`face.talking`) and SDK validation status.

- **Trace → sway.** Crosshair offset = `clamp((x − trough)/A, 0, 1) × maxOffset`, mostly vertical, drawn about 0.36 s behind live with interpolation because metrics arrive in chunks (median 33 ms apart).
- **Trace → pause → score.** Pause opens after an exhale when the trace is flat for ≥ 300 ms in the bottom 30 % of the breath, closes when the inhale starts or after 5 s. Score = hit accuracy × 1.0 in the pause, × 0.3 mid-breath. Final scores are computed post-round over the final trace with the same function that colours shots live.
- **Talking / weak signal → grey.** Shots while talking (+ 2 s) or with an invalid signal are not scored.

**Measured honesty** (method in the README):
- Delivery delay `D` (arrival − sample timestamp, no human in the loop): **105 ms** median, p95 261 ms (jitter above the fastest sample; the SDK stamps samples ~0.4 s ahead of the receiving wall clock, so raw arrival − timestamp is negative and STEADY maps the two clocks instead).
- Timing offset `L` from a paced guide (3 cycles, scheduled timestamps): **not reliable yet**: 265 ± 265 ms from 2 usable cycles on my first recording, 0 on the second. STEADY does not depend on it.
- Metrics cadence median 33 ms (p90 44 ms), 1 sample per event (~27.5 Hz), revisions: none (0 repeated timestamps).
- Detector: tuned on one real recording (17 pauses found vs 2 before tuning), then run unchanged on a second real session: 11 pause windows in 171 s. No held-out agreement score yet; two recordings is too few to claim one.
- My results: first full session: 0 % of 22 scored shots in the pause with the HUD (I was firing as fast as targets appeared), **33 % of 6 without it** once I slowed down. Honest, small, and the point: you can't feel this without feedback.
- Failure cases I saw: 9.5 % of samples invalid: `ChestNotVisible` when I leaned in to aim, `FrameRateTooLow` in dim light, `FaceNotForward`. Early builds paused the round on each one; it now keeps running through short dropouts (1.5 s grace, pause only after 5 s) and greys out shots in weak moments instead.

## Prize Categories

Best Overall Human-Sensing Experience · Most Creative or Delightful Use · Best Thoughtful Real-World Use.

## Consent and Data Handling

- **Consent first:** a consent screen runs before the camera opens: what is measured (chest breathing motion, breathing rate, pulse, talking, face presence), that processing is on-device, what is stored and what leaves the device. The camera starts only after "I agree"; a Camera off button is always visible; consent can be withdrawn in Settings. The copy asks you to be alone in frame, because the SDK tracks one face and the app cannot detect bystanders.
- **Stored (locally only):** session summaries and raw signal recordings (JSONL: breathing trace, breathing rate, pulse, talking/validity flags, timestamps, shots), used for replay and post-round scoring. **Never stored:** video frames or images; the webcam picture is display only.
- **Shared:** with nobody. No analytics, no crash reporting, no cloud.
- **Leaves the device:** Presage SDK key verification, usage metering and model download (key + device/licence info). SDK telemetry is disabled (`enableTelemetry: false`); the SDK forwards the flag to its main process (`js/main/index.js`). I have not captured network traffic to prove it. See Presage's [telemetry page](https://smartspectra.presagetech.com/docs/telemetry-and-privacy).
- **AI use:** no AI or LLM service runs in the app; the coaching insight is rule-based. Presage's on-device models compute the signals. The code was written with Claude Code (session below).
- **Not medical:** a training aid for breath timing; not a medical device; not for diagnosis. Pulse is only calm/elevated relative to your own session baseline.
- **Retention and deletion:** kept until you delete it. Settings → Delete all data removes every session summary and every raw recording.

## Agent Session

Built with Claude Code: PRD, detector tuning on my real recordings, UI and this post's numbers all came out of agent sessions, with every number re-measured by `npm run replay` on the bundled recording.

## Limitations

- Seated desk practice only: the SDK needs a still, silent, front-facing subject in even light. Not for a real shooting stance.
- The sway lags real breathing by ~105 ms median (p95 261 ms); the HUD says so.
- About 2.75 live minutes per session, so ≈ 18 sessions per free key.
- Tested on Apple Silicon only.
- Rifle/pistol natural-pause technique; archery's partial-exhale hold is not modelled.
- Detector thresholds were tuned on 2 of my own recordings; other people may need retuning.
- Real-shooter feedback: none yet..
