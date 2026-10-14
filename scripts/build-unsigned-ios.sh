#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/build-unsigned-ios.sh OUTPUT_DIR" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_ARG="$1"
OUTPUT_PARENT="$(dirname "$OUTPUT_ARG")"
if [[ "$OUTPUT_PARENT" != /* ]]; then
  OUTPUT_PARENT="$PWD/$OUTPUT_PARENT"
fi
if [[ ! -d "$OUTPUT_PARENT" ]]; then
  echo "OUTPUT_DIR parent must already exist; refusing to create paths before safety checks." >&2
  exit 2
fi
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd)"
OUTPUT_DIR="$OUTPUT_PARENT/$(basename "$OUTPUT_ARG")"
case "$OUTPUT_DIR/" in
  "$REPO_ROOT/ios/"*|"$REPO_ROOT/node_modules/"*)
    echo "OUTPUT_DIR must be outside the repository's ios/ and node_modules/ directories." >&2
    exit 2
    ;;
esac
if [[ -e "$OUTPUT_DIR/Still-unsigned-arm64.ipa" ]]; then
  echo "Refusing to overwrite an existing Still-unsigned-arm64.ipa in OUTPUT_DIR." >&2
  exit 2
fi
if [[ -e "$REPO_ROOT/ios" ]]; then
  echo "Refusing to run Expo prebuild --clean because ios/ already exists. Use a fresh repository copy for each build." >&2
  exit 2
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
cd "$REPO_ROOT"

export EXPO_NO_DOTENV=1
export EXPO_NO_GIT_STATUS=1

version_at_least() {
  local actual="$1" minimum_major="$2" minimum_minor="$3"
  local major minor
  IFS=. read -r major minor _ <<< "$actual"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( major > minimum_major || (major == minimum_major && minor >= minimum_minor) ))
}

test "$(uname -s)" = "Darwin"
MACOS_VERSION="$(sw_vers -productVersion)"
version_at_least "$MACOS_VERSION" 26 2 || {
  echo "This build requires macOS 26.2 or later; found $MACOS_VERSION." >&2
  exit 1
}

XCODE_VERSION="$(xcodebuild -version | awk '/^Xcode / { print $2; exit }')"
version_at_least "$XCODE_VERSION" 26 4 || {
  echo "Expo SDK 57 requires Xcode 26.4 or later; selected Xcode is $XCODE_VERSION." >&2
  exit 1
}
NODE_VERSION="$(node -p 'process.versions.node')"
version_at_least "$NODE_VERSION" 22 13 || {
  echo "Expo SDK 57 requires Node.js 22.13 or later; found $NODE_VERSION." >&2
  exit 1
}
command -v pod >/dev/null

npm ci
npm run check:ios-config
bash scripts/test-expo-fetch-lifetime.sh
npm run typecheck
npm test
npm run lint

npx expo prebuild --platform ios --clean --no-install
npx expo-modules-autolinking verify
pod install --project-directory=ios

WORKSPACE="$(find ios -maxdepth 1 -type d -name '*.xcworkspace' -print -quit)"
test -n "$WORKSPACE"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/still-unsigned-ios.XXXXXX")"
DERIVED_DATA="$TEMP_ROOT/DerivedData"
RAW_BUILD_LOG="$TEMP_ROOT/XcodeBuild.log"
PATH_REDACTED_BUILD_LOG="$OUTPUT_DIR/xcodebuild-path-redacted.log"
PRODUCT_DIR="$DERIVED_DATA/Build/Products/Release-iphoneos"
PACKAGE_ROOT="$TEMP_ROOT/Package"
trap 'rm -rf "$TEMP_ROOT"' EXIT

if ! xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED_DATA" \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY='' \
  build >"$RAW_BUILD_LOG" 2>&1; then
  sed -E "s|$HOME|~|g; s|/Users/[^/[:space:]]+|/Users/<user>|g" "$RAW_BUILD_LOG" > "$PATH_REDACTED_BUILD_LOG"
  tail -n 120 "$PATH_REDACTED_BUILD_LOG" >&2
  exit 1
fi

sed -E "s|$HOME|~|g; s|/Users/[^/[:space:]]+|/Users/<user>|g" "$RAW_BUILD_LOG" > "$PATH_REDACTED_BUILD_LOG"
APP="$(find "$PRODUCT_DIR" -maxdepth 1 -type d -name '*.app' -print -quit)"
test -n "$APP"
test "$(find "$PRODUCT_DIR" -maxdepth 1 -type d -name '*.app' | wc -l | tr -d ' ')" = "1"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
test "$BUNDLE_ID" = "com.still.voiceassistant"
EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
APP_ARCHS="$(xcrun lipo -archs "$APP/$EXECUTABLE")"
test "$APP_ARCHS" = "arm64"
test -s "$APP/main.jsbundle"
test "$(grep -c 'StillPrivacy' ios/Podfile.lock)" -ge 1
grep -F 'StillPrivacyModule.swift' "$PATH_REDACTED_BUILD_LOG" >/dev/null
if find "$APP" -name embedded.mobileprovision -print -quit | grep -q .; then
  echo 'Unexpected provisioning profile in unsigned app.' >&2
  exit 1
fi

mkdir -p "$PACKAGE_ROOT/Payload"
ditto "$APP" "$PACKAGE_ROOT/Payload/$(basename "$APP")"
(cd "$PACKAGE_ROOT" && /usr/bin/zip -X -qry "$OUTPUT_DIR/Still-unsigned-arm64.ipa" Payload)

IPA_SHA256="$(shasum -a 256 "$OUTPUT_DIR/Still-unsigned-arm64.ipa" | awk '{print $1}')"
{
  echo "bundle_id=$BUNDLE_ID"
  echo "app_archs=$APP_ARCHS"
  echo "host_arch=$(uname -m)"
  echo "macos=$MACOS_VERSION"
  echo "xcode=$XCODE_VERSION"
  echo "node=$NODE_VERSION"
  echo "signed=no"
  echo "embedded_provisioning_profile=no"
  echo "ipa_sha256=$IPA_SHA256"
  echo "module_build_log_source_match=yes"
  echo "module_link_or_runtime_proof=no"
} > "$OUTPUT_DIR/BUILD-INFO.txt"

printf 'Unsigned iPhone package created: %s\n' "$OUTPUT_DIR/Still-unsigned-arm64.ipa"
printf 'Path-redacted Xcode build log: %s\n' "$PATH_REDACTED_BUILD_LOG"
printf 'Build metadata: %s\n' "$OUTPUT_DIR/BUILD-INFO.txt"
