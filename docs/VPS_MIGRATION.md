# Still PWA and portable server migration

Status: the selected product is a complete iPhone Home Screen PWA backed by a portable, server-owned workspace. The cloud migration is in progress. No VPS or GCP VM has been selected or provisioned, and the existing PWA export is not the completed product.

## Current implementation

The repository now contains server-owned controller/runtime and private credential-reader foundations, a safe workspace DTO projection, readonly note/transcription/task leaf types, strict dispatch for `tasks.complete`, `tasks.reopen`, and `chat.create`, and a same-origin browser command transport. The existing full `WorkspaceView` has a platform boundary with its native composition preserved. These pieces are foundations; they do not make the full app available from an authenticated cloud workspace.

`npm run export:pwa` still packages the existing legacy web app. The current export has 679 modules, 12 bundles, and 17 static paths. It does not mount the cloud workspace or establish server-backed saves. The complete DTO decoder and full-screen cloud composition are not in place.

The PWA worker caches only the app shell and an explicit allowlist of hashed JavaScript/font assets, the manifest, and the app icon. It does not cache API responses, authentication or OAuth traffic, audio, uploads, secrets, or external URLs. A cached shell can open offline; authenticated workspace reads and writes require a connection. This describes the current packaging boundary, not evidence of cloud behavior on iPhone.

## Selected target and remaining work

The target is an installable iPhone Home Screen app with saved workspace data, private audio, and provider credentials owned by a portable Node service. The server should run on a private persistent volume with transactional SQLite, while the browser holds only temporary capture/playback material and the limited static app cache. A VPS or GCP VM may be chosen later; this document does not select a host or estimate current hosting cost.

Before the target can be mounted or deployed, the remaining work includes:

- Wire the real same-origin HTTP routes and authenticated bootstrap for session, safe snapshots, refresh, commands, receipts, credentials, and private media.
- Complete the recursive DTO decoder and connect command outcomes to a full-screen cloud composition without casting snapshots to `AppState` or exposing local-only capabilities.
- Implement server-backed capture save and private-media read/export paths, then connect the permitted provider composition and OAuth flows.
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

1. Complete and verify HTTP authentication/bootstrap, full snapshot decoding, and server-backed workspace reads and writes using the existing command allowlist and revision/privacy fences.
2. Connect capture saves, private media, supported providers, and OAuth to explicit server-owned actions; preserve unknown outcomes for receipt inspection and never automatically replay paid or external work.
3. Move scheduled due work and delivery to server-owned jobs and Web Push; verify duplicate delivery, delayed execution, reconnect, and recovery behavior.
4. Define and test backup, restore, retention, and deletion, then prepare deployment and operations runbooks for the chosen VPS or GCP VM.
5. Deploy a private test instance, verify the full PWA on iPhone, reconcile migrated data, and review a concrete production cutover and rollback plan before any production switch.

The existing native app, iOS EventKit path, signing workflow, and device-validation records are historical implementation evidence. They are not prerequisites or release evidence for the selected PWA and portable server target. A JavaScript export or browser mock also does not prove cloud, provider, or iPhone behavior.

Product requirements remain unchanged: use provider-reported usage and cost when available, preserve missing usage/cost as unknown, and add no estimates or app-level token/spend quotas. Paid work remains an explicit user action, with review before approval and provider execution kept separate where applicable. An unknown remote outcome must be explicitly reconciled; never automatically retry paid or external actions. No hidden provider reads or action replay should be introduced as part of moving storage to the server.
