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

## D1 spike results (real, 2026-11-17, ~3 min)
Recording `recordings/spike-2026-11-17T09-40-03-163Z.jsonl`, committed as `test/fixtures/real-spike-1.jsonl`
(numeric trace/pulse/talking/marks only). Re-print: `npm run spike:summary -- test/fixtures/real-spike-1.jsonl`.
Plot: `docs/d1/real-spike-1.png` (`npm run plot -- <file> out.svg`, then `qlmanage -t -s 2400 -o <dir> out.svg`).

- [x] **Auth on unsigned launch:** worked (`scripts/launch.sh`, standalone app). Metrics flowed; `metrics_requested` = `bundles`.
- [x] **Event cadence:** median 33 ms (p90 44), 1 sample/event, ~27.5 Hz. Go needs ≤ 1 s.
- [x] **Time unit:** µs since epoch; `first_ts_raw` 1794908409502902 at wall 1794908409062.
- [x] **Clock offset, not delay:** arrival − sample t has median **−413 ms** (min −447, p95 ≈ −249, max +184):
  samples are stamped ~0.4 s AHEAD of the wall clock that receives them, so "arrival − t" cannot be a delay.
  STEADY now keeps it as `cal.clock_ms` (wall ↔ sample clock map, used for talking/validity intervals and
  display time) and reports **D = delivery jitter above the fastest sample: median 34 ms, p95 198 ms**
  (a lower bound). The absolute sensor/filter delay is not observable from timestamps; scoring absorbs it
  through `L` (paced) which is measured sample-time vs scheduled wall time.
- [x] **Revisions:** none (0 repeated timestamps, 0 stable flips).
- [x] **`stable` false 67% of samples** (it follows breathing-rate confidence). `requireStable` now defaults
  to `false` everywhere; validity, talking (+2 s) and gap guards stay.
- [x] **Holds** (judged by low slope, |slope| < k·A, from 1 s after HOLD): 81% / 83% / 78% flat → pause
  detectable. The trace drifts during a hold (range ≈ 35% of A), so range/coverage was the wrong test.
  Hold 1 was SDK-invalid (`FrameRateTooLow` from ~54 s to ~76 s): greyed live, though the trace looks fine.
  Hold 2 sits high in the local range (user likely inhaled before holding), so the level rule does not open
  a pause there (by design: a held top-of-inhale is not a natural pause); hold 3 is 48% inside a pause window.
- [x] **Talking flag:** fired on 36% of events in the 20 s counting segment, 0% outside; it started ~5 s
  after counting began. Every flagged event (+2 s) is `unknown`.
- [x] **Orientation:** the pause is at the **bottom** of this trace (sharp peaks, long flat troughs). Dwell
  asymmetry: 2.0× more time near the bottom → orient +1. The pacer correlation was weak (r −0.29 at the 3 s
  search edge) and is overridden; `cal.orient_by` records the method.
- [x] **Paced L:** 265 ± 265 ms from only 2 usable cycles (530, 0). Not reliable on this run (user did not
  track the pacer closely); visually the trace follows the pacer with ~0.3–0.5 s lag at orient +1.
- [x] **Picture-in-picture:** `pip_ok` (SDK stream 1280×720); `gum_second_ok`.
- [x] **Validation hints seen:** Ok, NoFaceFound (start), FrameRateTooLow (2×, ~22 s total), ChestNotVisible (2×, brief).
- [x] **Verdict: GO** (was NO-GO under the old range/stable hold test).
- [ ] **Telemetry really off** (SDK diagnostics log) — not checked in this run.

Detector retuned on this recording (`DEFAULT_OPTS`): smoothMs 300, slopeMs 300, k 0.2, minFlatMs 300,
levelFrac 0.35, maxPauseMs 5000, requireStable false. Replay: 2 → 17 pause windows over 3 min; 8 in the
60 s normal segment (~11 breaths; one shallow V-shaped trough is not a plateau and one breath falls in the
SDK-invalid span). Sway (|dy|, max 42 px): median 0.4 px in pause windows vs 19 px mid-breath, after adding
a 15% dead zone at the bottom of A (plateaus drift up to ~0.3 A above the 2-cycle trough; before it was 6.7 px).

## Needs one full live session (`npm start`)
- [ ] Calibration passes (|r| ≥ 0.3 and ≥ 2 of 3 cycles matched); note D and L ± spread. NB: on the D1 spike |r| was 0.29 with orient fixed by dwell, so this gate may reject real users.
- [ ] Sway feels connected (rendered `D_p95 + 100 ms` behind live); not nauseating.
- [x] Detector thresholds retuned on the D1 spike (above). Recheck on the first full session: `npm run replay -- <file>`.
- [ ] Is paced `L` stable across sessions? If its spread stays > 300 ms, judge shots at `wall − clock_ms` instead (judged_at = wall − clock_ms + a fixed filter delay).
- [ ] Talking during a round greys the shots (+ 2 s).
- [ ] Report saved; `npm run replay -- "<userData>/steady/recordings/<session>.jsonl" --out a.json` twice gives identical files.
- [ ] Settings → Delete all data empties the sessions and recordings folders.
- [ ] Record the two bundled real recordings (one clean, one with a talking interruption), copy to `recordings/clean.jsonl` and `recordings/talking.jsonl`, and `git add -f` them (your own, consented data only).
- [ ] Log live minutes in `CREDITS.md` after every run.
