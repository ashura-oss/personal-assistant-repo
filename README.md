# Still

Still is a native-first personal assistant centered on locally saved recordings and notes. Users can request transcription or bounded assistance, review proposed actions, and approve them separately; editing invalidates prior approval. OpenRouter Batch note assistance and queued text chat use explicit saved jobs and user-triggered status checks, with provider-reported usage shown only when available; completed answers can receive a separate “Think more” refinement at Medium, High, or Max effort. Eligible Chat turns can surface memory suggestions only from exact current-user quotes; any candidate containing prior, assistant-authored, or other-source evidence is discarded whole. Review uses existing local Memory controls and makes no model request. A saved transcript can be reviewed read-only and copied into a selected or explicitly created Chat conversation through a separate send action. Source now includes an explicit OpenRouter Batch mail-reply flow: paid submission, manual status check, fresh-source read-only review, one-use local draft creation, then the normal separate proposal approval/action steps. Generated Batch reply drafts are immutable; a manually written reply can be created separately. No in-app mail-reply provider request has been made, and real user/OAuth and native-device behavior remain unverified. Portable V4 history is inert and read-only; live voice conversation remains out of scope.

The current app includes local notes and tasks, People and Projects, memory review, reminders, mail/calendar views, explicit reply drafting, portable backup, local privacy controls, and an on-device iOS calendar path. Saved-recording transcription supports separate Azure Speech and OpenRouter Speech providers; native recorder, storage, permission, and device behavior remain unverified. See [the capability ledger](docs/PLAN.md) and [the iteration log](docs/ITERATIONS.md) for implementation boundaries and evidence.

## Local development

Requirements: Node.js 22.13 or later, npm, and the Expo SDK 57 toolchain.

```sh
npm install
npm run start
```

Useful checks include `npm run typecheck`, `npm test`, `npm run lint`, `npx expo install --check`, and `npx expo-doctor`. The iOS configuration gate is `npm run check:ios-config`; its latest reported run passed ten static checks. See [docs/IOS_BUILD.md](docs/IOS_BUILD.md) for the Windows-to-iPhone unsigned-package workflow and signing handoff. Web previews and unsigned JavaScript exports are not signed native builds or device proof.

## Private data and provider setup

Notes, app state, documents, and recordings use local platform storage. Do not assume app-private storage is encrypted or excluded from device backups. JSON backup is explicit and excludes audio, settings, credentials, live provider identity, executable approvals, and notification schedules. Treat exported files as sensitive data.

Azure Speech, Azure OpenAI, and OAuth integrations remain unverified and require user-provided configuration; Azure remains an optional configured provider. OpenRouter is the selected text provider in the current product flow. Its Batch mail-reply interface displays only provider-reported usage and cost; missing values remain unknown, with no estimate or app-level token/spend/attempt quota. History remains visible when the key is unavailable, while paid submit and remote Check are gated. One fictional WAV was transcribed through the production wire/client from the Node smoke runner, which reported 5.478 seconds and US$0.00001824174; this does not verify the in-app adapter, recorder, native audio, or general model availability. A separate profile-1 synthetic attempt was rejected and remains submission-unknown with no reported usage or cost. Earlier fictional OpenRouter Batch wire/client results are recorded separately and do not verify the mail flow. The OpenRouter key is stored outside the repository. See [the verification record](docs/IOS_BUILD.md) for scope and limits.

OAuth registration requires provider-supported public client IDs and exact redirect URIs. Native redirect changes require a new custom build. Never bundle OAuth client secrets. Real provider registrations have not been tested.

## Release boundary

For Batch mail replies, account disconnect or replacement revokes credentials, advances the account generation, and invalidates pending approvals/plans while preserving job history and receipts. Ordinary provider Inbox pages, selected-text refreshes, and deletion observations can still commit fresh mailbox data and invalidate ordinary pending drafts. Affected uncertain Batch jobs, receipts, and accounting stay tied to their old context and cannot authorize actions against fresh data; private quarantine retains all affected Mail context for provider observation without matching untrusted IDs, while other affected jobs are redacted. This is separate from explicit content erasure: uncertain dispatch or private quarantine blocks destructive job, note, guidance, or source cleanup. Batch-linked proposals carry `batchJobId`; the dispatch receipt carries `MailReplyBatchBinding` (`jobId`, `provenanceCanonical`) exactly when it is Batch-linked, and ordinary non-Batch receipts omit it. This is structural consistency metadata only, not cryptographic attestation or action authority; modifying both the binding and provenance is outside its check scope.

Do not treat a browser mock or JavaScript export as evidence of native microphone, EventKit, notification, privacy-storage, or provider behavior. Physical-device validation, signing, real provider testing, and release remain open. See [docs/IOS_VALIDATION.md](docs/IOS_VALIDATION.md) for the manual device matrix.
