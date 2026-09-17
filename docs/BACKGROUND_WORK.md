# Background work and completion notifications

The default PB&J build stays usable with a free Xcode Personal Team. Push and background GPU capabilities are opt-in; the example files below are not selected by the project. Nothing in this setup requires App Store distribution.

## What works now

| Work | Behavior when leaving PB&J |
| --- | --- |
| Importing from Photos/Files | PB&J requests execution time for copying selected media, then saves owned originals. If iOS interrupts the picker before those copies are saved, select the remaining media again. No notification guesses when iCloud media will become available. |
| Uploading originals | File-backed transfers and saved server offsets support recovery. iOS 26 continued processing is requested; if unavailable, only limited extra time is available. Reopen PB&J if the upload pauses. |
| AI analysis and cut planning | Accepted work runs on the Mac while its service is running. The phone catches up on return. Real alerts from the Mac while the app is suspended require the optional APNs setup below. |
| Rendering the exported video | The current renderer requires graphics access. Without supported, entitled background GPU execution, leaving PB&J cancels the partial render and saves a restartable export. It does not pretend to keep rendering. |
| Completion messages | Local notifications and in-app completion cards use saved results. Enable Notifications in PB&J Settings. Permission denial leaves saved progress available in the app. |

Started generation and teaching requests retain their exact recipe, media and server identities through relaunch. Revisions retain the original instructions and scope before synchronization, then persist the exact final request before sending. A lost response retries that request; it never silently targets a newer edit. Home and My Projects expose saved revision requests for resume or explicit discard. Discarding a local retry cannot cancel work the Mac already accepted.

Foreground return resumes pending transfers after a previous operation finishes unwinding. A pre-submission revision that needs its original editor version waits for that project to be reopened. None of these recovery paths submit untouched drafts.

Exports save a project ID, an immutable revision, source metadata and an export ID before rendering. A verified video is published before its completion record and notification are issued. Reopening the project restores the finished video; an interrupted export restarts the saved revision from the beginning, because a partial MP4 is not a resumable render checkpoint. Later timeline edits do not change that saved export's identity.

Notification taps retain the initiating account and destination: a cut opens its project, a local export opens its exact saved file, a completed teaching result opens Learning, failed teaching opens Home's saved job controls, and an interrupted local upload opens its setup. Tapping a newer notification does not let an older canceled navigation erase it. A notification for another account is not opened under the current account.

