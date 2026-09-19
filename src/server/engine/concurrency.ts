// SPEED + COST — BOUNDED CONCURRENCY FOR INDEPENDENT ACQUISITION WORK.
//
// Two primitives, and deliberately nothing more:
//
//   mapWithConcurrency  runs an async mapper over items with at most
//                       `limit` in flight, and returns results IN INPUT
//                       ORDER. Order is the whole point: everything
//                       downstream of an acquisition loop — budget
//                       accounting, trace, candidate dedup, the S5 reducer —
//                       stays sequential and deterministic, and only the
//                       network wait overlaps.
//   serializeByKey      an in-process gate that runs `fn` calls sharing a key
//                       one at a time, in arrival order. Used for the one
//                       acquisition resource that is capped per job by a
//                       read-then-act check (rendered documents), so a
//                       parallel fetch cannot race that cap.
//
// FASTER MUST NOT MEAN WEAKER. Neither primitive changes what is acquired,
// admitted, reduced or proven; a job with a limit of 1 behaves exactly as
// the sequential loops did. The limit is read once from the environment so
// an operator can pin it to 1 in production without a code change.

// EXTRACTION IS SEQUENTIAL BY DEFAULT — A FOUNDER DECISION IS PENDING.
//
// Founder decision 5.5B pins the extractor's failure semantics: a permanent
// provider rejection on the FIRST document is fatal after ONE call and "the
// next document is never touched"; two consecutive transient exhaustions
// are fatal and the third is never touched. Fatality is only known when a
// call RETURNS, so a document's call may not start before the previous
// document's outcome is known — which is the definition of sequential.
// Overlapping extraction therefore cannot honour "never touched" for a
// document that fails after an earlier success (up to limit-1 later
// documents are already in flight). The machinery is here, it is pinned
// equivalent in the no-failure case, and it is OFF until the Founder
// decides whether "no NEW calls after a fatal outcome" may replace "never
// touched". ATLAS_EXTRACTION_CONCURRENCY=4 opts in.
export function extractionConcurrency(): number {
  const raw = process.env.ATLAS_EXTRACTION_CONCURRENCY;
  const n = raw === undefined ? NaN : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  return 1;
}

export function acquisitionConcurrency(): number {
  const raw = process.env.ATLAS_ACQUISITION_CONCURRENCY;
  const n = raw === undefined ? NaN : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  return 4;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  opts: { shouldStart?: () => boolean } = {},
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.shouldStart && !opts.shouldStart()) return;
      const index = next;
      if (index >= items.length) return;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

// Like mapWithConcurrency, but returns one promise PER ITEM, started in
// input order with at most `limit` in flight, so a caller can consume the
// results in order while later ones are still running. Used where the
// consumer's own sequential logic (budget outcome, failure accounting,
// admission) must see each result as soon as its predecessors are done,
// not once everything is.
export function startWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R>[] {
  const width = Math.max(1, Math.min(limit, items.length));
  const settlers: Array<{ resolve: (r: R) => void; reject: (e: unknown) => void }> = [];
  const promises = items.map(
    () =>
      new Promise<R>((resolve, reject) => {
        settlers.push({ resolve, reject });
      }),
  );
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= items.length) return;
      next += 1;
      try {
        settlers[index].resolve(await fn(items[index], index));
      } catch (e) {
        settlers[index].reject(e);
      }
    }
  };
  for (let i = 0; i < width; i++) void worker();
  return promises;
}

const gates = new Map<string, Promise<void>>();

export async function serializeByKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = gates.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  gates.set(key, previous.then(() => mine));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (gates.get(key) === previous.then(() => mine)) gates.delete(key);
  }
}
