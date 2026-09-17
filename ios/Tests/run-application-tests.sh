#!/bin/bash
set -eu

# Compile the real lifecycle/API files without an iPhone, live service or keys.
task_tests_dir="$(cd "$(dirname "$0")" && pwd)"
task_ios_dir="$(cd "$task_tests_dir/.." && pwd)"
task_package="$(mktemp -d "${TMPDIR:-/tmp}/pbj-application-tests.XXXXXX")"
trap 'rm -rf "$task_package"' EXIT
export PBJ_CORE_PATH="$task_ios_dir/PBJCore"
mkdir -p "$task_package/Sources/ApplicationHarness" "$task_package/Tests/ApplicationHarnessTests"
cp "$task_ios_dir/PBJ/ApplicationModel.swift" "$task_ios_dir/PBJ/AppAPI.swift" \
  "$task_ios_dir/PBJ/BackgroundTransfer.swift" \
  "$task_ios_dir/PBJ/BackgroundWorkController.swift" "$task_ios_dir/PBJ/CompletionNotifications.swift" \
  "$task_tests_dir/ApplicationTestDoubles.swift" "$task_package/Sources/ApplicationHarness/"
cp "$task_tests_dir/ApplicationLifecycleTests.swift" "$task_tests_dir/ApplicationIngestionTests.swift" \
  "$task_tests_dir/BackgroundAndNotificationTests.swift" "$task_package/Tests/ApplicationHarnessTests/"
cat > "$task_package/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription
import Foundation
let package = Package(
  name: "ApplicationHarness",
  platforms: [.macOS(.v15)],
  dependencies: [.package(path: ProcessInfo.processInfo.environment["PBJ_CORE_PATH"]!)],
  targets: [
    .target(name: "ApplicationHarness", dependencies: [.product(name: "PBJCore", package: "PBJCore")]),
    .testTarget(name: "ApplicationHarnessTests", dependencies: ["ApplicationHarness", .product(name: "PBJCore", package: "PBJCore")])
  ],
  swiftLanguageModes: [.v5]
)
SWIFT
swift test --package-path "$task_package" \
  --scratch-path "$task_ios_dir/.build/application-tests" "$@"
