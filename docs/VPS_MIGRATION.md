# Still PWA and portable server migration

Status: the selected product target is an iPhone Home Screen PWA backed by a portable, server-owned workspace. The authenticated cloud workspace is mounted through `App.web.tsx` and included in the PWA export. The web module graph excludes native storage modules. Server-backed document and knowledge editing, source links, suggestion review, OAuth connections, recording, upload recovery, playback, cancellation, and editable provider/recording preferences have synthetic request or rendered-flow coverage. Mail and calendar actions, proactive controls, push scheduling, backup and restore, media export, and live provider/device/deployment verification remain open. No VPS or GCP VM has been selected or provisioned, and no iPhone installation has been verified.

## Current implementation

The server has a recursive closed workspace DTO codec with a generated schema and authenticated same-origin routes for authentication, workspace snapshots and refresh, explicit commands, receipt inspection, bounded command history, credentials, OAuth, and audio upload and media access. The command and receipt contracts are closed and versioned; consult the implementation and tests for the current supported operations rather than relying on a copied command count. Transcription cancellation is an exact-command signal request only; its response confirms the cancellation signal, while the command receipt remains the source of the final outcome. Journal history exposes public command IDs, kinds, statuses, and integer epoch-millisecond timestamps with a scoped cursor, without request bodies, receipts, or workspace snapshots.

`GET /api/audio/upload-history` returns a current-owner, current-privacy-epoch page containing only upload ID, capture identity, status, and timestamps. It omits hashes, media metadata, paths, and adoption receipts. Selecting a history item is followed by an explicit `GET /api/audio/uploads/:id`; only a confirmed ready receipt can be explicitly adopted. The UI also supports a single explicit recording session, upload recovery by exact ID, saved-note adoption, playback through the authenticated same-origin media route, and explicit transcription. It does not auto-start capture, transcription, or AI work. Unknown upload or command outcomes remain held for inspection, and recording a note does not imply AI processing.

The web settings surface saves provider mode, speech, reasoning effort, recording length, retention, and the OpenRouter key through server-owned commands. The UI reports provider usage and cost only when supplied; missing values stay unknown, and the app adds no token or spending quotas. The connection UI and server support confidential Google and Microsoft OAuth with optional all-or-none `STILL_GOOGLE_CLIENT_ID` / `STILL_GOOGLE_CLIENT_SECRET` and `STILL_MICROSOFT_CLIENT_ID` / `STILL_MICROSOFT_CLIENT_SECRET` pairs. `GET /api/oauth/availability` reports only whether each pair is configured. Synthetic signed-token and rendered tests cover the connection flow through verified account installation. Live provider registrations, production deployment, and physical device behavior are unverified.

The authenticated cloud workspace is the mounted web/PWA product entry point. `npm run export:pwa` packages that entry point; a successful export verifies packaging, not server deployment or live service behavior. Document and knowledge edits, safe source-choice reads, suggestion review, connection setup, and the current recording/recovery flows are implemented with synthetic tests. Full mail and calendar actions, proactive controls, Web Push scheduling and delivery, backup/restore and privacy erasure, and media export still need complete server-owned workflows. The complete server-backed PWA has not been validated against live OAuth or AI providers, a VPS/GCP deployment, a Linux host, or an iPhone installation.

New Batch submissions use input policy 2, removing the former per-source and source-count ceilings, selected-context ceiling, 48 KiB chat-history selection ceiling, and reply-text ceilings. Already saved policy-1 jobs retain their captured legacy behavior through recovery and refinement. Aggregate physical request, storage, response, and file limits remain. Note transcripts and Markdown content can use the existing 24 MiB aggregate backup restore allowance within the 32 MiB backup file bound; workspace snapshots retain a 16 MiB physical limit. These are storage and transport bounds, not AI usage quotas. Provider-reported cost and usage remain the only reported values; missing values stay unknown.

The PWA worker caches only the app shell and an explicit allowlist of hashed JavaScript/font assets, the manifest, and the app icon. It does not cache API responses, authentication or OAuth traffic, audio, uploads, secrets, or external URLs. A cached shell can open offline; authenticated workspace reads and writes require a connection. This describes the current packaging boundary, not evidence of cloud behavior on iPhone.

## Selected target and remaining work

