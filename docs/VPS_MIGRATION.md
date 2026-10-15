# Still PWA and portable server migration

Status: the selected product target remains an iPhone Home Screen PWA backed by a portable, server-owned workspace. The shared cloud workspace, session-owned recording flow, playback, cancellation, and editable provider/recording preferences are implemented in the development tree. The cloud entry point is deliberately not mounted: `App.tsx` still exports the legacy app, and `App.web.draft.tsx` is not the production entry point. No VPS or GCP VM has been selected or provisioned, and no iPhone installation has been verified. The latest local application gate passed 1,547 tests across 152 files; that does not establish provider, deployment, or device behavior.

## Current implementation

The server has a recursive closed workspace DTO codec with a generated schema, authenticated same-origin routes for authentication, workspace snapshot/refresh, explicit commands, receipt inspection, bounded command history, credential management, and audio upload and media access. The dispatcher now defines 13 commands: `settings.update`, `tasks.complete`, `tasks.reopen`, `chat.create`, `notes.save`, `notes.capture.adopt`, `accounts.installOAuth`, `notes.updateTranscript`, `notes.transcribe`, `assistant.batch.submitNote`, `assistant.batch.check`, `chat.submit`, and `chat.refine`. Transcription cancellation is an exact-command signal request only; its response confirms the cancellation signal, while the command receipt remains the source of the final outcome. Journal history exposes public command IDs, kinds, statuses, and integer epoch-millisecond timestamps with a scoped cursor, without request bodies, receipts, or workspace snapshots.

`GET /api/audio/upload-history` returns a current-owner, current-privacy-epoch page containing only upload ID, capture identity, status, and timestamps. It omits hashes, media metadata, paths, and adoption receipts. Selecting a history item is followed by an explicit `GET /api/audio/uploads/:id`; only a confirmed ready receipt can be explicitly adopted. The UI also supports a single explicit recording session, upload recovery by exact ID, saved-note adoption, playback through the authenticated same-origin media route, and explicit transcription. It does not auto-start capture, transcription, or AI work. Unknown upload or command outcomes remain held for inspection, and recording a note does not imply AI processing.

The web settings surface now saves provider mode, speech, reasoning-effort, recording-length, retention, and OpenRouter key settings through server-owned commands. It does not add app-level AI token or spending caps, and it displays provider-reported usage/cost only. The server has encrypted, session-bound OAuth handoff staging and the committed controller has verified-account installation contracts with opaque account IDs. The server-side atomic `accounts.installOAuth` journal integration and its migration/restart/second-authorization checks are still under active review; do not treat the dirty working-tree implementation as completed or deployed. OAuth provider adapters and fresh multi-account onboarding are not complete.

The authenticated cloud workspace is present as a shared UI composition, but it is not yet the app’s mounted or exportable product. `npm run export:pwa` still packages the legacy web app; its successful export is not evidence of this cloud composition or server-backed saves. Important browser-side domain actions remain disabled or incomplete. In particular, full mail and calendar connection/review/approval actions, proactive controls, memory and knowledge mutations, document editing, reminder/archive workflows, backup/recovery actions, and media export still need real server-owned commands and safe DTOs. The current provider adapter work is also incomplete. The server-backed PWA composition has not been validated against live OAuth or AI providers, a VPS/GCP deployment, a Linux host, or an iPhone.

New Batch submissions use input policy 2, removing the former per-source and source-count ceilings, selected-context ceiling, 48 KiB chat-history selection ceiling, and reply-text ceilings. Already saved policy-1 jobs retain their captured legacy behavior through recovery and refinement. Aggregate physical request, storage, response, and file limits remain. Note transcripts and Markdown content can use the existing 24 MiB aggregate backup restore allowance within the 32 MiB backup file bound; workspace snapshots retain a 16 MiB physical limit. These are storage and transport bounds, not AI usage quotas. Provider-reported cost and usage remain the only reported values; missing values stay unknown.

The PWA worker caches only the app shell and an explicit allowlist of hashed JavaScript/font assets, the manifest, and the app icon. It does not cache API responses, authentication or OAuth traffic, audio, uploads, secrets, or external URLs. A cached shell can open offline; authenticated workspace reads and writes require a connection. This describes the current packaging boundary, not evidence of cloud behavior on iPhone.

## Selected target and remaining work

