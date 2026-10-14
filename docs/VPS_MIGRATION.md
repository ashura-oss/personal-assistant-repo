# Still web and VPS migration

Status: this document records the intended deployment boundary. The PWA export is a packaging layer over the existing Expo web build. The server package and kernel are foundation work only; the application is not fully migrated, deployed, or connected to a VPS.

## Browser install and offline boundary

Run `npm run export:pwa` on the development PC to build the real Expo web export and add a web manifest, the existing Still icon, and a service worker. The command rejects preview-scenario builds and writes `dist-web/` by default. Build the PWA and server artifacts on the PC, then deploy those artifacts; the production VPS is not the build machine. Serve the PWA output from the site root over HTTPS. On iPhone Safari, open the deployed site, use Share, then choose **Add to Home Screen**.

The service worker caches only the app shell and an explicit allowlist of hashed JavaScript/font assets, the manifest, and the app icon. It does not cache API responses, authentication or OAuth traffic, audio, uploads, secrets, or external URLs. A cached shell can open the interface offline; provider checks, account connections, mail/calendar operations, and other cloud work still need a connection. Browser capture and playback remain temporary client functions and are not an authoritative copy of saved data.

The worker does not call `skipWaiting`, claim open clients, or force a reload. When updating an existing installation, the browser leaves the new worker waiting until the old worker's clients close; the first install may activate immediately but does not take over an already open tab. This avoids interrupting a recording session during an update. The PWA packaging step does not change app behavior or establish browser/provider/device behavior.

## Target deployment

The current target is a single VPS/container running Node 24, with a persistent private volume for transactional SQLite and private audio. All saved application data becomes server-authoritative. The browser keeps only temporary capture/playback material and the explicitly limited static app cache. Deployments need encrypted server-side provider credentials, secure cookie-based authentication, Google and Microsoft OAuth flows, REST endpoints that return safe DTOs through the existing controller rules, and server-side Web Push plus due-job processing.

A bounded single-user planning baseline is Ubuntu LTS with 1 vCPU, 2 GB RAM, 50 GB SSD, and scheduled encrypted backups stored off-host. Capacity and performance have not been tested against real usage, and no host has been provisioned; treat these figures as an initial smaller sizing target to verify before deployment.

This is a migration target, not a claim that those end-to-end flows are complete. The server kernel/package foundation does not yet mean the current client has been fully moved to server storage or that a VPS is provisioned. Current kernel settlement is still session-scoped: late settlement requires the original session to remain valid, and pending attempts are not yet converted into a restart-safe provider recovery flow. Complete that boundary before wiring live provider actions. Full cloud authentication and provider flows are not ready. Docker image details, reverse proxy/TLS configuration, deployment provider, OAuth registrations, secrets-management mechanism, backup retention, monitoring, and recovery runbooks still need explicit design and verification.

Existing product requirements remain in force: preserve actual provider-reported usage and cost when available; missing cost stays unknown; do not add estimated costs or app-level compute/token/spend quotas. Paid work remains an explicit user action, with review before approval and provider execution kept separate where applicable. An unknown remote outcome is durable and must be reconciled explicitly; never automatically retry paid or external actions. No hidden provider reads or action replay should be added as part of moving storage to the server.

Google and Microsoft calendar integrations remain online provider features in the target. Native iOS EventKit access, a Mac build/signing path, and phone installation evidence are historical optional platform work; they are not prerequisites or deployment gates for the selected iPhone Home Screen PWA and VPS target.

## Hosting baseline to compare

These published figures were checked on 14 October 2026. They are a rough infrastructure comparison, not a forecast of Still’s total monthly bill. Prices and offers can vary by region and may change; verify them when selecting a host.

| Baseline | Published capacity/price | What it means for this workload |
| --- | --- | --- |
| Azure Functions Flex Consumption, on-demand | Monthly grant of 250,000 executions and 100,000 GB-s per subscription for on-demand usage; storage and networking are separate | The grant is useful for event-driven endpoints, but the target also needs durable SQLite/private-audio storage, background due jobs, long-lived ownership and recovery behavior. Always-ready instances are separately billed. [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/functions/) |
| DigitalOcean Basic Droplet | 1 GiB / 1 vCPU / 25 GiB: $6 per month; 2 GiB / 1 vCPU / 50 GiB: $12 per month | A small fixed-size VPS is a simple baseline for one service and a persistent volume, with operations and availability owned by the project. Weekly percentage-based backups are listed at 20% of Droplet cost (daily at 30%). [Droplet pricing](https://www.digitalocean.com/pricing/droplets) |

The $6/$12 figures do not include every likely cost or operational need. Storage growth, backups, outbound transfer beyond included allowance, domain/TLS, monitoring, recovery copies, provider APIs, and the time to patch and operate the host must be accounted for. Azure’s free grant is not a general free-hosting promise, and a low-cost Droplet is not a resilience guarantee. The VPS is the current planning baseline because it matches the single-service, SQLite-backed architecture; this is not yet a final host selection or deployment decision.

## Migration sequence

1. Complete server-owned authentication and safe DTO/controller endpoints while retaining current approval, privacy, and unknown-outcome fences.
2. Move saved notes, conversations, tasks, memory, mail/calendar metadata, and private audio behind authenticated server APIs. Define migration, backup, restore, retention, and deletion behavior before switching authority.
3. Move scheduled due work and Web Push to server-owned jobs; verify duplicate delivery, delayed execution, reconnect, and recovery behavior.
4. Deploy to a private test VPS with TLS, secure cookies, encrypted secrets, persistent storage, backups, monitoring, and a tested restore. No production switch until these checks pass.
5. Migrate a test account, reconcile server and client state, then review the exact production cutover and rollback plan.

Each step requires its own review and provider/device verification. The PWA export alone is not evidence that saved data is server-authoritative or that cloud integrations work end to end.
