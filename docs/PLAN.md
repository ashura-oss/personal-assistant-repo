# Product plan and verification status

## Product shape

Still is a quiet personal assistant, not a live conversational agent. The user records or types a thought, saves it locally, then may request a transcript or bounded extraction. The assistant can prepare editable proposals and gather relevant personal context. It cannot approve its own proposal. Every approval binds to the exact current revision; editing the transcript, recipient, destination, time, title, or body invalidates that approval. External sends and calendar writes require a separately connected, verified identity and a distinct user action.

The full intended scope includes personal memory and rule editing, recorded-audio transcription, bounded Luna analysis, Gmail and Microsoft identity-specific draft/send flows, inbox and calendar sync, reminders, searchable Markdown, export/import, privacy controls, and an iOS beta release. The product is a single-turn assistant: it should answer questions from local context, summarize, and propose decisions/actions, without adding live conversation. Tasks need an open/completed lifecycle independent of whether an external action received an acceptance receipt. Voice-relative dates need a captured timezone and timestamp anchor. Reply-in-thread support needs explicit `replyTo`, `inReplyTo`, and `references` fields after identity and sync are proven. Local iOS calendars (EventKit) are a separate provider with permission and ownership checks. Future third-party providers should use an explicit connector registry; WhatsApp is out of scope. Import/restore must exclude credentials, verified identity state, and executable approvals.

## Capability ledger

Status meanings: **implemented** means code is present; it may still need a platform test. **configured** means app configuration exists but has not been validated on a signed device. **mock** means deliberately local simulation, never an external provider action. **unverified** means code or configuration needs a real provider/device check. **not implemented** means a planned capability still needs code.

| Capability | Status | Boundary / next proof |
|---|---|---|
| Dark, portrait-first Inbox / Record / Library navigation and Settings | Implemented; web visual review passed at 390×844 | Native visual review on iPhone remains required. |
| Native microphone permission, document-directory recording, pause/resume/stop/cancel and level meter | Implemented; unverified | Verify denial, interruptions, phone lock, low storage, and device audio mode on physical iPhone. |
| Browser microphone capture with MediaRecorder and IndexedDB Blob persistence | Implemented; unverified | Verify secure context, Safari/Chromium MIME output, quota failure/retry, reload, and download. |
| Write a note manually; edit a transcript | Implemented; web flow verified | Controller revision/invalidation regression tests pass. |
| Audio playback and explicit local export | Implemented; platform exports compile | Check saved native format and browser URL cleanup on devices/browsers. JSON export includes metadata/transcripts/settings and excludes audio; audio can be exported separately per note. |
| Azure Speech credential fields and secure-store adapters | Configured; provider unverified | Requires user's real resource and key. Browser CORS and accepted media formats remain unverified. No automatic upload: user invokes transcription after the clip is durably saved. |
| Manual transcript as a no-credential fallback | Implemented | User text is editable; only saved text can be analyzed. |
| Preview extraction from transcript evidence | Mock/local | Deterministic rules create reviewable proposals only. They do not create an email, event, reminder delivery, or sent receipt. |
| GPT-6 Luna reasoning effort, bounded request, structured output and usage ledger | Implemented; Azure unverified | Requires an entitled Azure deployment and credentialed schema, cost, retry, and daily-cap tests. Requests use no persistent provider storage. |
| Proposal evidence, edits, exact-revision approval, dismissal, and execution state | Implemented; core regression tests pass | Web verified: edit invalidates approval, re-approval binds the revision, local execution is separate. Verify stale approval, identity/destination binding, retries, concurrency, and ambiguous response recovery against real providers. |
| OAuth setup cards and browser authorization-code + PKCE bridge | Implemented; provider flow unverified | System-browser handoff validates state, exact redirect and S256 PKCE. Token exchange uses fixed provider endpoints and verifies provider identity, Microsoft Graph `/me`, and selected read probes. Microsoft web SPA and native callbacks are supported; Google web is explicitly disabled because code exchange requires a confidential backend. No real provider account was connected during development. |
| Per-provider accounts, identity verification, secure token install, disconnect and sync controls | Implemented; provider flow unverified | Native tokens use SecureStore; browser tokens are volatile. Core reads back and validates the token before connecting an account. Provider registration, consent, token refresh/revocation, reconnection, and multi-account sync need credentialed tests. Configuration never implies a verified connection. |
| Provider scopes | Configured in UI; consent unverified | Capabilities are separately chosen; mail sending is opt-in. Calendar write automatically includes calendar read for destination selection. The connector must intersect requested capabilities with actually granted scopes. |
| Gmail and Microsoft inbox read, incremental sync, reconciliation, and notifications | Implemented in connector/controller; unverified | Per-account sync and continuation are wired, with bounded paging/cursors. Provider consent and real multi-account, duplicate, revoked-token, and expired-cursor checks remain. No permanent phone polling promise. |
| Exact email draft and send against the selected account | Implemented behind exact approval; unverified | Review selects Draft in mailbox or Send email separately. Draft requires `mail.draft`; send requires `mail.send`. Provider acceptance is labelled as acceptance, not delivery. Test only with explicit provider registration and a safe recipient. |
| Calendar identity, event proposal, edit and write | Implemented behind exact approval; unverified | Require a verified writable calendar, local date/time with device IANA zone, complete event payload, and a separate action. Provider event creation and invitation behavior need tests. Google/Microsoft calendars are current; native EventKit remains planned. |
| Native local reminders | Implemented; native delivery unverified | Notification permission, schedule/cancel adapter, future-date validation and reconciliation are present. Verify permission denial, timezone/DST, reboot and delivery on physical iPhone. Browser cannot promise an alert while the tab is closed. |
| Search notes, project Markdown, edit personal profile/rules, export | Implemented for local app state; broader project model not implemented | Add revision/hash safeguards, import, conflict recovery, and optionally user-selected export location. |
| Person / project identity, confidence provenance, and inference editing | Not implemented | Separate user-authored facts, extracted source evidence, and uncertain inference. Ask users before persisting inferred identity. |
| Token, attempts, daily requests, recording duration, retention and budget bounds | Implemented; regression tests pass | Verify actual Azure request limits, ambiguous-call accounting and cost rates after credentials are supplied. |
| Background audio | Disabled | Recording is tap-to-start and foreground-only. No always-listening entitlement is requested. |
| Background sync / refresh | Not implemented | Use foreground catch-up first; background execution is discretionary and cannot be promised on force-quit iOS. |
| Personal-context question answering, summaries, and decision review | Planned | Use local selected context and bounded Luna requests; retain evidence, cost/attempt limits, and the single-turn/no-live-session boundary. |
| Task open/completed lifecycle, people/projects, and inference editing | Partially implemented / planned | Proposal execution is an action receipt, not task completion. Add explicit task lifecycle, project/person models, confidence provenance, and edits to inferred facts. |
| Voice-relative date anchoring and reply-in-thread email | Planned | Store capture timezone/timestamp for relative dates. Add source-linked reply threading only after sync and identity separation are proven. |
| Native iOS Calendar (EventKit) integration | Planned | Request native calendar permission, establish calendar ownership/writability, and review permission denial and local/iCloud behavior. Separate from Google/Microsoft connectors. |
| Import/restore and portable backup | Not implemented | Exclude secrets, verified provider identity, and executable approvals. Define merge/conflict behavior and separately choose whether audio files are included. |
| Future connector registry | Planned | Add providers through an explicit registry and capability mapping. WhatsApp is excluded. |
| Native database, Markdown, Keychain and backup privacy | Configured; device behavior unverified | SQLite/private app storage is not automatically encrypted; do not claim backup exclusion. Validate deletion, reinstall/Keychain lifecycle and export. |
| Signed iOS build, TestFlight, public release | Not implemented | Requires Apple signing, App Store Connect setup, native QA, privacy declarations, and user approval of the concrete build. |

