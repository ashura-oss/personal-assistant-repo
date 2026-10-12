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
- Current checks: 56 tests pass across five files, TypeScript passes, lint has zero errors (remaining warnings are in core/connector style and unused variables), Expo Doctor and Expo package compatibility pass. iOS JavaScript and web exports both succeed; the iOS export is not a signed native build.
- No credentials were entered and no external requests, account connections, sends, cloud provisioning, or deployment occurred.
- Added platform-specific public OAuth client configuration, strict native scheme/redirect build validation, HTTPS/loopback Microsoft SPA callback validation, Google native reverse-client validation, allowlisted Microsoft authority, selectable scope UI, and system-browser code + S256 PKCE exchange. Google web sign-in stays disabled until a confidential backend is available. The code path is implemented but still unverified with real registered accounts.
- Added an in-memory web token store and native SecureStore adapter, with core readback and identity verification before a connected account is installed; added account sync/continuation controls, separate email draft/send operations, and full calendar event fields. Email send and calendar write still require a verified provider capability. Event times use the device's IANA time zone until explicit-zone conversion is tested.
- Open gates: physical iPhone capture/playback/interruption/storage testing; Azure Speech and Luna with user-supplied credentials; Google/Microsoft PKCE identities and sync; real email/calendar execution and ambiguous-result reconciliation; backup/import and privacy validation; signed TestFlight build and release QA.