iOS can expire background work or stop it under resource pressure. Force-quitting the app cancels continued tasks without a guaranteed cancellation callback. Neither background execution nor notification delivery is guaranteed. Saved state supplies recovery when the app returns. [Apple's continued-processing guidance](https://developer.apple.com/documentation/BackgroundTasks/performing-long-running-tasks-on-ios-and-ipados), [User Notifications](https://developer.apple.com/documentation/usernotifications).

## Optional real push delivery after joining a paid team

Real APNs delivery needs a paid Apple Developer Program team, its push-enabled App ID, appropriate signing and a provider authentication key. Local notifications, mock tests and simulated payloads can be tested beforehand. [Apple account capabilities](https://developer.apple.com/help/account/basics/about-your-developer-account), [Registering with APNs](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns).

1. In Xcode, select the paid team and enable **Push Notifications** for the existing bundle ID. Keep that bundle ID when updating an existing installation. Confirm the development provisioning profile includes the capability.
2. Use [Push-Development.entitlements.example](../ios/Configuration/Push-Development.entitlements.example) and [Push-Development.xcconfig.example](../ios/Configuration/Push-Development.xcconfig.example) as optional local configuration references. The development entitlement is `aps-environment = development`; PB&J's matching environment setting is `PBJ_PUSH_ENVIRONMENT = sandbox`. Set `PBJ_PUSH_ENABLED = YES` only for this configured build. Preserve existing entitlements when combining capabilities.
3. Obtain an APNs `.p8` key, Key ID and Team ID from the paid developer account. Keep the key on the Mac, outside source control and outside the iPhone bundle. [Apple's token authentication setup](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
4. Set these exact Mac service environment variables, substituting your own values:

```dotenv
PBJ_APNS_ENABLED=1
PBJ_APNS_TEAM_ID=REPLACE_WITH_10_CHARACTER_TEAM_ID
PBJ_APNS_KEY_ID=REPLACE_WITH_10_CHARACTER_KEY_ID
PBJ_APNS_BUNDLE_ID=com.pbj.native.mediatest
PBJ_APNS_ENVIRONMENT=sandbox
PBJ_APNS_PRIVATE_KEY_FILE=/absolute/private/path/AuthKey_REPLACE.p8
```

The service reads these variables from its process environment. The ordinary launcher currently loads only the three AI-provider settings from the existing provider environment file. Adding APNs settings there alone will not enable push. For an optional local setup, save the block as `server/data/personal-service/apns.env` (an ignored directory), restrict it and the key file to your user, stop the existing PB&J service, then start one instance from the repository's `server` directory using Node 24:

```sh
/usr/bin/caffeinate -i node --env-file=data/personal-service/apns.env scripts/personal-service-runner.ts data/personal-service/config.json
```

This uses the existing pairing and service configuration. Do not start it alongside another service instance. With `PBJ_APNS_ENABLED` unset or `0`, the sender reads no APNs key and opens no APNs connection. Invalid optional push configuration does not stop project processing.

The Mac sends outbound HTTP/2 requests to Apple's APNs endpoint; no rented host or inbound router forwarding is needed for push delivery. The Mac must remain awake, online and running PB&J. Receiving an alert away from home does not make the paired `.local` Mac service reachable away from home. [Apple provider connections](https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns).

Development builds and this recipe use `sandbox`. A future distribution build needs matching production signing, app environment and server environment; never reuse a sandbox device token as a production token.

## Background GPU access is a separate capability

Keep `PBJ_BACKGROUND_GPU_ENABLED` unset or `NO` in the free default build. [BackgroundGPU.xcconfig.example](../ios/Configuration/BackgroundGPU.xcconfig.example) documents the separate opt-in flag. Set it to `YES` only after adding **Background GPU Access** in Xcode, obtaining valid signing for `com.apple.developer.background-tasks.continued-processing.gpu`, and testing the device's runtime support.

The app still requires `BGTaskScheduler.supportedResources` to contain `.gpu`. Paying for membership or adding an entitlement does not make an unsupported device support it. Apple publishes no fixed supported-device list; do not assume support from an iPhone model name. [Background GPU entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.background-tasks.continued-processing.gpu), [Apple DTS clarification](https://developer.apple.com/forums/thread/794072).

## Free, synthetic notification test

The offline application harness tests notification decoding, account-safe destinations, deduplication and background expiration without contacting APNs. The server notification tests use an injected sender. Export tests generate their own video and verify active-render cancellation. Run from the repository root:

```sh
bash ios/Tests/run-application-tests.sh
node --test server/tests/notifications.test.ts
swift test --package-path ios/PBJCore --filter ExportJobTests
```

To exercise Simulator's notification interface, save the following JSON as a temporary `PBJ-Synthetic.apns` file. Replace `REPLACE_WITH_SIMULATOR_OWNER_ID` and `REPLACE_WITH_SYNTHETIC_PROJECT_ID` with the owner and project of a disposable simulator fixture. The remaining IDs are synthetic. Use a fresh notification `id` when testing a new event, or reuse it to test deduplication.

```json
{
  "Simulator Target Bundle": "com.pbj.native.mediatest",
  "aps": {
    "alert": { "title": "Synthetic test: your cut is ready", "body": "Open the test project." },
    "sound": "default"
  },
  "pbj": {
    "id": "11111111-1111-4111-8111-111111111111",
    "ownerID": "REPLACE_WITH_SIMULATOR_OWNER_ID",
    "jobID": "22222222-2222-4222-8222-222222222222",
    "kind": "plan",
    "status": "complete",
    "projectID": "REPLACE_WITH_SYNTHETIC_PROJECT_ID",
    "revisionID": "33333333-3333-4333-8333-333333333333",
    "title": "Synthetic test: your cut is ready",
    "body": "Open the test project.",
    "createdAt": "2026-09-11T12:00:00.000Z"
  }
}
```

With the simulator build installed and notification permission enabled:

```sh
xcrun simctl push booted com.pbj.native.mediatest /absolute/path/PBJ-Synthetic.apns
```

This injects a payload into Simulator. It does not send through APNs, start AI processing, create a completed cut, or prove real delivery/signing. Unmatched owner IDs should be rejected; a successful project-opening test needs an existing synthetic project. Apple's [Simulator notification instructions](https://developer.apple.com/documentation/xcode-release-notes/xcode-11_4-release-notes) describe this distinction. Physical background behavior and real APNs delivery remain device acceptance tests.
