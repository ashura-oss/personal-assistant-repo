# Iteration log

The project follows the orchestration policy in the workspace task: the orchestrator owns product and architecture decisions, the Luna high coding agent implements the assigned UI/audio/configuration scope, and the Astra medium specialist provides research and review. Delegated work must not make new product decisions or expand external side effects. Credentials are deliberately absent until the user returns to configure them.

## 2026-10-12 · specialist-research

- Established the SDK 57 / React Native / React version baseline and first-party provider setup gates.
- Defined local-first audio, provider limits, exact approval binding, account identity isolation, backup caveats, and release checks.
- No keys, provider requests, resources, or external messages were used.

## 2026-10-12 · implementation pass 1

- Added Expo app/package configuration, the dark three-tab shell, local record and review flows, Library/Markdown editor, Settings, and platform-specific audio adapters.
- Native capture uses Expo Audio and app documents; web capture persists actual MediaRecorder Blobs in IndexedDB.
- Added retryable pending capture state so a storage failure does not throw away an already stopped clip.
- Added editable manual transcript fallback, explicit post-save Azure transcription action, and no live inference or auto-send.
- Added credential entry and removal using platform storage, with browser credentials held in volatile memory only.
- Verification is in progress. The web preview started once but the bundle waits for the shared controller to land; no physical-device behavior is claimed.

## Specialist review 01

- Confirmed Expo Audio supports document-directory recording; set both background audio flags false.
- Confirmed browser object URLs cannot be treated as durable audio; audio Blobs are stored in IndexedDB and recreated for playback/upload.
- Clarified configured accounts are not connected accounts and direct browser provider access needs a real CORS test.
- Confirmed built-in local storage is not inherently encrypted and device backup inclusion must not be denied without verification.

## Specialist review 02

- Changed browser audio writes to wait for IndexedDB transaction commit and preserve an unsaved clip across quota/write failures for retry.
- Changed native capture cancellation to delete only an explicitly discarded, unsaved capture; saved recordings remain untouched.
- Preserved retryable native recording URIs across cleanup errors; added meter and cleanup paths around capture.
- Corrected browser MP4 audio naming and object-URL cleanup after playback.

## Implementation pass 2 · provider identity and action review

- Connected the system-browser PKCE handoff to the fixed-endpoint provider exchange and the core's mandatory identity/token-readback verifier. A connected state now appears only after the verified installer succeeds; failure attempts to delete the newly stored token, while reconnect does not replace the previous token before verification.
- Added per-provider Connect, Reconnect, Disconnect, Sync, and partial-sync Continue controls under a shared busy lock. Setup details remain collapsed; public-client and redirect configuration is separate for native and web. No real provider login was initiated.
- Added explicit Draft in mailbox / Send email choices. Send is not inherited from the provider's compose grant; the selected capability and verified grant both gate the action. Calendar write selection includes calendar read so a destination can be chosen.
- Updated the full roadmap for identity-specific sync/dispatch, native EventKit, context summaries and decisions, task lifecycle, voice-relative time anchoring, reply threading, import/restore boundaries, and the connector registry.

## Remaining implementation/verification

- Root browser review at 390×844 verified the manual-note save, local preview processing into two suggestions, exact-revision approval invalidation after edits, re-approval, and a separate local execution action. Remaining phone/tablet and assistive-technology checks are open.
- Core integration now includes local notification schedule/cancel support and regression coverage; actual iPhone permission and delivery behavior remain unverified.
- At this early implementation pass: 56 tests passed across five files, TypeScript passed, lint had zero errors, Expo Doctor and Expo package compatibility passed, and iOS JavaScript/web exports succeeded. Later verification snapshots below supersede these results; the iOS export is not a signed native build.
- No credentials were entered and no external requests, account connections, sends, cloud provisioning, or deployment occurred.
- Added platform-specific public OAuth client configuration, strict native scheme/redirect build validation, HTTPS/loopback Microsoft SPA callback validation, Google native reverse-client validation, allowlisted Microsoft authority, selectable scope UI, and system-browser code + S256 PKCE exchange. Google web sign-in stays disabled until a confidential backend is available. The code path is implemented but still unverified with real registered accounts.
- Added an in-memory web token store and native SecureStore adapter, with core readback and identity verification before a connected account is installed; added account sync/continuation controls, separate email draft/send operations, and full calendar event fields. Email send and calendar write still require a verified provider capability. Event times use the device's IANA time zone until explicit-zone conversion is tested.
- Open gates: physical iPhone capture/playback/interruption/storage testing; Azure Speech and Luna with user-supplied credentials; Google/Microsoft PKCE identities and sync; real email/calendar execution and ambiguous-result reconciliation; backup/import and privacy validation; signed TestFlight build and release QA.

## Implementation pass 3 · saved-note assistance and task lifecycle

