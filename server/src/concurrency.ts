/**
 * Runs `fn` over `items` with at most `limit` running at once. Unlike
 * `Promise.all`, a rejection from one item never cancels or discards the
 * others — `fn` is expected to catch its own errors and return a settled
 * result (see `settled` helper below), so this function itself never
 * rejects. This is the fix for the stress-test finding where one flaky
 * Twelve Labs call under `Promise.all` threw away every already-completed
 * sibling result in the same batch.
 *
 * Bounding concurrency (rather than firing everything at once) also
 * directly addresses the most likely root cause found during diagnosis:
 * many simultaneous local ffmpeg processes competing for CPU, which was
 * observed to make concurrent Twelve Labs requests fail more often.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs `fn`, converting a thrown error into a `{ok: false}` result instead
 *  of letting it propagate — this is what makes mapWithConcurrency safe to
 *  use without Promise.allSettled: every task always "succeeds" from the
 *  scheduler's point of view, carrying its real outcome in the payload. */
export async function settled<T>(fn: () => Promise<T>, describeError: (err: unknown) => string): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The real, previously-established safe ceiling for any job that pairs
 * local ffmpeg compression with a Twelve Labs API call on this machine —
 * not a Twelve Labs rate limit. Stress testing on /api/understand traced
 * failures above this to CPU contention between simultaneous local ffmpeg
 * processes (see the comment on mapWithConcurrency above). Exported here
 * so every queue doing this kind of work (currently /api/understand and
 * the Style Training background analysis queue in trainingQueue.ts)
 * reuses the same tested number instead of each guessing its own.
 *
 * Note: the two queues that use this today are independent pools, not one
 * shared pool — running a live edit through /api/understand at the same
 * moment as a large Style Training batch could therefore briefly reach
 * 2x this ceiling. Unifying them into a single shared pool would mean
 * changing /api/understand's own concurrency mechanism, which is
 * deliberately left untouched here since it's already verified working.
 */
export const TWELVE_LABS_JOB_CONCURRENCY = 3;
