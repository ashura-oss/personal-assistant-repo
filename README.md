# Still

Still is a native-first personal voice assistant. It saves recordings and notes locally, then lets the user request transcription or bounded assistance, review proposed actions, and approve them separately. Editing invalidates prior approval. Still is a single-turn assistant, not a live conversational agent.

The current app includes local notes and tasks, People and Projects, memory review, reminders, mail/calendar views, explicit reply drafting, portable backup, local privacy controls, and an on-device iOS calendar path. Durable interrupted-recording recovery and exact note adoption are wired in source, but native recorder, storage, permission, and device behavior remain unverified. See [the capability ledger](docs/PLAN.md) and [the iteration log](docs/ITERATIONS.md) for implementation boundaries and evidence.

## Local development

Requirements: Node.js 22.13 or later, npm, and the Expo SDK 57 toolchain.

```sh
npm install
npm run start
```

Useful checks include `npm run typecheck`, `npm test`, `npm run lint`, `npx expo install --check`, and `npx expo-doctor`. The iOS configuration gate is `npm run check:ios-config`; its eight static checks passed. See [docs/IOS_BUILD.md](docs/IOS_BUILD.md) for the custom-build handoff. Web previews and unsigned JavaScript exports are not native iOS builds.

## Private data and provider setup

Notes, app state, documents, and recordings use local platform storage. Do not assume app-private storage is encrypted or excluded from device backups. JSON backup is explicit and excludes audio, settings, credentials, live provider identity, executable approvals, and notification schedules. Treat exported files as sensitive data.

Azure Speech and Azure OpenAI require the user's endpoint, deployment, and key. They are not preconfigured. No real provider, OAuth, external send, or production behavior has been verified. Confirm the actual Azure resource, deployment availability, API compatibility, region, and pricing before credentialed testing. “GPT-6 Luna” is a requested label, not evidence that a public Azure deployment exists.

OAuth registration requires provider-supported public client IDs and exact redirect URIs. Native redirect changes require a new custom build. Never bundle OAuth client secrets. Real provider registrations have not been tested.

## Release boundary

Do not treat a browser mock or JavaScript export as evidence of native microphone, EventKit, notification, privacy-storage, or provider behavior. Physical-device validation, signing, real provider testing, and release remain open. See [docs/IOS_VALIDATION.md](docs/IOS_VALIDATION.md) for the manual device matrix.