- Split the saved-note assistance view into a readable UI module. It offers one primary “Assist with this note” action, optional intent/question controls, revision-bound summary/answer/decision/citation results, and manual clarification prompts. Offline responses are visibly labeled as previews; no background follow-up or automatic chunking is used.
- Added the bounded request-size control in KB (4–96 KB, default 24 KB) and kept the separate output-token cap (default 1,200, maximum 2,400). The UI calls 6,000 tokens an approximate English-language equivalent; the enforced request limit is serialized bytes. Known-rate-only budget estimates remain labeled.
- Audio capture now passes its original capture timestamp and timezone to note storage, including save retries; manual notes use their save time. Relative-date interpretation remains unverified.
- Added distinct open/completed Library tasks. Completion and reopening are explicit; neither proposal approval nor an external action receipt changes task state.
- Root's previous 390×844 browser review verified manual save, local preview proposals, exact-revision approval invalidation, re-approval, and a separate local action. This iteration's assistant, task controls, and request-size settings still need browser visual/interaction review. No provider calls or real credentials were used.
- Verification at the end of implementation pass 3: TypeScript passed; 78 tests passed across six files; Expo dependency compatibility and Expo Doctor passed; iOS JavaScript and web exports passed. Lint had zero errors and 21 warnings, all outside the UI modules. Later core correctness changes mean the latest exports must be rerun. The iOS bundle export is not a signed native build.

## Implementation pass 4 · analysis freshness and source context

- Note detail displays the original capture timestamp/timezone separately from an answer's exact “as of” timestamp/timezone. Same-bucket cached answers retain their original timestamp; local freshness is rechecked at the 15-minute bucket boundary. Refresh still happens only after the user presses the action.
- Typed questions route explicitly through Answer mode; selecting Assist, Summarize, or Extract clears the previous question so it cannot change the next request.
- Opening a saved note triggers the controller's local source-version check. The view keeps the saved response visible but marks stale or unverifiable results and hides their reviewable suggestions. Opening an Inbox proposal performs the same local check and routes back to the note when the source set changed or could not be checked.
- Context disclosure reports the number of included sources and omitted sources, then shows friendly titles and exact selected excerpts. Transcript content remains visible in the editable transcript field.
- Inbox draft/approved actions are rechecked locally before review and while their review sheet remains open; stale or unverifiable sources pause mutations. Historical accepted, executed, simulated, dismissed, and unknown proposals stay readable from Saved actions. The screen shows the proposal payload and any available provider/local reference, but does not yet persist an immutable dispatch record containing the account identity, destination, and approved payload; displayed account/calendar names resolve against current settings.
- Freshness signatures include nonsecret account identity/capability/connection state and sync completion/partial metadata, so disconnects and account sync changes invalidate old context. Secrets and token values are never included.
- Verification for this pass: `npm run typecheck`, `npm run lint` (zero errors; 21 warnings outside UI), and `npm test -- --run` (78 tests across six files) pass. Root browser review passed stale-analysis refresh, typed task-count answers, task deduplication, action history, and the final 390×844 question-chip layout. Proof screenshots: `docs/screenshots/assistant-answer.jpg`, `docs/screenshots/record-home.jpg`, and `docs/screenshots/library-tasks.jpg`. Latest iOS/web exports remain pending after the subsequent core correctness changes. No provider/API requests were made.

## Implementation pass 5 · provenance refresh and credential lifecycle (2026-10-13)

- Root independently verified 80 tests and TypeScript typecheck. Latest web and iOS JavaScript exports passed; the iOS result is unsigned bundle output, with no signed native build or device proof. These results supersede earlier pending-export statements; earlier pass entries remain historical snapshots.
- Browser migration review reopened a legacy MEMORY draft with no verifiable source history. The UI showed the blocking reason and an explicit route to its note. Refreshing the local response produced current proposal provenance; Review contained only the memory suggestion, the previously executed groceries task was not resurrected, and approval became available. Dismissal remains available for stale pending drafts. Proof: `docs/screenshots/review-fresh.jpg`.
- Proposal-specific freshness checks use each proposal's own immutable provenance and recheck while Review is open. Stale pending actions cannot be edited, approved, or executed until rebuilt; terminal history remains read-only. The UI exposes the source check reason and a route to re-run Assist.
- OAuth installation now goes directly through the controller, which allocates opaque token references and owns secure/volatile persistence, readback, identity verification, serialized install/refresh/delete, and durable cleanup retry. UI cleanup status reveals only a count and offers retry. No paid model/provider requests or real OAuth account connections were made.
- Still open: disconnecting an account during `dispatching` or `unknown` remote work is blocked until the frozen `DispatchRecord` phase records exact identity, destination, and payload. Local notification rollback is best effort. Native microphone, notifications, Keychain, redirect registration, and physical-device behavior remain unverified.
