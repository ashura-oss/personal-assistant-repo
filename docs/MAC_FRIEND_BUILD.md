# Mac build handoff

## What to ask your friend to do

Ask them to compile and package an **unsigned iPhone arm64 build**, then return the IPA, `BUILD-INFO.txt`, and `xcodebuild-path-redacted.log`. The build does not require an Apple account, signing certificate, provider key, or access to your phone. It is a native compile/package check only; it does not prove the app can be installed or run.

First ask them to check the Mac model and macOS version in **About This Mac**, and the selected Xcode version in **Xcode → About Xcode**. They need macOS 26.2+, Xcode 26.4+, Node.js 24, npm, and CocoaPods. An Intel Mac is acceptable if it runs the required macOS/Xcode versions; the output app itself is built for iPhone arm64. Expo lists SDK 57's Xcode and Node minimums in its [SDK reference](https://docs.expo.dev/versions/latest/).

Send them a fresh copy of the complete repository for each build, including `modules/`, `patches/`, and the lockfiles. The script refuses to run `expo prebuild --clean` if an `ios/` directory already exists; use another fresh copy for a rebuild. Do not include `.env`, provider credentials, signing material, or personal app data.

From the repository root on the Mac, they can run:

```sh
bash scripts/build-unsigned-ios.sh "$HOME/Desktop/StillBuild"
```

The script installs locked dependencies (including the checked-in Expo patch), runs the configuration gate, typecheck, tests, and lint, generates the iOS project, verifies autolinking, installs Pods, builds Release for `iphoneos` with signing disabled, and packages the full `.app` into `Still-unsigned-arm64.ipa`. It also writes build metadata and a path-redacted Xcode log into the chosen output directory. The log replaces the Mac home path and `/Users/<name>` path forms; it is not a general secret scrubber, so inspect it before sharing. The script cleans up its temporary derived data and raw log. It does not read `.env` or credentials.

Have your friend return those three output files using a transfer method you choose. The unsigned IPA cannot launch as-is. The build-log mention of `StillPrivacyModule.swift` is not proof that the module is linked into the final executable.

## Installing it is a separate, currently blocked step

The current Still privacy runtime accepts the exact bundle ID `com.still.voiceassistant`. AltStore's official provisioning-profile code constructs a new app ID with the team identifier appended when registering a new app; the exact Windows direct-sideload outcome still needs verification. Therefore, treat the AltStore/AltServer route as blocked for validating this build until bundle-identity compatibility is addressed and verified. Do not change the runtime allowlist to get past signing.

If that compatibility is resolved, AltServer's [Windows direct-sideload flow](https://github.com/altstoreio/FAQ/blob/main/release-notes/altserver.md) can sign an IPA with the Apple account entered by the person installing it; AltServer says directly sideloaded apps need reinstallation every seven days. Keep the Apple account on your own machine/account flow. A separate option is signing and installing over USB from Xcode with your own Personal Team. Apple says Personal Team provisioning profiles expire after seven days and must be renewed in Xcode [in its account guide](https://developer.apple.com/help/account/basics/about-your-developer-account). That option requires your Apple account to be entered locally. Do not send anyone your Apple password or verification codes.

AltStore source references: [the provisioning-profile bundle-ID construction](https://github.com/altstoreio/AltStore/blob/develop/AltStore/Operations/FetchProvisioningProfilesOperation.swift) and [Windows setup](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows). Apple's [code-signing documentation](https://developer.apple.com/documentation/xcode/using-the-latest-code-signature-format) explains why the unsigned package must be signed before iOS can launch it. Native linking, signing, entitlements, installation, and device behavior remain unverified.
