// Mirrors server/src/concurrency.ts's mapWithConcurrency — duplicated
// rather than shared across the frontend/backend boundary (same call as
// styleTrainingAnalysis.ts duplicating its own small word-overlap helpers
// instead of reaching across it) since this is a tiny, framework-free
// primitive with no reason to couple the two builds together.
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

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
