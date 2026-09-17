# Offline learning comparison

This utility compares two **already saved** runs. It never generates a cut, calls an API, opens the registry, or changes either run. Use the `planning-input.json` and `planning-result.json` artifacts from each run. Removing memory from an existing run's input does not create a valid memory-off baseline; each result must come from its corresponding recorded input.

Create a comparison manifest beside those artifacts:

```json
{
  "schemaVersion": 1,
  "caseID": "held-out-flight-01",
  "memoryOff": {
    "inputPath": "off/planning-input.json",
    "resultPath": "off/planning-result.json",
    "model": "MODEL_FROM_SAVED_RUN",
    "plannerVersion": "PLANNER_VERSION_FROM_SAVED_RUN"
  },
  "memoryOn": {
    "inputPath": "on/planning-input.json",
    "resultPath": "on/planning-result.json",
    "model": "MODEL_FROM_SAVED_RUN",
    "plannerVersion": "PLANNER_VERSION_FROM_SAVED_RUN"
  },
  "heldOutEvidenceIDs": ["held-out-finished-reference-or-feedback-id"]
}
```

For project-scoped memories, add a top-level `projectID` matching their original project. Without that identity, scoped comparisons are rejected.

Paths are relative to the manifest. The model and planner version must match between runs; a saved provider response's model must also match the declaration. All planning inputs except `memory` must be identical, including source hashes, brief, required moments, analysis versions, speech timing, duration target, base timeline and revision scope. Memory-off must contain no memories; memory-on must contain at least one.

From the server directory, with Node 24:

```sh
node scripts/evaluate-learning.ts comparison.json report.json
```

The optional output filename must be new, so an existing artifact cannot be overwritten. Omit it to print the report.

The report rejects duplicate source/evidence/memory identities, malformed declared original hashes, mismatched baseline IDs, inactive or inapplicable memory, wrong project scope, and reused provider response IDs. It validates the saved timelines with the existing planner validator, including source bounds/eligibility, source and memory citations, required moments and timed-word boundaries. It reports whether memory was cited and whether rendered content changed, ignoring revision/clip ID differences. None of those mechanism checks certifies creative quality or causality.

`heldOutEvidenceIDs` is optional. List the held-out final references, feedback, or derived memory IDs whose influence must be excluded. The check examines each supplied memory's ID, root provenance, nested receipt/pointer provenance and supporting IDs; it does not discover undeclared or missing provenance. The held-out raw analysis used for that case's inference remains a valid input.

After reviewing both cuts, optionally add measured human results to the manifest:

```json
"human": {
  "reviewer": "Your name",
  "preferred": "memoryOn",
  "correctionSeconds": {
    "memoryOff": 180,
    "memoryOn": 110,
    "scope": "story-and-timing"
  },
  "notes": "The learned cut needed less setup trimming."
}
```

Use actual measurements, not these example values. Preferences may be `memoryOn`, `memoryOff`, `tie`, or `undecided`; either preference or correction times may be omitted. Use `includes-finishing` when the times also include music/text/finishing work; those times are explicitly excluded from the rough-cut comparison. Without a human assessment, creative quality is reported as **not measured**. Compare several held-out cases before claiming learning improves editing quality.

These are saved-state checks. They do not verify current account exclusions/archives, actual source bytes or receipt authenticity. Reports show whether distinct provider response IDs were supplied; different IDs alone do not establish a controlled experiment.
