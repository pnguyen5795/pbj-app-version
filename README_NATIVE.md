# PB&J native development

The current product is the SwiftUI iPhone app plus `server/src/v2`, using a personal Mac service and **Use Local Workspace**. The older React app supplies visual references. The [root README](README.md) is the quick start; [build status](docs/BUILD_STATUS.md) and the [fix plan](docs/FIX_PLAN.md) distinguish implementation from completed acceptance.

The full reference → cut → correction → verified export → useful later learning flow is not yet signed off. Automatic captions are deferred and hidden. Separate accounts, Clerk setup and public hosting are future deployment work, not prerequisites for personal testing.

## Build and install

Open `ios/PBJ.xcodeproj`, select the **PBJ** scheme, then select a simulator or connected iPhone. The core package targets iOS 18 or later. Device installation requires Xcode signing and Developer Mode as prompted.

For updates, retain the existing bundle identifier `com.pbj.native.mediatest` and signing team. Install over the existing app; do not uninstall it to update. A new phone also needs private Mac pairing provisioned before it can use the service. All phones paired to this personal service share its `local-spike` workspace; this is not separate-user account isolation.

The paired Debug app uses its stored Mac address and pinned certificate. An unpaired Debug simulator defaults to `http://127.0.0.1:8787`. Provider keys belong on the Mac, never in the iPhone bundle.

## Personal Mac service

Use [Mac Service/README.md](Mac%20Service/README.md) and its **Start**, **Check** and **Stop** launchers on the configured Mac. Requirements are Node 24+, installed server dependencies, FFmpeg/ffprobe, the existing native registry, and private configuration/pairing files. Launchers contain machine-specific paths; keep the workspace in place or regenerate them after deliberately migrating its data.

The runner reads the saved AI setting. Enabled mode runs API and worker, loads provider credentials on the Mac and resumes saved jobs; paused mode provides project access without running AI jobs. Startup prints the selected mode. Paid provider work already submitted can continue after a local stop.

For local API-only development in an unpaired simulator, first stop the personal service, then run:

```sh
cd server
npm ci
PBJ_LOCAL_DEVELOPMENT=1 PBJ_PROCESS=api PBJ_DATA_ROOT=data/native npm run api:native
```

This is loopback-only and does not start AI processing. It requires the **existing** `server/data/native/registry`; it deliberately does not create a replacement registry. Only one process may open this local PGlite database. Stop the service before any direct registry inspection or migration, and preserve original bytes and provider receipts.

The server's default `npm start`/`npm run dev` launches the legacy prototype. `api:native` and `worker:native` are the current backend entry points; separate API/worker processes require PostgreSQL, not the shared local PGlite directory.

The future hosted path is described in [SERVICE_SETUP.md](docs/SERVICE_SETUP.md): Clerk, HTTPS, PostgreSQL and private object storage. Public app values include `PBJ_API_URL`, `PBJ_CLERK_PUBLISHABLE_KEY` and optional `PBJ_APPLE_SIGN_IN_ENABLED`; these do not replace provider secrets or personal pairing.

## Implemented scope and verification

- Active handoff navigation, optional teaching, upload/recipe/progress, Review, revisions, approval, Studio, project history and learning controls.
- Nondestructive trim/split/replace/add/delete, tap selection, hold-and-drag ordering, rounded clip boundaries, scrub/zoom, speed/rotation, original volume/mute and undo/redo.
- Imported/extracted sound and timed text/image/video overlays; shared native playback and verified local export to Photos or sharing. Automatic captions remain deferred.
- Saved analyses, attributed references, contextual lessons and exclusion controls; offline local projects plus queued feedback/export synchronization.

The existence of these paths is not proof of creative quality or full recovery/performance coverage. Follow the current fix plan for the remaining device, lifecycle and 10–60-minute workload checks.

From the repository root:

```sh
cd server
npm run typecheck:native
npm run test:native
cd ..
swift test --package-path ios/PBJCore
./ios/Tests/run-application-tests.sh
```

The application harness compiles the actual `ApplicationModel.swift` and `AppAPI.swift`, using temporary documents, test-only editor/authentication dependencies and intercepted network responses. It checks request retry identity, draft handoff, failed-job routing and unchanged polling without starting the service or contacting providers.

Core tests include optional real-media gates: `PBJ_TEST_VIDEO`/`PBJ_TEST_EXPORT` for a source export, `PBJ_PLAN_DIRECTORY`/`PBJ_PLAN_EXPORT` for a saved plan, and `PBJ_FINISHING_VIDEO`/`PBJ_FINISHING_IMAGE`/`PBJ_FINISHING_EXPORT` for the finishing fixture. Use new output paths. These automated checks do not replace touch, real background transfers, low-storage or creative acceptance checks.
