# Still PWA and portable server migration

Status: the selected product target is an iPhone Home Screen PWA backed by a portable, server-owned workspace. The cloud migration is in progress. No VPS or GCP VM has been selected or provisioned, and the existing PWA export is not the completed product.

## Current implementation

The server has a recursive closed workspace DTO codec with a generated schema, authenticated same-origin routes for session authentication, workspace snapshot/refresh, explicit commands, receipt inspection, bounded command history, credential management, and audio upload and media access. `GET /api/audio/upload-history` provides a current-owner, current-privacy-epoch page with only the upload ID, capture identity, status, and creation/update times. It omits audio hashes, media metadata, paths, and adoption receipts. After a user selects an entry, `GET /api/audio/uploads/:id` remains the explicit full-receipt inspection step before `notes.capture.adopt`; listing never submits or adopts work. The Node host composition wires private upload reservation, no-follow file publication, ready-upload capture adoption, scoped media responses, provider-response ownership, and OpenRouter Batch submit/check operations through the server-owned runtime. The dispatcher supports `tasks.complete`, `tasks.reopen`, `chat.create`, `notes.save`, `notes.capture.adopt`, `notes.updateTranscript`, `notes.transcribe`, `assistant.batch.submitNote`, `assistant.batch.check`, `chat.submit`, and `chat.refine`. Transcription cancellation is an exact-command signal request only; the cancellation response says whether the request was accepted, while the journal receipt records the eventual terminal outcome. Journal history returns only public command IDs, kinds, statuses, and integer epoch-millisecond timestamps, with a scoped cursor and no request bodies, receipts, or workspace snapshot. These backend paths have focused server coverage, but do not establish live provider registration or deployment behavior.

The full authenticated workspace is not mounted in the normal app. `npm run export:pwa` still packages the existing legacy web app, so its successful export is not evidence of the cloud composition or server-backed saves. The cloud screen and its review sheet remain in progress. Browser audio transport now supports a single upload, durable history listing, and explicit full-receipt inspection, but the visible recording, recovery, adoption, and private-media flows are not connected to that screen. Fresh OAuth onboarding, scheduler/Web Push, live provider registration, deployment, and iPhone installation remain unverified.

New Batch submissions use input policy 2, removing the former per-source and source-count ceilings, selected-context ceiling, 48 KiB chat-history selection ceiling, and reply-text ceilings. Already saved policy-1 jobs retain their captured legacy behavior through recovery and refinement. Aggregate physical request, storage, response, and file limits remain. Note transcripts and Markdown content can use the existing 24 MiB aggregate backup restore allowance within the 32 MiB backup file bound; workspace snapshots retain a 16 MiB physical limit. These are storage and transport bounds, not AI usage quotas. Provider-reported cost and usage remain the only reported values; missing values stay unknown.

The PWA worker caches only the app shell and an explicit allowlist of hashed JavaScript/font assets, the manifest, and the app icon. It does not cache API responses, authentication or OAuth traffic, audio, uploads, secrets, or external URLs. A cached shell can open offline; authenticated workspace reads and writes require a connection. This describes the current packaging boundary, not evidence of cloud behavior on iPhone.

## Selected target and remaining work

The target is an installable iPhone Home Screen app with saved workspace data, private audio, and provider credentials owned by a portable Node service. The server should run on a private persistent volume with transactional SQLite, while the browser holds only temporary capture/playback material and the limited static app cache. A VPS or GCP VM may be chosen later; this document does not select a host or estimate current hosting cost.

Before the target can be mounted or deployed, the remaining work includes:

- Mount the authenticated cloud screen and finish the full reusable workspace composition, review flow, and auth-to-workspace lifecycle.
- Connect the visible browser recording, upload recovery, capture adoption, and private-media read/export flows to the implemented transport and server endpoints; complete fresh OAuth onboarding without exposing browser token material.
- Move scheduled work and delivery to server-owned scheduling and Web Push, with explicit unknown-outcome and recovery handling.
- Define backup, restore, retention, deletion, and privacy-erasure behavior for server-owned data and media.
- Produce portable deployment and operations runbooks covering TLS, secure cookies, secret protection, persistent storage, encrypted off-host backups, monitoring, upgrades, and tested restore.

Settlement and ownership rules distinguish admitted work from new actions: private owned actors preserve already-owned work until it drains, even if the browser session expires; newly admitted actions still require current browser authentication. Restart-safe provider recovery and the complete end-to-end workflows remain open.

## Host selection and deployment

The server boundary is intended to remain portable across a VPS or GCP VM. No host is provisioned, and capacity, performance, backup cost, and operational requirements have not been tested. Compare current host offerings and operational needs when choosing a deployment; this document is not a price quote or availability commitment.

The personal API-only runtime planning baseline remains Ubuntu LTS with 1 vCPU, 2 GiB RAM, and 50 GB SSD. This sizing is unverified and is not a provider price quote. Build the PWA and server artifacts on the development PC, then deploy those artifacts to the selected host.

For iPhone installation, serve the finished PWA from the site root over HTTPS; in Safari, open the deployed site, use Share, then choose **Add to Home Screen**. This installation path becomes product-ready only after the cloud composition, endpoints, authentication, media, and provider flows are connected and verified.

The service worker does not call `skipWaiting`, claim open clients, or force a reload. During updates, the browser leaves a new worker waiting until old clients close; the first install may activate immediately but does not take over an already open tab. This avoids interrupting a recording session. The worker behavior does not establish that capture is saved to the server.

## Migration sequence

1. Mount the authenticated workspace over the implemented HTTP routes and verify snapshot decoding, command receipts, history inspection, and revision/privacy fences end to end.
2. Connect browser capture upload and private-media flows, complete fresh OAuth onboarding, and verify supported providers through explicit server-owned actions; preserve unknown outcomes for receipt inspection and never automatically replay paid or external work.
3. Move scheduled due work and delivery to server-owned jobs and Web Push; verify duplicate delivery, delayed execution, reconnect, and recovery behavior.
4. Define and test backup, restore, retention, and deletion, then prepare deployment and operations runbooks for the chosen VPS or GCP VM.
5. Deploy a private test instance, verify the full PWA on iPhone, reconcile migrated data, and review a concrete production cutover and rollback plan before any production switch.

The existing native app, iOS EventKit path, signing workflow, and device-validation records are historical implementation evidence. They are not prerequisites or release evidence for the selected PWA and portable server target. A JavaScript export or browser mock also does not prove cloud, provider, or iPhone behavior.

Product requirements remain unchanged: use provider-reported usage and cost when available, preserve missing usage/cost as unknown, and add no estimates or app-level token/spend quotas. Paid work remains an explicit user action, with review before approval and provider execution kept separate where applicable. An unknown remote outcome must be explicitly reconciled; never automatically retry paid or external actions. No hidden provider reads or action replay should be introduced as part of moving storage to the server.
