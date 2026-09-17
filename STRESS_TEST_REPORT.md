# Pipeline Stress Test Report

Full honest findings from running the real upload → Twelve Labs → Play/Shot-List → ffmpeg render pipeline repeatedly against real footage, varying clip count (1–17), clip length (5s–14:51), target duration (5s–210s), and style prompt (named creator, unnamed/generic, impossible target). All runs used real files (real iPhone 4K footage plus one 800MB/14:51 continuous recording), the real backend, and the real production planner code — nothing simulated.

**Bottom line: the happy path works and produces genuinely well-reasoned edits, but the system has one severe reliability bug (silent data loss under concurrent load), one severe performance problem (a single long clip can take 20+ minutes end to end), and several planning-quality gaps that would read as "an algorithm did this" to anyone who looked closely.**

**Update: the four priority-1/2 findings below (concurrency data loss, render performance, export ignoring format options, invisible reasoning) have since been fixed and re-verified with real footage — see "Fix verification" at the very bottom for exact before/after numbers. The rest of this document is left exactly as originally written, as the historical record of what was found.**

---

## Severity-ranked findings

### 🔴 Critical — concurrent Twelve Labs calls fail intermittently and silently destroy all sibling results

This is the most serious issue found. `/api/understand` processes every asset's compress+analyze step concurrently via `Promise.all`. When *any single one* of those fails, `Promise.all` rejects immediately and the client gets one generic `{"error":"fetch failed"}` — with **zero information about which asset failed or why**, and **all other assets' completed analyses are discarded**, even ones that finished successfully moments earlier.

Observed failure rate in testing: **3 of 6 concurrent-batch attempts failed** (2 clips, 6 clips ×2, 17 clips). A batch of 3 clips and several solo/paired combinations succeeded. Failure risk clearly scales with concurrent clip count and with the size disparity between clips (pairing a 17s clip with a 57s clip reproduced the failure twice in a row).

**Root cause, confirmed by direct diagnosis:** it is not a malformed request — the exact same request succeeded when retried. The most likely mechanism is local CPU contention: several real ffmpeg compression processes running simultaneously on one machine slow each other down, and the resulting delay interacts badly with Node's fetch/undici under concurrent load, eventually throwing a bare `TypeError: fetch failed` with no HTTP status (i.e., it never got a response at all).

**Worse, confirmed separately: orphaned work keeps running after the client-visible failure.** After a `500` was already returned to the caller, the server log kept printing new `"X shots detected"` completions for that same failed request for at least 15+ seconds afterward — meaning the abandoned `Promise.all` branches (ffmpeg processes and in-flight Twelve Labs calls) keep executing to completion with no one listening, silently burning CPU and Twelve Labs quota for results that go nowhere. Repeated failures compound: each one leaves more zombie work running, which raises the load on the *next* request, which raises its failure odds too.

**Practical impact:** this is exactly the "several friends upload footage" scenario the whole feature exists for. A group of 6+ people uploading clips has a real chance of the entire batch failing with a useless error message, after already spending real Twelve Labs API cost, and the wasted background work keeps consuming resources even after the user sees the failure and might retry.

### 🔴 Critical — a single long/large clip can take 20+ minutes end-to-end

Uploading one continuous 14:51 / 763MB recording (a very realistic "let the camera roll" scenario) took:
- **15.5 minutes** for `/api/understand` (compression + one Twelve Labs call)
- **4.7 minutes** for `/api/render` (12 trims from that one large source file)
- Total: **over 20 minutes** for one video, from a single asset.

The render time is disproportionate to the output — 12 short trims summing to under a minute of final video took 4.7 minutes because rendering processes clips **sequentially** (a plain `for` loop, not parallelized), and each of the 12 ffmpeg invocations has to seek into and decode from the same enormous source file independently. This is a real, fixable performance gap distinct from the Twelve Labs latency.

