# Still

Still is a native-first personal assistant centered on locally saved recordings and notes. Users can request transcription or bounded assistance, review proposed actions, and approve them separately; editing invalidates prior approval. The current assistance flow is note-centered rather than conversational. Queued text chat is planned; live voice conversation is out of scope.

The current app includes local notes and tasks, People and Projects, memory review, reminders, mail/calendar views, explicit reply drafting, portable backup, local privacy controls, and an on-device iOS calendar path. Durable interrupted-recording recovery and exact note adoption are wired in source, but native recorder, storage, permission, and device behavior remain unverified. See [the capability ledger](docs/PLAN.md) and [the iteration log](docs/ITERATIONS.md) for implementation boundaries and evidence.

## Local development

Requirements: Node.js 22.13 or later, npm, and the Expo SDK 57 toolchain.

```sh
npm install
npm run start
```

Useful checks include `npm run typecheck`, `npm test`, `npm run lint`, `npx expo install --check`, and `npx expo-doctor`. The iOS configuration gate is `npm run check:ios-config`; its latest reported run passed ten static checks. See [docs/IOS_BUILD.md](docs/IOS_BUILD.md) for the Windows-to-iPhone unsigned-package workflow and signing handoff. Web previews and unsigned JavaScript exports are not signed native builds or device proof.

## Private data and provider setup

Notes, app state, documents, and recordings use local platform storage. Do not assume app-private storage is encrypted or excluded from device backups. JSON backup is explicit and excludes audio, settings, credentials, live provider identity, executable approvals, and notification schedules. Treat exported files as sensitive data.

Azure Speech, Azure OpenAI, and OAuth integrations remain unverified and require user-provided configuration. One fictional OpenRouter Batch request was sent and its exact strict-JSON result and reported usage were verified; this proves only that single request, not in-app queued-chat integration or general model availability. The OpenRouter key is stored outside the repository. See [the verification record](docs/IOS_BUILD.md) for the request scope and limits.

OAuth registration requires provider-supported public client IDs and exact redirect URIs. Native redirect changes require a new custom build. Never bundle OAuth client secrets. Real provider registrations have not been tested.

## Release boundary

Do not treat a browser mock or JavaScript export as evidence of native microphone, EventKit, notification, privacy-storage, or provider behavior. Physical-device validation, signing, real provider testing, and release remain open. See [docs/IOS_VALIDATION.md](docs/IOS_VALIDATION.md) for the manual device matrix.
