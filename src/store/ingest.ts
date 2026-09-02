/**
 * One sync run, end to end — and the only part of the ingestion path that
 * knows about all the others.
 *
 * It takes a fetcher, walks its pages, normalises each raw review, writes it
 * through the single dedup path, and records where it got to. It contains no
 * credential, no HTTP, and no knowledge of Google or Apple: Phase 1 supplies
 * `fetchPage`, and this is already built and tested by then.
 *
 * A FAILED RUN IS STILL A PARTIALLY SUCCESSFUL RUN.
 * If page four throws, pages one to three are still written. That is not
 * sloppiness — it is the only correct behaviour against a source that serves a
 * 7-day window. Discarding three good pages because a fourth failed risks
 * reviews that may never be offered again, and it is safe to keep them because
 * `upsertReview` is idempotent: the retry re-reads nothing it does not need to.
 *
 * ONE BAD REVIEW DOES NOT FAIL THE BATCH.
 * A payload that will not normalise is counted, logged and skipped. The
 * alternative — throwing — lets a single malformed record block every good
 * review behind it, on a clock, which is the worst possible trade here.
 */
import { assertUpsertable, type NormalizedReview } from './normalize';
import { upsertReview } from './upsert';
import { paginate, type FetchPage, type PaginateOptions } from './paginate';
import {
  syncKey, loadCheckpoint, isDue, beginAttempt, recordSuccess, recordFailure,
} from './checkpoint';

export interface IngestSource {
  source: 'google_play' | 'app_store';
  appId: string;
  /** Supplied by the platform client. Phase 1 for Google, Phase 2 for Apple. */
  fetchPage: FetchPage<unknown>;
  /** Raw payload -> canonical record. Throws on anything unusable. */
  normalize: (raw: unknown, appId: string, nowMs: number) => Promise<NormalizedReview>;
}

export interface IngestReport {
  key: string;
  ran: boolean;
  /** Set when the run was skipped, with why. */
  skipped: string | null;
  pages: number;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Payloads that could not be normalised or written. Never fatal. */
  rejected: number;
  flagged: number;
  exhausted: boolean;
  error: string | null;
}

export interface IngestOptions extends PaginateOptions {
  /** Ignore backoff. For an operator-triggered run, never for the cron. */
  force?: boolean;
  newId?: () => string;
}

export async function runIngest(
  db: D1Database,
  src: IngestSource,
  nowMs: number,
  options: IngestOptions = {}
): Promise<IngestReport> {
  const key = syncKey(src.source, src.appId);
  const report: IngestReport = {
    key, ran: false, skipped: null, pages: 0, fetched: 0,
    created: 0, updated: 0, unchanged: 0, rejected: 0, flagged: 0,
    exhausted: false, error: null,
  };

  const checkpoint = await loadCheckpoint(db, key);
  if (!options.force && !isDue(checkpoint, nowMs)) {
    report.skipped = 'backing off after a previous failure';
    return report;
  }

  report.ran = true;
  // Stamped BEFORE any work, so a run that crashes outright still leaves a
  // trace. A sync that dies silently and leaves no attempt recorded is
  // indistinguishable from one that never fired.
  await beginAttempt(db, key, nowMs);

  const walked = await paginate(src.fetchPage, {
    ...options,
    startToken: options.startToken ?? checkpoint?.cursor ?? null,
  });
  report.pages = walked.pages;
  report.fetched = walked.items.length;
  report.exhausted = walked.exhausted;

  // Everything collected is written, INCLUDING when the walk ended in an error.
  for (const raw of walked.items) {
    try {
      const record = await src.normalize(raw, src.appId, nowMs);
      assertUpsertable(record);
      const result = await upsertReview(db, record, nowMs, options.newId);
      report[result.outcome] += 1;
      if (result.flagged) report.flagged += 1;
    } catch (err) {
      // Counted, not thrown. The message is logged rather than stored against
      // a row, because there is no row — normalisation is what failed.
      report.rejected += 1;
      console.warn('store ingest: skipped an unusable review', key, (err as Error)?.message);
    }
  }

  if (walked.error) {
    report.error = String((walked.error as Error)?.message ?? walked.error).slice(0, 300);
    // The cursor advances to the page that FAILED, so the retry resumes there
    // rather than re-walking what was just stored.
    await recordFailure(db, key, walked.error, nowMs, walked.nextToken);
    return report;
  }

  await recordSuccess(db, key, walked.nextToken, nowMs);
  return report;
}
