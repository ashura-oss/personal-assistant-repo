# iOS build handoff

**Status:** The local static iOS configuration gate passed nine checks. No Expo account/project association, Apple signing setup, device registration, EAS build, TestFlight submission, or native installation has been performed. The repository is being edited on Windows; do not treat a JavaScript export as a native build.

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

The latest project verification snapshot passed 677 tests across 65 files at 16:46:10 SGT on 2026-10-13, TypeScript, lint with zero errors and 40 existing warnings, the nine-check iOS configuration gate, and the `patch-package` postinstall. Expo Doctor (21/21) and dependency alignment also passed in the preceding local setup checks. Phase 24 web export passed with 619 modules across 12 bundles (960 KB entry, 662 KB controller, 117 KB common, 441-byte backend stub); unsigned iOS JavaScript/Hermes export passed with 913 modules and a 4.3 MB bundle. These are project and configuration checks, not native compilation evidence.

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

- [Expo: iOS development build for devices](https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/)
- [Expo: internal distribution](https://docs.expo.dev/build/internal-distribution/)
- [Expo: local EAS builds](https://docs.expo.dev/build-reference/local-builds/)
- [Expo: iOS Developer Mode](https://docs.expo.dev/guides/ios-developer-mode/)
- [Expo CLI](https://docs.expo.dev/more/expo-cli/)
- [CocoaPods podspec `homepage` field](https://guides.cocoapods.org/syntax/podspec.html#homepage)
