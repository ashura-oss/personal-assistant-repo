# Still

Still is a native-first voice assistant for capturing a thought, reviewing what it might mean, and choosing what happens next. It is designed around user control: a recording is saved before optional transcription, proposed actions remain drafts, edits invalidate prior approval, and sending or scheduling is a separate explicit action.

This repository contains the current uncredentialed build and the full product roadmap in [docs/PLAN.md](docs/PLAN.md). The roadmap labels each capability as implemented, configured, mock, unverified, or not yet implemented so setup gaps remain visible.

People, Projects, and Memory provide local structured personal context. Suggestions retain their evidence and require explicit review; imported knowledge remains archived until the user chooses to add a separate copy. See [the iteration log](docs/ITERATIONS.md) for current scope and verification boundaries.

## Current setup

Requirements: Node.js 22.13 or later, npm, and the Expo SDK 57 toolchain. Use a current iPhone development build for microphone, Keychain, OAuth redirects, and native notification checks. The web preview runs locally and can exercise browser capture and IndexedDB workflows; it does not certify native behavior.

```sh
npm install
npm run start
```

Use the Expo CLI to open the web preview or a development build. `npm run typecheck`, `npm run test`, `npm run export:web`, `npx expo export --platform ios --output-dir dist/ios-js`, and `npx expo-doctor` provide project checks. An iOS JavaScript export is not a signed iOS application.

## Private data and provider setup

Audio recordings, notes, proposal drafts, and Markdown documents are stored locally. Native audio uses the app documents directory; browser audio Blobs use IndexedDB. Browser API credentials exist in memory only. Native API credentials use the platform secure store. The local database and documents are not described as encrypted by default, and app-private files may be included in device backups. JSON backup export is an explicit user action and includes notes, tasks, Markdown, People/Projects, inert imported-knowledge archives, and read-only history; it excludes settings, recordings, and provider credentials/state. Protect exported files as sensitive data.

Azure Speech and Azure OpenAI require a user's endpoint, deployment, and key. These are intentionally not preconfigured. A connection or account label stays “configured” until authentication is actually verified. Browser CORS and the selected Azure resource's model availability need credentialed tests. No live provider, OAuth, external send, or production deployment has been verified in this build.

Provider authorization uses a system-browser authorization-code + PKCE handoff. To prepare a provider registration, copy `.env.example` to a local, ignored `.env` and fill in platform-specific **public client IDs** and exact registered redirect URIs. Google native redirects use the reversed, dotted client-ID scheme; Microsoft native callbacks use a dotted `com.still.voiceassistant.*` scheme. Changing a native redirect requires a new app configuration and development build. Microsoft web SPA sign-in requires its own HTTPS callback (loopback HTTP is allowed for local development). Google web sign-in is disabled because exchanging a Google web code requires a confidential backend; use the iOS build for Google. Microsoft authority accepts only `common`, `organizations`, `consumers`, or a tenant UUID. Do not put OAuth client secrets in the app. Connect requires a public client ID and exact callback for the current platform. After sign-in, Still exchanges the PKCE code, verifies account identity and selected resource access, then asks core to read back and validate the secure token before installing a connected account. This path has not been exercised against real provider registrations; setup alone never marks an account connected.

## iOS beta path

1. Confirm the Apple Developer membership, bundle identifier, App Store Connect app record, and signing credentials.
2. Configure platform-specific OAuth client registrations and exact redirect URIs for each provider; set only public client IDs in local build environment, keep client secrets out of the app, and rebuild native apps after callback-scheme changes.
3. Select an Azure OpenAI deployment actually available in the user's resource, plus Azure Speech; verify model availability, API compatibility, pricing, audio formats, latency, response schema, and limits before provider use. “GPT-6 Luna” is a requested label, not proof of a public Azure deployment.
4. Run `npx expo install --check`, `npx expo-doctor`, typecheck, core tests, web export, and the iOS JavaScript export.
5. Build a signed iOS development build with EAS and validate capture, interruptions, offline persistence, Keychain lifecycle, OAuth, local notification delivery, and privacy/export on a physical iPhone.
6. Run a reviewed test action with an explicitly approved payload and test recipient before enabling any real send path. Uploading through EAS Submit is not publication; TestFlight and App Store review remain separate steps.

See [the roadmap](docs/PLAN.md) and [iteration log](docs/ITERATIONS.md) for boundaries and verification status.