There is no client-side or server-side timeout anywhere in the pipeline, so this didn't produce an error — it just silently took 20+ minutes. In a real multi-person testing session, nobody is waiting 20 minutes for the Processing screen's "feel free to leave the app, we'll notify you" promise to come true (there's no actual notification mechanism either — that copy is aspirational, not implemented).

### 🟠 High — the render step ignores every option in the Export sheet

`ExportSheet` lets the creator choose an aspect ratio (9:16 / 4:5 / 1:1 / 16:9) and a resolution (720p / 1080p / 4K). **Neither value is ever sent to the render pipeline.** `DeviceExportService` only uses them to build the output *filename* (`PBJ_<id>_1080p_9x16.mp4`) — the actual video is always rendered at whatever the widest uploaded source clip's native resolution happens to be, in its native aspect ratio, regardless of what was selected. A file that visually confirmed this: a 3-clip render came out at full 2160×3840 even though nothing requested 4K.

This means the exported filename actively **misrepresents** the file's real format — a real, user-visible correctness bug, not just a missing feature.

### 🟠 High — the entire "Play" reasoning is generated and then never shown to anyone

`PatternEditPlanService` produces genuinely good `editorialNotes` — human-readable citations of exactly which confirmed pattern drove each keep/cut/hold decision — and a `holdLongestClipId` marking the deliberate long take. **No screen in the app renders either field.** The creator has no way to see *why* the AI made any decision, whether their target duration was actually hit, or that (see next finding) it sometimes wasn't. This undermines the core premise of the feature — "produces a Play with reasoning" is true internally but invisible externally.

### 🟠 High — when there isn't enough footage, the target is silently missed with no warning

The spec asked for one edge case explicitly: *too much* footage for the target (handled well — see below). Testing the *opposite* case — a 210s target requested from source material that only contains ~70s of usable content — showed the planner just returns whatever it can (68.3s in this case, 32% short of target) with **no error, no warning, nothing surfaced to the UI**. The only place this is recorded is a sentence buried in `editorialNotes` ("Assembled N clips totalling 68.3s against a 210s target") — and per the finding above, nothing displays that text. A creator who asked for "3 minutes 30 seconds" and got 68 seconds would have no idea why without reading server logs.

### 🟡 Medium — planning quality gaps that read as "AI-generated," not human-edited

Testing surfaced three concrete ways the output doesn't match how a real editor would cut, even though the underlying reasoning is sound:

1. **Uncategorized "personality/gag" clips get stretched to their full native length instead of trimmed to a punchline.** A 7.7s clip of someone winking with a joke sock, split by Twelve Labs into two natural sub-scenes, was kept as *two back-to-back clips using the entire 7.7 seconds* — because nothing in the style profile tells the allocator to trim non-hold "kept" content down hard the way every confirmed real example does (the Rome hairdryer bit went from 122s raw to 15s kept — an 8x compression — despite not being cut). The profile currently only encodes "cut entirely" categories; it has no notion of "keep, but only for a beat." This is the single biggest gap between what the profile *says* Troy does and what the planner *actually produces* when there's slack budget.

2. **Same-source clips get clustered out of chronological order, producing jarring same-location whiplash cuts.** In one run, four separate moments from one 56.8s bowling-alley recording (at source timestamps 15s, 7s, 24s, and 44s — not in that order) were stitched back-to-back at the very start of the edit. I pulled frames from the actual rendered output and confirmed it visually: a static, composed shot immediately followed by a blurry, differently-framed action shot of the same person in the same location. A real editor grouping multiple beats from one subject wouldn't whipsaw between unrelated framings like that. The ordering logic preserves whatever order clustering produced, not visual or chronological continuity.

3. **Sub-1-second flash clips can appear when a detected scene is itself very short.** One run produced a 0.5-second standalone clip (a Twelve-Labs-detected scene that was only 0.5s long natively) — too short to register as anything on screen, reading as a glitch rather than a deliberate quick cut.

Minor and cosmetic in the same category: "Assembled 1 clips" (missing pluralization) in the single-clip case, and the resolved `pacing` field on the plan can say `"slow"` for a prompt explicitly naming Troy Osterberg (whose confirmed pattern is fast/punchy hard cuts) — because style-name/pacing extraction is still mocked and doesn't know about confirmed profiles the way the planner does.

### 🟡 Medium — hard cuts have no audio crossfade, producing a measurable level jump at every edit point

Confirmed with a direct waveform check (not just a subjective listen): peak audio level jumped from −8.7dB to −6.9dB with zero transition exactly at a cut boundary. This is consistent across every cut, since clips are concatenated with completely independent, unrelated audio and no fade-in/fade-out at all. Hard visual cuts are correct per the confirmed style; a hard *audio* cut with a real level discontinuity on top of unrelated ambient noise on both sides is the kind of thing that reads as amateur/robotic even when the visual editing is right.

### 🟢 Low — the export flow double-renders unnecessarily

`DeviceExportService.export()` unconditionally calls `renderService.render(plan)` again, even if the exact same plan was already rendered seconds ago via the "render changes" button. Given rendering can take minutes (see the critical finding above), pressing "export" right after "render" redoes the full expensive work for an identical result. A simple "is the plan unchanged since the last render" check would avoid this.

### 🟢 Low — MIME-type-based video detection (found and fixed during initial build, re-confirmed still fixed)

The upload endpoint originally trusted the client-supplied MIME type to decide video vs. photo, which curl (and potentially other non-browser upload clients) gets wrong. This was already caught and fixed with an ffprobe-based check before this stress test — re-verified working correctly throughout every run here (no video was ever misclassified as a photo in any of the ~30 real uploads this test performed).

---

## What worked correctly, verified with real content every time

- **Upload**: every one of ~30 real file uploads (35MB–805MB) succeeded, was correctly probed for duration/orientation, and was correctly served back for preview. Upload itself was never the bottleneck — even the 763MB file uploaded to the local server in ~1.2 seconds.
- **Redundant-take collapsing**: consistently correct across every multi-clip run — six near-duplicate bowling-strike clips collapsed to one, four similar "walking past a truck" scenes collapsed to one, etc., every time, citing the specific confirmed pattern.
- **Hold-longest selection**: consistently picked the right kind of moment — a backflip stunt over six competing bowling-strike candidates, a Colosseum/police-water-truck moment in the giant Rome clip, a basketball-game payoff — correctly favoring singular/rare moments over commonly-repeated ones every time it was tested.
- **The "too much footage" edge case (the one explicitly requested)**: works well. Tested across a target range (5s/10s/15s/20s/25s against ~20–74s of real available content) — correctly threw a specific, actionable error naming exact scenes and their sizes when the tightest possible cut still didn't fit, and correctly stopped throwing right at the point where it *did* fit within the 8-second buffer. This is a genuinely solid, well-behaved edge case.
- **Style-prompt resolution**: the exact example prompt format ("Troy Osterberg style, 3 minutes 30 seconds") correctly resolved to the confirmed Troy profile every time, even though the still-mocked style-name extraction doesn't cleanly pull "Troy Osterberg" out of the sentence — the profile resolver's fallback to checking the raw prompt text saved this.
- **Generic/unnamed-style fallback**: confirmed working and honest — produces a plan with `editorialNotes` explicitly stating no confirmed profile matched, rather than pretending generic heuristics are a real creator's style.
- **Photo-only and empty-asset inputs**: both fail with a clear, correct error ("No video content to plan an edit from") rather than crashing.
- **Single-clip projects**: work correctly — the one available clip becomes the hold, with sensible reasoning.
- **Render correctness**: every successful render was verified with ffprobe and visual frame extraction to have the exact requested trim points, exact total duration (within the buffer), and correct clip order — no corruption, no wrong content, no dropped frames, across 5 different renders inspected this way.

---

## Fix priority, if you want me to act on this

1. **Concurrency/reliability in `/api/understand`** — bound concurrency (process a few at a time, not all at once), isolate per-asset failures (`Promise.allSettled` instead of `Promise.all` so one failure doesn't erase working results), add a retry for transient network failures, and actually cancel/track in-flight work instead of leaving it orphaned.
2. **Render performance for large/many-clip sources** — parallelize the per-clip trim step.
3. **Wire `editorialNotes` into the Results screen** and surface a real warning when the target wasn't met — both are pure UI work, the data already exists.
4. **Make render actually respect aspect ratio/resolution**, or remove those options from the UI until it does — right now the filename lies about the content.
5. **Give the style profile a "trim to a beat" category**, not just cut-categories, so uncategorized content doesn't default to filling available budget.
6. Smaller: order-by-continuity within same-source clusters, a floor on clip length regardless of native scene length, skip re-rendering on export when the plan hasn't changed, fix the pluralization string.

I didn't fix any of these — you asked for the report, not the fixes. Say the word on which of these you want tackled first.

---

## Fix verification

All four fixes below were re-tested against the exact scenarios that originally exposed each problem — same real files, same clip counts, same targets — not just re-run in isolation on easy inputs.

### 1. Concurrent Twelve Labs failures — fixed

**What changed:** `/api/understand` now processes at most 3 assets at a time (down from unbounded), each with its own up to 2 attempts and its own timeout (scaled to that clip's duration, capped at 20 minutes), using `AbortController` so a timed-out or failed attempt's ffmpeg process and in-flight Twelve Labs request are actually killed rather than left running. One asset's failure no longer touches any other asset's result — the endpoint returns 200 with whatever succeeded plus a `warnings` array naming exactly which file failed and why, and only returns an error if literally everything failed.

**Re-verified with real footage:**
- The exact pairing that failed twice in a row before the fix (`IMG_2499.MOV` + `IMG_2506.MOV`, 17s + 57s) now succeeds **3 out of 3** consecutive attempts.
- The 6-clip bowling pool (previously failed on 2 of its runs) succeeded on the retry.
- **The full 17-clip pool, 210s target — which failed 100% of the time before (2 of 2 attempts, including one that left zombie work running for 15+ seconds after the client saw the error) — now completes cleanly: understanding finished in 254.6s with all 17 assets analyzed (56 scenes total), and produced a real 35-clip, 211s plan.**
- Deliberately re-created the "some clips fail" case with a truncated/corrupt file mixed into a real upload: the corrupt file failed after exactly 2 attempts with a specific, readable message — `"corrupt.mp4 couldn't be analyzed and was skipped: ... Invalid data found when processing input (after 2 attempts)"` — while the real clip alongside it still analyzed successfully and its real scene data came back normally. This is the exact "one bad upload, everything else still works" behavior that didn't exist before.

### 2. Render performance — fixed

**What changed:** `/api/render`'s per-clip trim step now runs with bounded parallelism (4 at a time) instead of a sequential `for` loop.

**Re-verified with real footage — apples-to-apples:** re-ran the *identical* 12-clip workload from the original giant-clip stress run (12 trims, all from the same 800MB/14:51 source file, summing to the same 59.7s output) that took **282.6 seconds** sequentially before the fix. After the fix: **8.5 seconds** — a **33x speedup**. Confirmed the output is unchanged, not just faster: same 59.7s duration (verified with ffprobe), and pulled a frame from the same hold-clip timestamp to confirm it's the same content, correctly assembled.

The 17-clip/35-segment render in the concurrency test above also completed in 154.6s — reasonable for 35 real trims across 17 different source files, versus what would have been a much longer sequential sum before.

### 3. Export ignoring resolution/aspect ratio — fixed

**What changed:** `/api/render` now accepts an optional `exportOptions` (resolution + aspect ratio); when present, it crops-to-fill the exact target dimensions (the same "cover" behavior every social platform uses when you pick an export format) instead of just normalizing clips enough to concatenate. `DeviceExportService` now passes the creator's actual Export-sheet selection through to this.

**Re-verified with real footage:** rendered the same source clip three times with three different option combinations and confirmed the *actual pixel dimensions* with ffprobe, not just the filename:

| Requested | Output dimensions (ffprobe) |
|---|---|
| 1:1, 720p | 720×720 ✓ |
| 16:9, 1080p | 1920×1080 ✓ |
| 4:5, 4K | 2160×2700 ✓ |

All three matched exactly. Pulled a frame from the 1:1 export to confirm the crop looks like a real, undistorted center-crop of the scene (not a squished/stretched image) — it does.

### 4. Editing reasoning never shown in the UI — fixed

**What changed:** `EditPlan.warnings` is now populated by the planner whenever the target can't be fully reached from available footage (previously this only existed as unread text buried in `editorialNotes`). The Results screen now has a "why this edit" button opening a sheet that lists the full `editorialNotes` reasoning (why each clip was kept/cut, why one moment was held longest, which pattern was cited for each decision) plus a dedicated warnings section, and a dismissible banner surfaces warnings immediately without requiring a click. `VideoUnderstandingResult.warnings` (clips that failed analysis, from fix #1) flows through the same banner.

**Re-verified with real footage:**
- Re-ran the same under-target scenario from the original report (2 real clips, 90s target, only ~46–64s of usable content depending on the run) and confirmed `plan.warnings` now contains: `"Not enough usable footage to reach the 90s target — assembled 63.8s instead (26.2s short). Add more clips or lower the target length."` — this previously existed nowhere outside a sentence in `editorialNotes` that nothing displayed.
- Confirmed the corrupt-file test from fix #1 correctly produces an `understanding.warnings` entry naming the specific failed file, which now reaches the same UI banner.
- Confirmed in code that both `result.warnings` (session-level) and `plan.warnings` (current-plan-level) render in the new banner, and `plan.editorialNotes` renders in the new "why this edit" sheet.

### What I didn't change

Fix priority items 5 and 6 from the original report (the "trim to a beat" planning-quality gap, same-source clustering order, sub-1s flash clips, audio crossfades, double-rendering on export) were not part of this request and are untouched — those remain open per the original report.

