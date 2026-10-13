# iOS build handoff

**Status:** The latest local static iOS configuration gate passed ten checks. No native build or installation has been performed. The proposed AltStore sideload path is blocked pending bundle-identity compatibility; do not treat a JavaScript export as a native build.

## Unsigned ARM64 build workflow

The repository includes a manually dispatched GitHub Actions workflow at `.github/workflows/ios-unsigned-device.yml`. It runs on an Apple Silicon `macos-26` runner and calls the same `scripts/build-unsigned-ios.sh` used for a local Mac build. The script verifies Xcode 26.4+ and Node 22.13+ (SDK 57 minimums [in Expo's SDK reference](https://docs.expo.dev/versions/latest/)), installs the npm lockfile and checked-in patch, runs project checks, generates the iOS project, verifies Expo autolinking, installs CocoaPods, and builds an arm64 Release `iphoneos` app with signing disabled. It refuses to clean an existing `ios/` directory, so each build needs a fresh checkout. It checks the expected build bundle ID, executable architecture, and bundled JavaScript, then packages the full app directory inside `Payload/` for a five-day Actions artifact. The build-log match for `StillPrivacyModule.swift` records a source-build entry only; it does not prove the module is linked into the final executable or works at runtime. For a friend-owned Mac, see [the Mac build handoff](MAC_FRIEND_BUILD.md).

This output is **unsigned** and cannot launch until signed. The AltStore Classic/AltServer route is currently blocked for validating Still's privacy runtime. The official AltStore provisioning code constructs a new app identifier by appending the team identifier to the parent bundle ID when registering an app [in its provisioning-profile flow](https://github.com/altstoreio/AltStore/blob/develop/AltStore/Operations/FetchProvisioningProfilesOperation.swift); Still currently accepts only `com.still.voiceassistant`. The exact Windows direct-sideload result has not been tested, so preserve the blocker until identity compatibility is implemented and verified. Do not widen the privacy runtime's identity allowlist to make signing work. AltServer documents direct IPA sideloading and seven-day reinstallation for those apps [in its release notes](https://github.com/altstoreio/FAQ/blob/main/release-notes/altserver.md); this does not establish compatibility with Still's runtime.

The app's runtime identity is deliberately strict. A signing flow that changes the bundle ID cannot validate this build; the compatibility work and device check are still required. Even a successful compile or IPA package would not prove the module is linked, the re-signed app launches, or device features work. The [iOS validation matrix](IOS_VALIDATION.md) remains the record for those checks.

GitHub-hosted builds require this source tree in a GitHub repository; the artifact is stored by Actions. This workspace has no configured remote. No repository was created, source uploaded, workflow dispatched, or build artifact produced. The workflow has not been build-verified. If the source must stay off GitHub, a trusted Mac or another authorized build host is needed.

The workflow sets `EXPO_NO_DOTENV=1`; it does not read `.env`, provider keys, or signing credentials. OAuth callbacks depend on public native client ID/redirect values not supplied to the workflow. No private key is included in the artifact.

## OpenRouter Batch foundation (separate from iOS validation)

One fictional OpenRouter Batch request was submitted with one POST, then checked through read-only status and ownership diagnostics. The exact request, strict `READY` result, outer canonical Luna model, and inline base model were verified. OpenRouter reported 75 prompt tokens, 14 completion tokens, and US$0.00000725 for that request. It contained no personal audio or user content. The original local submission journal remains `submission_unknown`; the separately verified diagnostic receipt was not adopted into it, and the utility will not resubmit automatically. This proves only that this synthetic Batch request completed with the validated response and usage; it does not prove in-app queued chat, general model availability, future pricing, or any iOS behavior. The OpenRouter key is stored outside the repository and is not used by this workflow.

## Local checks on Windows

Run the repository's static iOS configuration gate first, followed by the existing project checks:

```powershell
npm ci
npm run check:ios-config
npx expo install --check
npx expo-doctor
npm run typecheck
npm test
npm run lint
```

The gate checked the configured bundle/presentation settings, permission and background-mode configuration, transport policy, URL scheme registration, unique StillPrivacy autolinking, and local podspec metadata. It does not install CocoaPods, compile Swift, sign an app, or prove the native module works. The gate passed; the actual CocoaPods and native build steps remain unrun.

The Phase 24 project snapshot passed 677 tests across 65 files at 16:46:10 SGT on 2026-10-13, TypeScript, lint with zero errors and 40 existing warnings, the nine-check iOS configuration gate, and the `patch-package` postinstall. Expo Doctor (21/21) and dependency alignment also passed in that setup. Phase 24 web export passed with 619 modules across 12 bundles (960 KB entry, 662 KB controller, 117 KB common, 441-byte backend stub); unsigned iOS JavaScript/Hermes export passed with 913 modules and a 4.3 MB bundle. These are historical project/configuration checks, not native compilation evidence.

Phase 25 adds foreground proactive mail alerts. Root's 2026-10-13 18:34:59 SGT verification passed 753 tests across 69 files, TypeScript, full lint (zero errors and 40 existing warnings), and all nine iOS configuration checks. The earlier 739-test/seven-failure snapshot is superseded. Closed browser QA passed at 390×844 using fictional data; screenshots are recorded in `ITERATIONS.md`. Unsigned iOS JavaScript export passed with 919 modules and a 4.5 MB Hermes bundle (`index-4d5c2306d6a25cdb1dd843b1a9a27782.hbc`). Web export passed with 625 modules and 12 bundles (984 KB entry, 714 KB controller, 117 KB common, 441-byte backend stub, and 390 KB font). Astra approved the stable source checkpoint with no remaining P0/P1 findings in the reviewed scope; focused coverage was 119 tests across eight suites. Native compile, signed build, provider refresh, native notification scheduling, notification tap routing, and physical-iPhone delivery remain unverified or unimplemented. ESLint excludes generated `.expo`, recursive `dist`, `node_modules`, and `coverage` trees.

Phase 26 adds headless proactive mail alerts to the existing bounded background mail refresh, using the shared foreground rule/consent/source policy. Root's 2026-10-13 18:57:41 SGT snapshot passed 767 tests across 69 files, TypeScript, full lint (zero errors and 40 existing warnings), and all nine iOS configuration checks; Astra approved the reviewed source. The pinned Expo Winter runtime has `structuredClone` support, so no project polyfill is used. The iOS JavaScript export passed with 921 modules, one 4.5 MB Hermes bundle (`index-6f63843f3303d2da04e55f396d80c2d9.hbc`), and one 390 KB font. Web export passed with 626 modules across 12 bundles: 984 KB entry (`index-ccd75897e89be85968cc20f9cbdf63b1.js`), 716 KB controller (`controller-47e33cfa6d12ca7f384339ac08347405.js`), 117 KB common (`__common-7d9ad6301f3cecfdae4f0930d0800f6d.js`), and 441-byte backend stub (`ff04ff8980f940f6287d77bfa840d9e9`). Outputs are ignored under `.expo/.phase26-*`; no preview environment remains running. These bundles are JavaScript exports only. Native task execution, Keychain access while locked, real provider behavior, native notification scheduling/delivery, notification-tap routing, native compilation, signing, and physical-device checks were not run. iOS scheduling is discretionary and notification delivery is not guaranteed.

## Custom iOS build requirement

Still requires its local `StillPrivacy` Expo module to obtain the process-stable runtime identity used by full privacy cleanup. Expo Go does not contain this local module and cannot validate that path. A development or distribution build made from this project is required. OAuth redirect changes also require a new native build. Background mail refresh uses the installed SDK's official config-plugin chain to configure iOS background modes; the app registers its task only after explicit enablement. Static review is not proof of task registration or execution.

The `eas.json` profiles currently mean:

- `development`: development client plus internal distribution. After installing it, run `npx expo start --dev-client`; Metro is required to serve the JavaScript bundle.
- `preview`: internal distribution without a development client. The JavaScript bundle is embedded in the build; it does not require Metro.
- `production`: store distribution configuration. It still requires Apple signing and release review; no production build or submission has occurred.

## Future Expo/EAS steps

After choosing an Expo account/organization and confirming the Apple Developer team and test device, use the following commands from the project directory. These are examples for the checked-in profiles and have **not** been run:

```powershell
npx eas-cli@latest login
npx eas-cli@latest init
npx eas-cli@latest device:create
npx eas-cli@latest build --platform ios --profile development
npx eas-cli@latest build --platform ios --profile preview
```

`eas init` associates the repository with an Expo project and may add its project identifier to app configuration. Device registration and internal iOS distribution need Apple provisioning/signing and the registered device's UDID. Install the development build, start Metro with `npx expo start --dev-client`, and then follow [the manual iOS validation matrix](IOS_VALIDATION.md). Enable iOS Developer Mode on the test device when required by the installed iOS version.

From Windows, an EAS cloud build can use Expo's macOS build workers if the user chooses that route and supplies the required Expo/Apple account setup. It is a build service, not an Azure hosting requirement. A local iOS native build requires Apple's toolchain; Windows does not provide Xcode. No cloud build, upload, login, signing, or project association is authorized or completed in this checkpoint.

## References

- [Apple: code signatures and iOS launch requirements](https://developer.apple.com/documentation/xcode/using-the-latest-code-signature-format?changes=__8_8%2C__8_8)
- [GitHub: macOS hosted runner architectures](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)
- [GitHub: workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
- [Expo: local module setup](https://docs.expo.dev/modules/get-started/)
- [Expo: native module autolinking](https://docs.expo.dev/modules/autolinking/)
- [Expo: SDK and toolchain requirements](https://docs.expo.dev/versions/latest/)
- [AltStore Classic: Windows install guide](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)
- [AltServer: direct IPA sideloading and renewal notes](https://faq.altstore.io/release-notes/altserver)
- [Expo: iOS development build for devices](https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/)
- [Expo: internal distribution](https://docs.expo.dev/build/internal-distribution/)
- [Expo: local EAS builds](https://docs.expo.dev/build-reference/local-builds/)
- [Expo: iOS Developer Mode](https://docs.expo.dev/guides/ios-developer-mode/)
- [Expo CLI](https://docs.expo.dev/more/expo-cli/)
- [CocoaPods podspec `homepage` field](https://guides.cocoapods.org/syntax/podspec.html#homepage)

## Phase 31 project checkpoint

Root's 2026-10-13 22:52:05 SGT checkpoint passed a clean `npm ci`, 890 tests across 80 files, TypeScript, full lint with zero errors and 40 existing warnings, and ten static iOS configuration checks. The unsigned iOS JavaScript export passed with 929 modules and a 4.6 MB Hermes bundle (`index-45f04d6414343a0f4becca488133c9d5.hbc`). The web export passed with 634 modules across 12 bundles (1.1 MB entry and 681 KB controller). These are source and JavaScript-export checks, not native compilation, signing, or device validation.

The OpenRouter profile uses Batch only. The user-facing profile identifies Luna Batch; durable in-app job submission, retrieval, history, and result application remain pending. The Batch API may take up to 24 hours, and OpenRouter retains submitted inputs/results for up to 30 days or until deletion. The one synthetic smoke request above is the only real provider call recorded here.
