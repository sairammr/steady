---
title: "STEADY: your breathing moves the crosshair"
tags: presagechallenge, devchallenge, electron, typescript
---

<!-- DRAFT. Every {{PLACEHOLDER}} must be replaced with a measured number from a real run. Do not publish synthetic numbers as results. -->

## What I Built

**Your breathing moves the crosshair, the way it moves a rifle.** STEADY is a seated breath-timing trainer for rifle and pistol shooters. Your webcam reads your chest breathing trace through Presage SmartSpectra, and that trace physically offsets the crosshair: zero sway in your natural respiratory pause (the still point after a normal exhale), maximum sway at full inhale. Fire in the pause and you hit; fire mid-breath and you miss red.

Shooters are coached to release the shot in the natural respiratory pause. Beginners can't see whether they do it; they only feel unsteady. Today that feedback needs a coach watching or a chest strap. A webcam is something every shooter already owns.

A session is consent → 45 s calibration → a 60 s **Guided** round (pause shaded green) → a 60 s **No-HUD** round (no help) → a report with every shot placed on your breathing curve.

## Demo

{{VIDEO_EMBED}}

## Code

{{REPO_URL}}

```bash
npm install
cp .env.example .env   # add PRESAGE_API_KEY
npm start
```

No key or camera? `npm run replay -- recordings/clean.jsonl` runs the whole detector and report on a bundled recording {{CONFIRM_BUNDLED_REAL_RECORDING}}.

## How It Responds to Human Signals

**Signals used:** chest breathing trace (`breathing.upperTrace`, the core), breathing rate, pulse rate (calm/elevated vs your own baseline only), talking (`face.talking`) and SDK validation status.

- **Trace → sway.** Crosshair offset = `clamp((x − trough)/A, 0, 1) × maxOffset`, mostly vertical, drawn {{D_DISPLAY}} s behind live with interpolation because metrics arrive in chunks every {{CADENCE_MS}} ms.
- **Trace → pause → score.** Pause opens after an exhale when the trace is flat for ≥ 300 ms in the bottom 30 % of the breath, closes when the inhale starts or after 5 s. Score = hit accuracy × 1.0 in the pause, × 0.3 mid-breath. Final scores are computed post-round over the final trace with the same function that colours shots live.
- **Talking / weak signal → grey.** Shots while talking (+ 2 s) or with an invalid signal are not scored.

**Measured honesty** (method in the README):
- Delivery delay `D` (arrival − sample timestamp, no human in the loop): **{{D_MS}} ms** median, p95 {{D_P95_MS}} ms.
- Timing offset `L` from a paced guide (3 cycles, scheduled timestamps): **{{L_MS}} ± {{L_SPREAD_MS}} ms**. It includes my pacer-following delay, so it is a per-user offset, not sensor latency.
- Metrics cadence {{CADENCE_MS}} ms, {{SAMPLES_PER_EVENT}} samples per event, revisions: {{REVISIONS}}.
- Detector agreement on held-out recordings: {{AGREEMENT}} of paced inhales within ±500 ms across {{N_RECORDINGS}} recordings.
- My results: {{GUIDED_PCT}} % of shots in the pause with the HUD, **{{NOHUD_PCT}} % without it**.
- Failure cases I saw: {{FAILURES}} (e.g. long holds, talking, lighting).

## Prize Categories

Best Overall Human-Sensing Experience · Most Creative or Delightful Use · Best Thoughtful Real-World Use.

## Consent and Data Handling

- **Consent first:** a consent screen runs before the camera opens: what is measured (chest breathing motion, breathing rate, pulse, talking, face presence), that processing is on-device, what is stored and what leaves the device. The camera starts only after "I agree"; a Camera off button is always visible; consent can be withdrawn in Settings. The copy asks you to be alone in frame, because the SDK tracks one face and the app cannot detect bystanders.
- **Stored (locally only):** session summaries and raw signal recordings (JSONL: breathing trace, breathing rate, pulse, talking/validity flags, timestamps, shots), used for replay and post-round scoring. **Never stored:** video frames or images; the webcam picture is display only.
- **Shared:** with nobody. No analytics, no crash reporting, no cloud.
- **Leaves the device:** Presage SDK key verification, usage metering and model download (key + device/licence info). SDK telemetry is disabled (`enableTelemetry: false`), {{TELEMETRY_VERIFIED_HOW}}. See Presage's [telemetry page](https://smartspectra.presagetech.com/docs/telemetry-and-privacy).
- **AI use:** no AI or LLM service runs in the app; the coaching insight is rule-based. Presage's on-device models compute the signals. The code was written with Claude Code (session below).
- **Not medical:** a training aid for breath timing; not a medical device; not for diagnosis. Pulse is only calm/elevated relative to your own session baseline.
- **Retention and deletion:** kept until you delete it. Settings → Delete all data removes every session summary and every raw recording.

## Agent Session

{{AGENT_SESSION_EMBED}} (keys scrubbed)

## Limitations

- Seated desk practice only: the SDK needs a still, silent, front-facing subject in even light. Not for a real shooting stance.
- The sway lags real breathing by {{D_MS}} ms; the HUD says so.
- About 2.75 live minutes per session, so ≈ 18 sessions per free key.
- Tested on Apple Silicon only.
- Rifle/pistol natural-pause technique; archery's partial-exhale hold is not modelled.
- Detector thresholds were tuned on {{N_REAL_RECORDINGS}} of my own recordings; other people may need retuning.
- Real-shooter feedback: {{SHOOTER_QUOTE_OR_NONE}}.
