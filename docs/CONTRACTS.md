# Native contracts — versions 1 and 2

## Timeline

Swift definitions: `ios/PBJCore/Sources/PBJCore/Timeline.swift`.
TypeScript validators: `server/src/v2/contracts.ts`.

One second is 60,000 integer ticks. `sourceIn` is relative to the original
video presentation start; `MediaSource.mediaStart` maps it to media time.
`sourceDuration` is positive. `outputStart` is explicit and must equal the sum
of preceding output durations. Legacy version 1 remains readable; version 2
adds the speed and finishing fields described below.

Every clip has stable `id` and `sourceID`, source range, placement, volume
(0–2), mute, and `fit` (`fit` or `fill`). Every timeline has an immutable revision
ID and optional parent ID, render dimensions, frame rate, and schema version.
References are not eligible unless deliberately registered as project inputs.

The Swift compositor adds the source presentation offset once. Audio is
intersected with each source range and placed with its real offset. Preview
and export use the same composition and original-audio mix.

## Analysis

One baseline row is unique by account-owned asset, whose original hash is
unique within that account. Model, prompt, schema, project, brief, and local
processing changes do not change that baseline key.

State progression:

`reserved → uploading → uploaded → submitting → pending → complete`

Uncertain acceptance stays `unresolved`; invalid saved output stays
`needs_review`; known provider failure stays `failed`. Only one caller wins
each submission transition. A completed baseline requires full response and
normalized evidence. Provider IDs are stored before later stages. Result
persistence retries retrieve the existing task rather than create one.

`Evidence` contains timestamped scenes, visual/audio/speech text, confidence,
observations with scene references, and uncertainties. Approximate timestamps
are not frame-accurate edit boundaries. Citation IDs may name an entire
analysis, `analysisID:sceneID`, or `analysisID:observation-N` where N is the
zero-based index in the stored immutable analysis version.

Short-media derivatives use explicit technical padding and preserve the original
duration; cached derivatives are validated before submission and repaired locally
when damaged. Upload reconciliation preserves uncertain submissions instead of
reposting them. A native-registry transfer script exists; production execution and
reconciliation of other legacy caches remain unverified. Explicit reanalysis
authorization/versioning has no endpoint yet. There is no automatic reanalysis.

## Memory and outcomes

Each record carries a version, kind (attributed reference or personal lesson),
context, strength, provenance, independent root evidence IDs, and optional
project scope. Retrieval filters disabled/excluded roots and account ownership
before ranking a bounded text shortlist.

Timeline diffs distinguish additions, removals, same-ID replacements, trims,
relative reordering and audio changes. Timeline shifts caused by trimming do
not count as reordering. An unchanged timeline creates no deliberate edit diff.
The export schema binds each outcome to one immutable revision and deduplicates
per owner/revision. Native export-manifest synchronization and OpenAI lesson
extraction are implemented. The server validates the client report against the
stored revision; it does not independently inspect the exported artifact. Test
exports are not endorsements. The complete live learning-quality gate is pending.

Each feedback job freezes only its own feedback event. Export learning uses actual
manual differences against the nearest nonmanual ancestor on that revision's
branch. AI-only and unchanged exports add no independent lesson. Equal manually
corrected render content within one project shares one learning job even if
revision/track IDs changed. A previous no-lesson export cannot suppress a later
deliberate correction. Context feedback retains exclusion provenance and its
reusability restrictions.

## Durable jobs

Jobs deduplicate by owner/kind/logical key. Claims use PostgreSQL row locking,
leases and unique lease tokens. Stale workers cannot complete newer claims.
Attempts are bounded and exhausted work needs attention. Reclaiming a lease
does not authorize replaying an uncertain provider operation. These primitives
are connected to the continuous worker in `server/src/v2/runtime.ts`. Production
workers use PostgreSQL; the local API-only audit process does not run paid jobs.

## Application and finishing extension (September 7)

The native reader accepts timeline versions 1 and 2. New native commits write version 2. Optional clip `speed` is 0.25–4 (default 1); `rotation` is 0/90/180/270. Output duration is `round(sourceDuration / speed)`, still in 60,000 ticks/sec. Splits/trims preserve original source coverage; placement, thumbnails, word timing and audio scale through that rate.

A source may declare `kind` as video/audio/image; absent means legacy video. Base clips accept video only. Optional `sounds` contain original source range, placement, volume and rate. Optional `overlays` contain kind (text/caption/image/video), start/end, content/source range, normalized position/width, rotation, opacity, font size, style and hex color. Overlay video may include original audio. Validation enforces owned sources, bounds and unique track IDs. Finishing tracks do not pad the main video's duration. Rough-cut revisions preserve finishing tracks unchanged.

Captions map original timed words through audible clips, extracted/imported sounds and audible video overlays. They are ordinary editable text overlays in the shared renderer, not a separate SwiftUI-only caption surface. Overlapping speakers/tracks can require manual caption correction.

Application routes are under `/v2`: account usage; resumable uploads; original/thumbnail media; projects, inputs, immutable revisions, approve/restore/revise; feedback/verified export manifests; captions; jobs/resume; teaching; memory and exclusions. Owner identity comes from verified Clerk tokens, not client JSON. A Debug-only loopback workspace uses a separate explicit owner.

Provider calls freeze their exact input and save full receipts before parsing. Revision IDs and generated clip IDs are deterministic on replay. A compare-and-swap against the base revision retains stale results without advancing the project head. Local edits, feedback and export manifests persist independently of network availability; provider lessons are generated only from explicit feedback or deliberate verified-output differences.

The native app treats unreadable application state as a recovery condition, not a
fresh account. Saves cannot overwrite undecodable state. Feedback/export queues
and new-project request IDs must be persisted before transmission. Failed local
saves block sign-out until the pending state is saved. Account polling starts
after activation; stale responses cannot change a different account or hijack
navigation after leaving Cooking. Approval and restore must be accepted before
the native app installs their snapshots.

Migrations 003–005 add application records, speech chunks and recovery timestamps. The schema migration takes a PostgreSQL advisory transaction lock when used with a server pool. PGlite remains an explicitly single-process development adapter.
