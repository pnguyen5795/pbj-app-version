# Service and signing setup

## Accounts and app configuration

Use a Clerk instance configured for the native application. The app uses official **ClerkKit 1.5.4**. Enable email verification and the desired Google/Apple connections. Configure the native callback scheme `com.pbj.native.mediatest` consistently with the Xcode URL type and Clerk dashboard. Additional MFA/account requirements need a separate live account check; the app reports incomplete verification instead of declaring success.

In the PBJ target's user-defined build settings, set:

- `PBJ_API_URL`: your HTTPS API origin, without `/v2`.
- `PBJ_CLERK_PUBLISHABLE_KEY`: the public `pk_test_…` or `pk_live_…` value.
- `PBJ_APPLE_SIGN_IN_ENABLED`: `YES` only after adding Sign in with Apple in Signing & Capabilities and configuring the provider. Otherwise use `NO`.

`ios/Configuration/Service.example.xcconfig` is a copyable example. Keep the actual local configuration ignored. Provider keys and Clerk's secret key belong only in the backend environment. A personal Xcode signing account can run the app, but Apple sign-in capability may require the appropriate developer membership/setup.

The previous phone build uses bundle `com.pbj.native.mediatest` and team `7C5KTYR5K6`. Retain the bundle to update over it and preserve Documents. The user confirmed the physical device as an iPhone 15 Pro; CoreDevice reported **iPhone 15 Pro Max**, iOS 26.5.2. Testing is deferred until it is connected again.

## Backend

`server/Dockerfile.native` packages Node 24, FFmpeg and the new API/worker only. `deploy/compose.yaml` supplies PostgreSQL, one API and one worker with shared durable upload/cache storage. Originals go to a private S3-compatible bucket. The API listens on loopback port 8787 in the Compose host configuration: place it behind your host's HTTPS reverse proxy. PostgreSQL is not published publicly.

Copy `deploy/.env.example` to ignored `deploy/.env`, fill the service values, and provision the bucket/database. The S3 endpoint must be reachable by the worker and TwelveLabs; objects stay private. Large analysis derivatives use expiring signed GET URLs, not public bucket ACLs.

Before enabling ingestion, complete registry reconciliation below. Then:

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env up --build -d
```

Docker is not installed in the current Mac environment, so this container/deployment recipe has not been launched here. For an existing host, run `PBJ_PROCESS=api node src/v2/runtime.ts` and `PBJ_PROCESS=worker node src/v2/runtime.ts` with Node 24, dependencies, FFmpeg, PostgreSQL and persistent paths configured. Production requires `DATABASE_URL`, `CLERK_SECRET_KEY`, private storage values, and the explicit reconciliation flag. The loopback-only local development authentication cannot run with `NODE_ENV=production`.

API/worker share PostgreSQL, originals and a persistent upload directory. With multiple API instances, the unfinished upload directory must be shared too. Keep one worker initially; the database queue supports leases and owner-safe replay. Back up PostgreSQL and original object storage. `server/data/native/registry` is durable development history, not disposable cache.

## Move existing native analysis safely

Stop all processes opening the source PGlite registry, then back up the full `server/data/native` directory. Never open it in two processes.

Inventory without external writes:

```sh
cd server
PBJ_SOURCE_DATA_ROOT=data/native node scripts/migrate-native-registry.ts
```

The inventory on September 7 found two completed baseline analyses with full receipts, one completed speech result, eleven imported reference observations and one saved project. The script never calls an AI provider.

To copy into an empty destination account, set `DATABASE_URL`, S3 variables, `PBJ_SOURCE_DATA_ROOT`, `PBJ_SOURCE_OWNER` (normally `local-spike`) and `PBJ_DESTINATION_OWNER` (the actual Clerk `user_…` ID), then run with `--apply`. It verifies original hashes, stores private originals, imports rows transactionally with stable IDs/receipts, and checks counts. It stops on a nonempty destination owner, partial upload or corrupt completed record. Source data is retained. An interrupted pre-transaction S3 copy can be retried using the same object keys.

This imports the **native** registry, not every historical cache elsewhere on the Mac. Inventory and reconcile earlier prototype results under `Desktop/GitHub/PBJ_MVP/data/cache` as well. Imported legacy reference observations do not establish that every legacy source's full analysis has been migrated. Set `PBJ_REGISTRY_RECONCILED=1` only once the combined inventory is accounted for; an empty database is not proof a file has never been analyzed.

## Provider behavior and recovery

New jobs reserve an original hash once. A completed result is reused; a timed-out or uncertain paid submission is not automatically repeated. Raw provider output is saved before normalization. Resume retries local validation or retrieval and respects the original provider identity. Unresolved acceptance remains visible for operator reconciliation.

Short sources retain their original duration in the timeline. A new analysis derivative may add a final-frame hold/silence to meet the provider's minimum, and normalization removes those padded timestamps. Video, audio and thumbnails share the original video's time origin. The adapter checks the model's two-hour/2 GB input limits, with audio-preserving bounded derivatives. [Pegasus requirements](https://docs.twelvelabs.io/v1.3/docs/concepts/models/pegasus). Prepared files above 200 MB use durable native multipart upload, with no hosted media URL required. Session and part receipts remain in the existing analysis registry; uncertain creation and expired sessions require recovery rather than silent replacement. [Multipart API](https://docs.twelvelabs.io/api-reference/upload-files/multipart-uploads/create), [ingestion audit](INGESTION_AUDIT_2026-09-11.md).

Speech timing uses saved 300-second chunks with overlapping context; every chunk retains its receipt and is never automatically reposted after ambiguous acceptance. Local conversion failures remain retryable before submission. Missing API configuration is caught before a request is claimed. Account usage shows recorded request/token counts and analyzed media, with no application spending limit.

## Live acceptance sequence

Use one account and the saved test originals first. Verify teaching before the first cut, a scoped correction, approval, manual edits, export and later lesson retrieval. Then verify a second account cannot access the first account's projects or media. Confirm actual iOS background uploads/relaunch, offline edits/export manifests, stale revisions and sign-out isolation. The checked-in deterministic tests cover mechanisms; they do not establish production deployment behavior or creative quality.
