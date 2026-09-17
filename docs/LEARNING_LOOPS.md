# PB&J learning loops — implementation, September 11, 2026

The learning changes use the existing Mac database, durable jobs and cached analysis. There is no new service, vector database, model training system, or repeated video scan. Source changes have passed local regression tests and an iPhone build; installing the app and restarting the live service are separate steps.

## What teaches PB&J

| Input | What is saved | How it influences a future cut |
|---|---|---|
| Finished reference, optional raw footage and teaching notes | Attributed observations, analysis citations and applicability | Relevant examples; never treated as proof of personal taste |
| Explicit feedback | That feedback event, its scope and original timestamp | A reusable explicit preference can apply immediately; project-only feedback stays scoped |
| Approved AI correction | The actual requested change and the part retained in the approved cut | One tentative contextual lesson, if the intent is supported |
| Manual changes retained in approval or verified export | Surviving before/after differences, original decisions and cached scenes | Tentative lessons when the reason is supported; ambiguous numeric trims may produce no lesson |

An untouched AI result does not teach a preference. A model's confidence label cannot strengthen a lesson. Approval and export of the same concrete outcome share one learning job. Re-exporting, regenerating IDs, re-uploading an original, or retaining an old correction while making another change does not create additional independent support for that correction.

## Evidence and scope

Every newly classified personal lesson must cite supplied human decision IDs. Source and scene IDs provide context; they cannot stand in for a human decision. Newly classified explicit feedback retains the user's exact wording as its authoritative statement; an AI paraphrase cannot replace it. The stored receipt retains the cited request or manual difference, relevant sources and scene context. Original provider inputs and outputs remain frozen for recovery without submitting the same request again.

History follows the content selected during approval/restore, including branches that differ from the prior current head. Consecutive manual saves are compared together so an edit followed by undo cancels. Overwritten changes and abandoned branches are omitted. History reads stop at 128 revisions with cycle detection. Incomplete legacy history cannot grant cross-project reuse.

Feedback from the selected branch carries forward through approval/export. The model receives the latest 12 excerpts, each bounded to 3,000 characters. Scope checks cover every comment on that selected lineage, including comments outside the excerpt limit. Any project-only instruction conservatively keeps the derived outcome lesson project-only; context feedback never adds another independent vote.

## Retrieval and confidence

Each new rule records an editing facet, applicable formats and any required subjects. For example, shortening empty setup in a fast montage can transfer from flight to golf footage; a rule about preserving a golf follow-through stays subject-specific. Retrieval considers the current brief, latest revision instruction and cached scene summaries. Output format comes from the request rather than scene descriptions, and direct category exclusions are respected. The planner is instructed to prioritize the current request and required moments over saved preferences.

Equivalent rules keep separate, immutable evidence contributions under one rule key. Confidence is recomputed from enabled, non-excluded evidence:

- An inferred single example is tentative.
- At least two independent examples can support a rule.
- Explicit reusable feedback can establish a preference immediately.
- Reference observations remain references, regardless of count.

Contributions sharing a human decision, source root or independent-example key count as one connected example. This is deliberately conservative. Similar wording may be consolidated only against a supplied compatible candidate with the same kind, scope and applicability. A reference or inferred pattern cannot replace an explicit personal preference. Explicit reusable feedback may replace a compatible earlier preference; chronology follows when the user gave feedback, even if an old job finishes later.

Disabling a rule disables the whole equivalent group and keeps later equivalent contributions disabled. Excluding evidence recomputes support and removes its influence. Removing the evidence behind a replacement can restore the older supported rule. Saved Learning shows applicability, independent-example count, scope and active/disabled/excluded/replaced state. Controls refresh the effective state immediately.

Planner requests receive at most 12 relevant memories; extraction compares at most 20. Selection loads lightweight metadata and provenance links rather than copying full historical scene/timeline receipts into every request. Existing unclassified memories and old saved responses retain conservative lexical matching; the upgrade does not silently give them universal applicability.

## Implementation and rollout

- `server/migrations/006_learning_policy.sql` adds nullable classification and rule grouping to the existing memory table, with per-rule/event deduplication. Existing rows retain their identity.
- `learningOutcomes.ts` collects retained human evidence and contextual feedback.
- `memory.ts` and `learningPolicy.ts` handle scope, retrieval, support, exclusions and replacement.
- The existing API/worker capture approval/export learning and extract classified lessons using cached scenes.
- The iPhone Saved Learning screen displays the effective policy and refreshes controls.

The migration runs through the existing migration path at the next authorized service startup. Development has not opened or migrated the live user store, installed the phone build, changed credentials, or started paid processing. Keep existing projects and pairing when installing the build. Starting the Mac service with AI enabled can resume queued work; the earlier pending media authorization remains separate.

## Measuring whether it helps

Use the [offline comparison utility](../server/scripts/LEARNING_EVALUATION.md) on two separately recorded runs with identical brief, sources, cached analysis, required moments, timing, model and planner version. One run has memory off; the other has memory on. Do not manufacture a baseline by deleting memory from a completed run's saved input.

The tool validates eligibility, timeline constraints, citations, applicable active memory and declared held-out provenance. It reports whether a memory was used and whether the cut changed. Human preference and measured correction time are recorded separately, with story/timing work distinguished from finishing.

Local regression tests demonstrate the mechanism and recovery rules. They do not demonstrate improved creative quality. A real matched comparison, human review and iPhone walkthrough remain the Milestone 1 acceptance checks. Automatic captions and hosting are still deferred.

## Validation record

The final backend suite passed 79 tests, the actual app lifecycle harness passed 10, and the unsigned generic-iPhone build passed. TypeScript checking passed. Final local logs are in the workspace's `work/app-build/learning-backend-tests-final.log` and `learning-app-build-final.log`. The new app regression checks toggle/exclusion refresh during the same busy operation and new/legacy response decoding. No live user data or paid providers were used.

The subsequent [adversarial audit](LEARNING_AUDIT_2026-09-11.md) expanded the backend suite to 104 passing tests and fixed additional identity, retrieval, atomicity and validation defects. It records remaining semantic/creative limits separately from code correctness.
