# Native iOS quality audit

**Date:** 2026-10-13
**Scope:** Source review of the Expo SDK 57 / React Native 0.86.3 application, with native iOS audio lifecycle as the priority. Source changes and React hook regressions are recorded separately from physical-device behavior; no finding below is claimed as reproduced on a physical iPhone.

## Findings

### P1 — Explicit pause could resume microphone capture while Still said it was paused (source fix and hook tests; device unverified)

The reviewed pause path left `allowsRecording` enabled. The installed Expo Audio module can reactivate recording on foreground when recording is allowed, even for a prepared/paused recorder. The source fix now disables recording mode during the owned pause action and requires an explicit Resume action to re-enable it and resume capture. Fresh native facts are checked through the capture action path. React hook regressions cover the UI/control contract, but native foreground behavior has not been validated on a signed iPhone.

**Original review anchors:** `src/audio/useAudioCapture.native.ts:87-97` performed the unsafe pause sequence. Installed `node_modules/expo-audio/ios/AudioModule.swift:109-112,723-728` resumes prepared recorders on foreground when `allowsRecording` is true; `node_modules/expo-audio/ios/AudioRecorder.swift:121-128,160-168` accepts `.paused` as a recordable state.

**Remaining verification:** On a physical iPhone, pause, background and foreground without pressing Resume, then confirm the session and recorder remain inactive. Resume explicitly and verify one capture resumes. The source and React tests do not establish native runtime behavior.

### P1/P2 — Native recording can exceed the configured duration and become unsaveable

The UI stop threshold uses the configured limit, but asynchronous/native duration updates can overshoot it. For example, a nominal 600-second limit can produce a 600.125-second native clip. The save path rejects durations above 600 seconds, and a lower configured Speech cap may reject the clip again. The user can therefore finish a recording that cannot be saved or transcribed.

**Review anchors:** `App.tsx:1441-1467` gates the app-level stop on sampled duration; `src/audio/useAudioCapture.native.ts:111-145,230-242` samples duration and captures it at stop. Installed `node_modules/expo-audio/ios/AudioModule.swift:488-491` exposes `recordForDuration`, while `node_modules/expo-audio/ios/AudioRecorder.swift:218-221` resets duration tracking on completion. `src/services/controller.ts:2164-2169` rejects a saved clip above the hard cap and `:2887` enforces the configured Speech cap.

**Verify and fix:** Exercise the cap on-device under load and with delayed duration callbacks, including a configured cap lower than the platform maximum. Use the native duration limit where practical, but preserve a reliable measured final duration before the SDK completion/reset path. Propagate that exact measurement through stop, note save, and Speech validation. Do not clamp displayed or persisted duration with `Math.min` when the underlying clip is longer; report the true measurement and a truthful reason if the clip cannot be retained or uploaded. Test just below, exactly at, and just above each cap.

### P2 — Call/Siri interruption could leave UI state out of sync with the recorder (source recovery added; device unverified)

The native recorder may pause when an interruption begins without a dedicated JavaScript pause-interruption callback. Expo's end handling depends on `.shouldResume`; its resume routine can also restart recorders that still allow recording. The hook now coalesces native status samples into owned fresh reads, distinguishes cached initial SDK samples from actionable facts, and updates interruption/recovery status without granting a new capture action. Resume behavior and UI consistency across real call/Siri interruptions remain unverified on device.

**Original review anchors:** Installed `node_modules/expo-audio/ios/AudioModule.swift:565-612` pauses recorders when the AVAudioSession interruption begins; `:615-621` gates resumption on `.shouldResume`, and `:663-689` resumes players plus recorders that allow recording. `node_modules/expo-audio/ios/AudioRecorder.swift:189-240` emits finish/error/media-reset status, but no dedicated JavaScript pause-interruption callback. The original Still polling path was at `src/audio/useAudioCapture.native.ts:220-242`; the current hook uses coalesced owned fresh reads.

**Remaining verification:** Test incoming/outgoing calls, Siri, route changes, both `.shouldResume` outcomes, and foreground/background transitions while recording and paused. Compare native `isRecording`, `canRecord`, recorder status, Still's visible state, and timer. No dedicated JS pause-interruption callback is available, so validation must use fresh native facts and lifecycle-adjacent checks. Verify the implemented explicit-pause behavior prevents unintended resume and that the UI truthfully reflects native interruption state.

### P1 — A second recording could overwrite a previously saved recording (fresh-URI source fix and hook regression; device unverified)

