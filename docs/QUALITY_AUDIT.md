# Native iOS quality audit

**Date:** 2026-10-13
**Scope:** Source review of the Expo SDK 57 / React Native 0.86.3 application, with native iOS audio lifecycle as the priority. This report records source-level risks and proposed verification; it does not claim that the findings have been reproduced on a physical device.

## Findings

### P1 — Explicit pause can resume microphone capture while Still says it is paused

The native hook's pause path leaves `allowsRecording` enabled. The installed Expo Audio module can reactivate the recording session on foreground resume when recording is allowed, including while the recorder remains paused. The native module accepts a paused recorder, and Still can continue displaying the paused state. This creates a mismatch between user expectation and microphone/session behavior.

**Review anchors:** `src/audio/useAudioCapture.native.ts:87-97` pauses the recorder and updates Still's status without disabling recording mode. Installed `node_modules/expo-audio/ios/AudioModule.swift:109-112,723-728` resumes prepared recorders on foreground when `allowsRecording` is true; `node_modules/expo-audio/ios/AudioRecorder.swift:121-128,160-168` accepts `.paused` as a recordable state.

**Verify and fix:** On a physical iPhone, start and pause recording, background Still, then foreground it without pressing Resume. Observe the native audio session and recorder state while Still remains paused. Under the existing serialized `runAction` ownership, pause should call `recorder.pause()`, await `setAudioModeAsync({allowsRecording:false})`, and verify the native inactive proof before reporting paused. Resume should explicitly re-enable recording mode and call `recorder.record()` within the owned capture action. Add a native regression around paused → background → foreground; the UI must remain paused and audio capture must not resume until explicit Resume.

### P1/P2 — Native recording can exceed the configured duration and become unsaveable

The UI stop threshold uses the configured limit, but asynchronous/native duration updates can overshoot it. For example, a nominal 600-second limit can produce a 600.125-second native clip. The save path rejects durations above 600 seconds, and a lower configured Speech cap may reject the clip again. The user can therefore finish a recording that cannot be saved or transcribed.

**Review anchors:** `App.tsx:1441-1467` gates the app-level stop on sampled duration; `src/audio/useAudioCapture.native.ts:111-145,230-242` samples duration and captures it at stop. Installed `node_modules/expo-audio/ios/AudioModule.swift:488-491` exposes `recordForDuration`, while `node_modules/expo-audio/ios/AudioRecorder.swift:218-221` resets duration tracking on completion. `src/services/controller.ts:2164-2169` rejects a saved clip above the hard cap and `:2887` enforces the configured Speech cap.

**Verify and fix:** Exercise the cap on-device under load and with delayed duration callbacks, including a configured cap lower than the platform maximum. Use the native duration limit where practical, but preserve a reliable measured final duration before the SDK completion/reset path. Propagate that exact measurement through stop, note save, and Speech validation. Do not clamp displayed or persisted duration with `Math.min` when the underlying clip is longer; report the true measurement and a truthful reason if the clip cannot be retained or uploaded. Test just below, exactly at, and just above each cap.

### P2 — Call/Siri interruption can leave UI state out of sync with the recorder

The native recorder pauses when an interruption begins, but Still may continue to report `recording` while the native recorder is paused. On interruption end, Expo reactivates the audio session and calls its player-resume routine only when the system supplies `.shouldResume`; that routine also restarts recorders that still allow recording. Without `.shouldResume`, the recorder remains paused while Still may still show `recording`; with it, an allowed recorder may resume without a Still Resume action. The SDK does not expose a dedicated JavaScript pause-interruption callback. A cached initial inactive status must not be treated as proof that a new interruption occurred; the hook needs fresh native facts.

**Review anchors:** Installed `node_modules/expo-audio/ios/AudioModule.swift:565-612` pauses recorders when the AVAudioSession interruption begins; `:615-621` gates resumption on `.shouldResume`, and `:663-689` resumes players plus recorders that allow recording. `node_modules/expo-audio/ios/AudioRecorder.swift:189-240` emits finish/error/media-reset status, but no dedicated JavaScript pause-interruption callback. Still's current state polling is in `src/audio/useAudioCapture.native.ts:220-242`.