The target is an installable iPhone Home Screen app with saved workspace data, private audio, and provider credentials owned by a portable Node service. The server should run on a private persistent volume with transactional SQLite, while the browser holds only temporary capture/playback material and the limited static app cache. A VPS or GCP VM may be chosen later; this document does not select a host or estimate current hosting cost.

Before the target can be mounted or deployed, the remaining work includes:

- Mount the authenticated cloud entry point and export the shared workspace composition; complete the remaining full mail/calendar approval, proactive, memory/knowledge, document, reminder, archive, backup, and recovery actions with server commands and safe display DTOs.
- Finish the multi-account OAuth stage-to-install implementation, durable journal/checkpoint behavior, provider adapters, and fresh onboarding UI. Verify restart, migration, duplicate, stale-session, and second-authorization cases before claiming account installation complete.
- Complete server-owned scheduling and delivery through Web Push, including eligibility, delayed execution, duplicate delivery, reconnect, unknown outcomes, and recovery.
- Define and test server backup, restore, retention, deletion, and privacy-erasure behavior for workspace data, credentials, and media.
- Produce and verify portable deployment and operations runbooks for a selected VPS or GCP VM, including TLS, secure cookies, secret protection, persistent storage, encrypted off-host backups, monitoring, upgrades, and restore.
- Verify the exported PWA on a physical iPhone, including Home Screen installation, authenticated workspace access, playback, recording recovery, offline shell behavior, and service-worker updates. Until that work is complete, the PWA is not a deployable or device-proven product.

Settlement and ownership rules distinguish admitted work from new actions: private owned actors preserve already-owned work until it drains, even if the browser session expires; newly admitted actions still require current browser authentication. Unknown outcomes are inspected by exact command or upload identity and are never automatically replayed. Restart-safe provider recovery and the complete end-to-end workflows remain open.

## Host selection and deployment

The server boundary is intended to remain portable across a VPS or GCP VM. No host is provisioned, and capacity, performance, backup cost, and operational requirements have not been tested. Compare current host offerings and operational needs when choosing a deployment; this document is not a price quote or availability commitment.

The personal API-only runtime planning baseline remains Ubuntu LTS with 1 vCPU, 2 GiB RAM, and 50 GB SSD. This sizing is unverified and is not a provider price quote. Build the PWA and server artifacts on the development PC, then deploy those artifacts to the selected host.

For iPhone installation, serve the finished PWA from the site root over HTTPS; in Safari, open the deployed site, use Share, then choose **Add to Home Screen**. This installation path becomes product-ready only after the cloud composition, endpoints, authentication, media, and provider flows are connected and verified.

The service worker does not call `skipWaiting`, claim open clients, or force a reload. During updates, the browser leaves a new worker waiting until old clients close; the first install may activate immediately but does not take over an already open tab. This avoids interrupting a recording session. The worker behavior does not establish that capture is saved to the server.

## Migration sequence

1. Mount the authenticated cloud entry point and export the shared workspace. Complete remaining browser domain actions and verify snapshot decoding, settings, receipt inspection, and revision/privacy fences end to end.
2. Finish durable multi-account OAuth install and provider adapters; verify fresh onboarding and explicitly selected provider actions. Preserve unknown outcomes for exact inspection and never automatically replay paid or external work.
3. Complete server-owned scheduling and Web Push, then verify duplicate delivery, delayed execution, reconnect, and recovery behavior.
4. Define and test backup, restore, retention, deletion, and privacy erasure; prepare runbooks for the selected VPS or GCP VM.
5. Deploy a private test instance, verify the full PWA on a physical iPhone, reconcile migrated data, and review a concrete production cutover and rollback plan before any production switch.

The existing native app, iOS EventKit path, signing workflow, and device-validation records are historical implementation evidence. They are not prerequisites or release evidence for the selected PWA and portable server target. A JavaScript export or browser mock also does not prove cloud, provider, or iPhone behavior.

Product requirements remain unchanged: use provider-reported usage and cost when available, preserve missing usage/cost as unknown, and add no estimates or app-level token/spend quotas. Paid work remains an explicit user action, with review before approval and provider execution kept separate where applicable. An unknown remote outcome must be explicitly reconciled; never automatically retry paid or external actions. No hidden provider reads or action replay should be introduced as part of moving storage to the server.