The target is an installable iPhone Home Screen app with saved workspace data, private audio, and provider credentials owned by a portable Node service. The server should run on a private persistent volume with transactional SQLite, while the browser holds only temporary capture/playback material and the limited static app cache. A VPS or GCP VM may be chosen later; this document does not select a host or estimate current hosting cost.

Before the target is release-ready, the remaining work includes:

- Complete mail and calendar connection, review, and approval actions; proactive controls; reminders and archive workflows; and backup, restore, recovery, privacy-erasure, and media-export actions with server-owned commands and safe display DTOs.
- Exercise OAuth against configured live test registrations and verify operational restart, migration, duplicate, stale-session, and second-authorization behavior before production deployment.
- Complete server-owned scheduling and delivery through Web Push, including eligibility, delayed execution, duplicate delivery, reconnect, unknown outcomes, and recovery.
- Define and test server backup, restore, retention, deletion, and privacy-erasure behavior for workspace data, credentials, and media.
- Produce and verify portable deployment and operations runbooks for a selected VPS or GCP VM, including TLS, secure cookies, secret protection, persistent storage, encrypted off-host backups, monitoring, upgrades, and restore.
- Select and provision a host, prepare production operations and backup runbooks, and verify the exported PWA on a physical iPhone, including Home Screen installation, authenticated workspace access, playback, recording recovery, offline shell behavior, and service-worker updates. Until those checks pass, the PWA is not a deployable or device-proven product.

Settlement and ownership rules distinguish admitted work from new actions: private owned actors preserve already-owned work until it drains, even if the browser session expires; newly admitted actions still require current browser authentication. Unknown outcomes are inspected by exact command or upload identity and are never automatically replayed. Restart-safe provider recovery and the complete end-to-end workflows remain open.

## Host selection and deployment

The server boundary is intended to remain portable across a VPS or GCP VM. No host is provisioned, and capacity, performance, backup cost, and operational requirements have not been tested. Compare current host offerings and operational needs when choosing a deployment; this document is not a price quote or availability commitment.

The personal API-only runtime planning baseline remains Ubuntu LTS with 1 vCPU, 2 GiB RAM, and 50 GB SSD. This sizing is unverified and is not a provider price quote. Build the PWA and server artifacts on the development PC, then deploy those artifacts to the selected host.

For iPhone installation, serve the finished PWA from the site root over HTTPS; in Safari, open the deployed site, use Share, then choose **Add to Home Screen**. This installation path becomes product-ready only after the cloud composition, endpoints, authentication, media, and provider flows are connected and verified.

The service worker does not call `skipWaiting`, claim open clients, or force a reload. During updates, the browser leaves a new worker waiting until old clients close; the first install may activate immediately but does not take over an already open tab. This avoids interrupting a recording session. The worker behavior does not establish that capture is saved to the server.

## Migration sequence

1. Continue completing the remaining mail, calendar, proactive, reminder, archive, backup/recovery, privacy-erasure, and media-export workflows; verify snapshot decoding, settings, receipt inspection, and revision/privacy fences end to end.
2. Verify the OAuth connection flow with configured test registrations and exercise restart, migration, duplicate, stale-session, and second-authorization behavior. Preserve unknown outcomes for exact inspection and never automatically replay paid or external work.
3. Complete server-owned scheduling and Web Push, then verify duplicate delivery, delayed execution, reconnect, and recovery behavior.
4. Define and test backup, restore, retention, deletion, and privacy erasure; prepare runbooks for the selected VPS or GCP VM.
5. Deploy a private test instance, verify the full PWA on a physical iPhone, reconcile migrated data, and review a concrete production cutover and rollback plan before any production switch.

The existing native app, iOS EventKit path, signing workflow, and device-validation records are historical implementation evidence. They are not prerequisites or release evidence for the selected PWA and portable server target. A JavaScript export or browser mock also does not prove cloud, provider, or iPhone behavior.

Product requirements remain unchanged: use provider-reported usage and cost when available, preserve missing usage/cost as unknown, and add no estimates or app-level token/spend quotas. Paid work remains an explicit user action, with review before approval and provider execution kept separate where applicable. An unknown remote outcome must be explicitly reconciled; never automatically retry paid or external actions. No hidden provider reads or action replay should be introduced as part of moving storage to the server.
