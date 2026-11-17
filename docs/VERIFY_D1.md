# D1 verification checklist

Everything below was built without a camera session. Items marked **confirmed (docs)** were
checked against the SDK 3.5.0 package (`node_modules/@smartspectra/node-sdk`, its `.d.ts` files
and the Presage repo docs). Everything else needs a live run (`npm run spike`, then one session).

## Confirmed from docs/types (no live run yet)
- [x] Chest trace field: `metrics.breathing.upperTrace[]`, each `{ value, stable, timestamp }` (`Measurement`). The PRD's `{time, value, stable}` is really `timestamp`.
- [x] `timestamp` unit: µs since Unix epoch (`data-types.md`, `messages/generated.d.ts`). In Electron the renderer anchors `VideoFrame.timestamp` to `Date.now()` at the first frame (`js/renderer/timestamp.js`), so sample time is wall-clock comparable. STEADY stores `t = timestamp / 1000` (ms).
- [x] `timestamp` may arrive as a protobufjs `Long`; converted like the quickstart's `tsToNumber`.
- [x] Each `metrics` event carries the windowed slice since the previous emit (quickstart comments), not a cumulative buffer.
- [x] `upperTrace.stable` has no confidence of its own: it is inherited from the breathing-rate verdict (confidence ≥ 45).
- [x] Breathing rate `breathing.rate[]` (MeasurementWithConfidence), pulse `cardio.pulseRate[]`, talking `face.talking[].detected` (DetectionStatus).
- [x] `MetricType`, `ValidationCode`, `ProcessingStatus`, `SmartSpectraErrorCode` exported from `@smartspectra/node-sdk/renderer`.
- [x] `enableTelemetry` exists on the renderer options and is forwarded to the main process (`js/main/index.js`: `out.enableTelemetry = opts.enableTelemetry !== false`).
- [x] Renderer SDK acquires the camera itself and emits `streamAvailable(MediaStream)`, so the picture-in-picture uses the SDK's own stream (no second `getUserMedia` needed).
- [x] There is no auth-only API (no way to verify the key without starting a camera session), so the key was not smoke-tested.

## Needs the live spike (`npm run spike`)
- [ ] **Auth on unsigned `npm start` (macOS keychain entitlement).** If `kAuthenticationFailed`, follow `nodejs/README.md` macOS notes / ask on Presage Discord. Also watch for the intermittent 503 (issue #18).
- [ ] **Telemetry really off.** Run `SMARTSPECTRA_DIAGNOSTICS=1 npm run spike` and check the SDK log for any telemetry session. Note what remains (licence/usage) for the post.
- [ ] **Hand-picked metrics accepted:** `[CHEST_BREATHING, BREATHING_RATE, PULSE_RATE, TALKING]`. The recording has a `metrics_requested` mark (`picked` or `bundles`). The fallback triggers only if the thrown error's `code === SmartSpectraErrorCode.kConfigurationFailed` (numeric 3); confirm the thrown `code` really is numeric.
- [ ] **Event cadence and samples/event** (summary line `cadence median … samples/event …`). Go needs cadence ≤ 1 s.
- [ ] **Time unit and alignment:** summary says `epoch-aligned`; compare the `first_ts_raw` mark to its wall time.
- [ ] **Revisions:** does a sample timestamp ever arrive twice, and does `stable` flip false → true? (summary `revisions … stable false→true …`). If never, the revision handling is harmless.
- [ ] **How often `stable` is false** (summary `unstable samples …%`). If it is false for most of a session, scoring greys everything: set `requireStable: false` in `src/core/detector.ts` `DEFAULT_OPTS` and say so in the post.
- [ ] **D (delivery delay)** median and p95. Go needs D ≤ 1.5 s. Note that D includes the first-frame anchor error of the SDK's timestamp mapping.
- [ ] **Trace during 5 s post-exhale holds stays valid** (summary `holds: …% valid`, needs ≥ 80% each).
- [ ] **Talking flag** fires during the 20 s counting segment and not outside it.
- [ ] **Paced cycles:** orientation sign and L per cycle (summary `paced: …`).
- [ ] **Picture-in-picture:** `pip_ok` mark (SDK stream rendered) and whether a second `getUserMedia` works while the SDK runs (`gum_second_ok/fail`; informational only).
- [ ] **Validation hints** (`validation` marks): which codes appear in normal room light.
- [ ] Verdict line: GO / DEGRADE / NO-GO per PRD §14. Cadence > 2 s is not covered by the PRD; the summary treats it as no-go.

## Needs one full live session (`npm start`)
- [ ] Calibration passes (|r| ≥ 0.3 and ≥ 2 of 3 cycles matched); note D and L ± spread.
- [ ] Sway feels connected (rendered `D_p95 + 100 ms` behind live); not nauseating.
- [ ] Detector thresholds (`k = 0.15`, `levelFrac = 0.3`, `minFlatMs = 300`, `smoothMs = 200`) are first guesses tuned on synthetic data only. Retune on the spike recording: `npm run replay -- recordings/<file>.jsonl` re-runs everything.
- [ ] Talking during a round greys the shots (+ 2 s).
- [ ] Report saved; `npm run replay -- "<userData>/steady/recordings/<session>.jsonl" --out a.json` twice gives identical files.
- [ ] Settings → Delete all data empties the sessions and recordings folders.
- [ ] Record the two bundled real recordings (one clean, one with a talking interruption), copy to `recordings/clean.jsonl` and `recordings/talking.jsonl`, and `git add -f` them (your own, consented data only).
- [ ] Log live minutes in `CREDITS.md` after every run.
