# Still

Still’s selected product target is a complete iPhone Home Screen PWA backed by a portable, server-owned Node workspace. The host is not selected or provisioned; a VPS or GCP VM remains a later deployment choice. This target is not yet a complete cloud app: the PWA export still packages the existing web client, the cloud screen is not mounted, and the HTTP, authentication, media, provider, and deployment flows remain incomplete. See [the migration status](docs/VPS_MIGRATION.md) for what exists and what remains.

## Existing app and implementation evidence

The existing Expo app includes local notes and tasks, People and Projects, memory review, reminders, mail/calendar views, explicit reply drafting, portable backup, local privacy controls, and an on-device iOS calendar path. Its current implementation is local-first and retains the broader native UI; these are historical implementation capabilities, not proof that the selected PWA target is complete. Markdown period files are operational records, not automatically generated daily, weekly, monthly, or yearly summaries. Saved-recording transcription supports separate Azure Speech and OpenRouter Speech providers. Native recorder, storage, permission, and device behavior remain unverified. See [the capability ledger](docs/PLAN.md) and [the iteration log](docs/ITERATIONS.md) for implementation boundaries and evidence.

## Local development

The commands below work with the existing Expo codebase; they do not build or validate a production cloud deployment. Requirements: Node.js 22.13 or later, npm, and the Expo SDK 57 toolchain.

```sh
npm install
npm run start
```

Useful checks include `npm run typecheck`, `npm test`, `npm run lint`, `npx expo install --check`, and `npx expo-doctor`. The iOS configuration gate is `npm run check:ios-config`; its latest reported run passed ten static checks. See [docs/IOS_BUILD.md](docs/IOS_BUILD.md) for the Windows-to-iPhone unsigned-package workflow and signing handoff. Web previews and unsigned JavaScript exports are not signed native builds or device proof.

## Current local data and provider behavior

In the existing app, notes, app state, documents, and recordings use local platform storage. The selected target moves saved workspace data and private audio to server-owned storage. Do not assume current app-private storage is encrypted or excluded from device backups. JSON backup is explicit and excludes audio, settings, credentials, live provider identity, executable approvals, and notification schedules. Treat exported files as sensitive data.

New paid text uses OpenRouter Batch only. Legacy Azure OpenAI settings, keys, and historical text remain inert until the user explicitly saves Batch settings. Azure Speech remains a separate optional provider; OAuth and real provider/device behavior are unverified. The Batch interface displays provider-reported usage and cost only; missing values stay unknown, with no estimate or app-level token/spend/attempt quota. History remains visible when the key is unavailable, while paid submit and remote Check are gated. One fictional WAV was transcribed through the production wire/client from the Node smoke runner, which reported 5.478 seconds and US$0.00001824174; this does not verify the in-app adapter, recorder, native audio, or general model availability. A separate profile-1 synthetic attempt was rejected and remains submission-unknown with no reported usage or cost. Earlier fictional OpenRouter Batch wire/client results are recorded separately and do not verify the mail flow. The OpenRouter key is stored outside the repository. See [the verification record](docs/IOS_BUILD.md) for scope and limits.

OAuth registration requires provider-supported public client IDs and exact redirect URIs. Native redirect changes require a new custom build for the historical native app. Never bundle OAuth client secrets. Real provider registrations have not been tested.

## Release boundary

For Batch mail replies, account disconnect or replacement revokes credentials, advances the account generation, and invalidates pending approvals/plans while preserving job history and receipts. Ordinary provider Inbox pages, selected-text refreshes, and deletion observations can still commit fresh mailbox data and invalidate ordinary pending drafts. Affected uncertain Batch jobs, receipts, and accounting stay tied to their old context and cannot authorize actions against fresh data; private quarantine retains all affected Mail context for provider observation without matching untrusted IDs, while other affected jobs are redacted. This is separate from explicit content erasure: uncertain dispatch or private quarantine blocks destructive job, note, guidance, or source cleanup. Batch-linked proposals carry `batchJobId`; the dispatch receipt carries `MailReplyBatchBinding` (`jobId`, `provenanceCanonical`) exactly when it is Batch-linked, and ordinary non-Batch receipts omit it. This is structural consistency metadata only, not cryptographic attestation or action authority; modifying both the binding and provenance is outside its check scope.

Native microphone, EventKit, notification, native privacy-storage, signing, and physical-device checks document the existing native implementation and remain historical evidence. They are not acceptance evidence for the selected PWA/VPS product. Browser mocks and JavaScript exports also do not verify live cloud, provider, or iPhone installation behavior. See [docs/IOS_VALIDATION.md](docs/IOS_VALIDATION.md) for the historical native-device matrix.