## Setup gates

Before provider testing, users need an Azure Speech resource/key and a GPT-6 Luna deployment/key with a configured deployment name. For account integrations, register Google and Microsoft public clients with provider-supported authorization-code-plus-PKCE redirects; do not bundle client secrets. The application needs its final bundle identifier, redirect URI registrations, Apple signing, and required provider review/consent. Browser preview keys are volatile; browser direct-provider requests have not been proven to satisfy CORS.

Before external execution, validate the active account, recipients (including all copied recipients), subject/body, attachments, calendar destination, attendees, and due time against the approved immutable payload. A provider acceptance receipt is not delivery confirmation. An ambiguous timeout enters a reconciliation state and must not trigger an automatic blind retry.

## Acceptance checks by phase

1. **Local workflow:** clean install, blank state, capture/manual note, offline save, transcript edit, delete, document edit, reload persistence, browser export, no fake accounts.
2. **Audio:** permission denial, pause/resume, cancel confirmation, interruption recovery, max length, offline stop then reopen/playback, IndexedDB quota retry, audio preservation after transcription error.
3. **Reasoning:** bounded context and output, exact evidence quotes, no extra prose, Luna effort none/low only, no auto-send, budget enforcement, repeated-attempt caps, and no silent fallback from provider error to mock.
4. **Approval:** mutate each bound field after approval and confirm invalidation; race two execute actions; restart while dispatching; handle provider accepted-but-unknown; reconcile rather than duplicate.
5. **Identity and sync:** two Google accounts and two Microsoft accounts, reconnect/revocation, per-account cursor, duplicate notification, expired cursor/full resync, non-writable calendar, and one user's identity never used for another account's draft.
6. **Native release:** physical iPhone development build; microphone denial/interruption/lock; Keychain write/delete/reinstall; system browser PKCE redirects; timezone/DST local notification; real AAC provider transcription; background/force-quit behavior; export and restore. Web export is not a substitute.

## Current verification snapshot (2026-10-12)

- `npm run test`: 56 tests pass across 5 files, including token deletion races, controller, provider connector, Azure, and auth bridge coverage.
- `npm run typecheck`: passes.
- `npm run lint`: no errors; remaining warnings are unused variables and array-type style in core/connector/service code.
- `npx expo export --platform ios --output-dir dist/ios-js`: succeeds (JavaScript bundle only; this is not a signed iOS app).
- `npx expo export --platform web --output-dir dist/web`: succeeds.
- Expo Doctor and `npx expo install --check`: pass after SDK package alignment.
- Browser walkthrough verified manual note save, processing into two local preview suggestions, editing invalidating approval, re-approval, and a distinct local execute action. The OAuth flow, Azure transcription, native capture/reminders, and remote account actions still require platform registration/device/provider tests.

## Delivery sequence

1. Complete and review the local capture, edit, persistence, playback, and export loop.
2. Validate Azure Speech and GPT-6 Luna against the user's selected resources, with no live inference until credentials and provider acceptance tests are available.
3. Complete Google and Microsoft identity flows, then per-account read/sync with no send permission until scopes and verification are approved.
4. Add reminder scheduling and calendar writes with platform-specific permission and delivery behavior.
5. Complete exact-payload approval, dispatch, audit, ambiguous-result reconciliation, backup/import, and privacy review.
6. Build, test, and distribute a signed TestFlight candidate; publish only after explicit release approval.
