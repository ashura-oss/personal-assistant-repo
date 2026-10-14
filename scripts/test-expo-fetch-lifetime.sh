#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

cp "$repo_root/tests/FetchTaskLifetimeHarness.swift" "$temp_dir/main.swift"
swiftc -swift-version 6 -o "$temp_dir/fetch-task-lifetime" \
  "$repo_root/node_modules/expo/ios/Fetch/FetchTaskLifetime.swift" \
  "$temp_dir/main.swift"
"$temp_dir/fetch-task-lifetime"
