# PB&J

PB&J is a native iPhone video editor backed by a privately paired Mac service. The Mac sends video analysis to TwelveLabs and editing context to OpenAI; the iPhone previews, edits and exports through the shared native compositor.

The current scope is personal testing with **Use Local Workspace**, one shared dummy identity, and devices on the same home network. Public hosting, separate user accounts and automatic captions are deferred. The app has a working native editor and local AI-service implementation; representative device and long-workload acceptance remains part of development.

## Start the personal app

1. In [Mac Service](Mac%20Service/README.md), double-click **Start PBJ.command** on the configured Mac. Leave its Terminal window open.
2. Open the installed **PB&J** app on the iPhone and choose **Use Local Workspace**. Allow Local Network access and keep both devices on the same home network.
3. Use **Check PBJ.command** to check the connection and jobs, or **Stop PBJ.command** to stop the Mac service gracefully.

The launcher reads the saved AI-processing setting. When enabled, it resumes queued work and can make paid TwelveLabs/OpenAI requests. Stopping the Mac does not cancel work already accepted by a provider. These instructions do not establish whether a service or provider task is running now.

For installation and development, open [ios/PBJ.xcodeproj](ios/PBJ.xcodeproj), select the **PBJ** scheme and the target iPhone in Xcode. Preserve the existing bundle/signing identity and install over the app to retain its projects. A second phone needs its own installation and pairing. Detailed setup and checks are in [README_NATIVE.md](README_NATIVE.md).

The [background work guide](docs/BACKGROUND_WORK.md) covers saved upload/revision/export recovery, completion alerts, free-account testing and the optional paid Apple push setup. Real Mac-to-iPhone alerts while PB&J is suspended need that later setup; the default build keeps it disabled.

## Source map

| Location | Purpose |
|---|---|
| `ios/PBJ` | App screens, navigation, imports and synchronization |
| `ios/PBJCore` | Canonical timeline, persistence and native playback/export |
| `server/src/v2` | Current API, jobs, provider adapters and learning |
| `server/scripts` | Mac service setup, launch support and recovery utilities |
| `docs` | Architecture contracts, service setup, background work and learning behavior |
| `src`, `public`, older `server/src` files | Preserved React prototype and visual reference |

The root `npm run dev`/`build` and server `npm start`/`npm run dev` target the **legacy prototype**, not the iPhone service. Use the Mac launchers for this personal installation. Prototype media/analysis stores are retained for recovery and should not be cleared or treated as a fresh library.

Private provider credentials, pairing files, media and analysis records stay outside source control. Preserve `server/data/native` and its receipts when updating or moving the project.