**Verify and fix:** Test incoming and outgoing calls, Siri, route changes, both `.shouldResume` outcomes, and app foreground/background while recording and while paused. Compare native `isRecording`, `canRecord`, recorder status, Still's visible state, and timer. Do not wait for an SDK callback that is not exposed. Trigger a fresh native-fact sync from lifecycle-adjacent paths, serialized with capture actions, and use bounded polling only where required; distinguish the initial cached inactive seed from an actual later transition. Ensure explicit pause disables recording mode under the existing lease so Expo's conditional auto-resume cannot restart it. Preserve user intent and require explicit resume where appropriate. Add tests for initial cached state, fresh sync, and interruption/resume ordering.

### P2 — Usage settlement can charge the wrong month after a long request

The model response settlement path does not carry the reservation's usage month and amount through completion. If a request crosses a month boundary, rolling the ledger before settlement can debit or consume a different month's reservation, potentially changing later admission or charge accounting. The Speech path already ties settlement to its exact reservation; model settlement should use the same identity-bound approach.

**Review anchors:** `src/services/controller.ts:2789-2804` settles model usage using current rolled state and subtracts a newly computed reserve. The Speech reservation is passed through its exact month/day/amount at `:2807-2825`, with call sites at `:2968` and `:3031`. Model request reservation begins at `:2756-2774` and settlement is invoked at `:5781-5791`.

**Verify and fix:** With a deterministic clock, reserve usage immediately before a month boundary, advance the clock across the boundary while the request is pending, then settle success, rejection, timeout, and unknown outcomes. Carry the exact reservation month and amount through every model settlement/release path. Assert that only that reservation is settled and the new month's independent budget remains unchanged. Include duplicate/late settlement and retry fencing.

## Priority and performance follow-up

Fix and validate the pause/foreground-resume and interruption state mismatches first, then make native duration enforcement and save/upload policy consistent. Correct reservation-specific month settlement next. These findings are still open; they are source-review risks until native or deterministic tests demonstrate the fixes.

After those correctness changes, profile a release build on a representative iPhone before optimizing. Review anchors from the audit include the workspace/capture subscription in `App.tsx:803`, repeated sorting and freshness-fingerprint serialization in `App.tsx:958,992`, and the analysis cache keyed by transcript/settings fingerprints near `src/services/controller.ts:1146,2599-2611`. Recording meter/duration updates can trigger repeated derived work. Isolate rapidly changing capture UI and memoize derived views only if a release-profile trace shows a measurable issue. Add a small, bounded analysis-cache eviction policy only after measuring its size and reuse; keep revision checks intact.

Preserve the controller's serialized mutation boundary: clone and validate before persistence, persist atomically, then publish the new snapshot. The codebase is large enough that broad controller refactoring without representative profiling and regression coverage would add risk. Existing web/native aliases and mocks are useful unit coverage, but they are not a substitute for physical-device behavior tests.

The separate privacy-lease review already added a recorder termination proof for resolved no-op `stop()` calls. A lease remains held until the stop is verified by native state (or the approved audio-mode disable sequence); false status flags alone do not prove termination. That change does not close the pause-resume, interruption-state, or duration-limit findings above.

## References

- [React `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- [React: Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects)
- [Expo Audio SDK documentation](https://docs.expo.dev/versions/latest/sdk/audio/)
- [React Native performance overview](https://reactnative.dev/docs/performance)
- [React Native testing overview](https://reactnative.dev/docs/testing-overview)
- [Expo SQLite SDK documentation](https://docs.expo.dev/versions/latest/sdk/sqlite/)
- [TypeScript `strict` compiler option](https://www.typescriptlang.org/tsconfig/strict.html)
