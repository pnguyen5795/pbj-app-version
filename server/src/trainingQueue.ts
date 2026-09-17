import { TWELVE_LABS_JOB_CONCURRENCY } from "./concurrency.js";

// A trickle-fed job queue, distinct from mapWithConcurrency: uploads
// arrive one at a time as separate HTTP requests over an unpredictable
// span of time (not as one fixed array known upfront), so jobs are
// pushed in as they're ready rather than handed to the queue all at once.
// Bounded at TWELVE_LABS_JOB_CONCURRENCY so a 50-video training batch
// can't run more simultaneous ffmpeg-compress + Twelve-Labs-call jobs
// than this machine has already been shown to handle reliably — jobs
// beyond that just wait their turn instead of piling on.

type Job = () => Promise<void>;

const pending: Job[] = [];
let active = 0;

export function enqueueAnalysisJob(job: Job): void {
  pending.push(job);
  pump();
}

function pump(): void {
  while (active < TWELVE_LABS_JOB_CONCURRENCY && pending.length > 0) {
    const job = pending.shift()!;
    active += 1;
    job().finally(() => {
      active -= 1;
      pump();
    });
  }
}