Expo's recorder retains its native URI when `prepareToRecordAsync()` is called without options; Apple documents that `prepareToRecord()` overwrites an existing file at the recorder URL. Preparing without options can therefore destroy a saved recording when a later capture starts. Each new capture now explicitly passes complete native recording options, which causes the SDK to create a fresh UUID-backed file URL; Resume does not prepare a new recording. A React hook regression models the SDK's reused-URI behavior and checks that recording, stopping, saving, and starting a second capture leaves the first file unchanged.

**Remaining verification:** On a dedicated iPhone, record and save a clip, then start a second clip and confirm a distinct file is used and the first clip's bytes and playback remain unchanged. See Apple's [`prepareToRecord()` documentation](https://developer.apple.com/documentation/avfaudio/avaudiorecorder/preparetorecord%28%29). This source/test finding is not device-proven.

### P2 — Month-boundary usage settlement (fixed in controller tests; provider behavior unverified)

The reviewed source issue is fixed in controller commit `479e1eb`: model usage settlement is bound to the exact latest dispatch reservation, including its month and reserved amount. If that reservation belongs to a different month from the current ledger, settlement does not mutate the current month's ledger. This does not establish a historical-month ledger guarantee, and provider billing behavior remains unverified.

**Original review anchors:** `src/services/controller.ts:2789-2804` used current rolled state and a newly computed reserve. The Speech reservation was already passed through its exact month/day/amount at `:2807-2825`; model request reservation begins at `:2756-2774` and settlement is invoked at `:5781-5791`.

**Code/test verification:** Root and Astra accepted three public controller regressions at 12:32:14 SGT on 2026-10-13, within a 44-test controller-public-test run: an October Assist settles while a November Assist is pending without changing November usage; an October reply error with usage does not affect pending November usage; and two concurrent identical-note requests each dispatch and settle, while a third cached call performs no extra fetch or charge. These mock tests verify attribution logic only; they are not provider or invoice evidence. No global test count is asserted here.

## Priority and performance follow-up

The month-boundary model settlement issue is fixed at source and controller-test level as described above; actual provider behavior is unverified. Explicit pause and interruption recovery have source-level fixes and React hook tests, and the second-recording overwrite path has a fresh-URI source fix and regression. All three still require physical-device validation. The native duration/final-measurement and save/upload-cap policy remains open.

After those correctness changes, profile a release build on a representative iPhone before optimizing. Review anchors from the audit include the workspace/capture subscription in `App.tsx:803`, repeated sorting and freshness-fingerprint serialization in `App.tsx:958,992`, and the analysis cache keyed by transcript/settings fingerprints near `src/services/controller.ts:1146,2599-2611`. Recording meter/duration updates can trigger repeated derived work. Isolate rapidly changing capture UI and memoize derived views only if a release-profile trace shows a measurable issue. Add a small, bounded analysis-cache eviction policy only after measuring its size and reuse; keep revision checks intact.

Preserve the controller's serialized mutation boundary: clone and validate before persistence, persist atomically, then publish the new snapshot. The codebase is large enough that broad controller refactoring without representative profiling and regression coverage would add risk. Existing web/native aliases and mocks are useful unit coverage, but they are not a substitute for physical-device behavior tests.

The separate privacy-lease review added a recorder termination proof for resolved no-op `stop()` calls. A lease remains held until the stop is verified by native state (or the approved audio-mode disable sequence); false status flags alone do not prove termination. The original clip's URI/identity is retained through ambiguous replacement status and a wrong callback URI is blocked, but durable pending-capture recovery across process restart is not implemented. A last-known original duration is not the final decoded measurement; neither that sample nor the source lifecycle tests close the duration-cap/final-measurement finding.

**Phase 20 source/test checkpoint:** Capture lifecycle and fresh-file changes were committed in `577bce9`; React hook regressions exercise the source contracts described above. Root reported 551 tests across 53 files at 12:59:33 SGT on 2026-10-13, with typecheck passing and lint at zero errors/40 existing warnings. The native-focused set had 31 tests. Web and unsigned iOS JavaScript exports also passed, but neither compiles or executes the Swift module. All physical iPhone rows in [`IOS_VALIDATION.md`](IOS_VALIDATION.md) remain NOT RUN. These results do not establish native microphone behavior, exact final decoded duration, or provider acceptance.

## References

- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- [React `act`](https://react.dev/reference/react/act)
- [Vitest test environments](https://vitest.dev/guide/environment.html)
- [React: Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)
- [Expo Audio SDK documentation](https://docs.expo.dev/versions/latest/sdk/audio/)
- [React Native performance overview](https://reactnative.dev/docs/performance)
- [React Native testing overview](https://reactnative.dev/docs/testing-overview)
- [Expo SQLite SDK documentation](https://docs.expo.dev/versions/latest/sdk/sqlite/)
- [TypeScript `strict` compiler option](https://www.typescriptlang.org/tsconfig/strict.html)
