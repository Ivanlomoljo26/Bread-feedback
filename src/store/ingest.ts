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
  syncKey, loadCheckpoint, holdReason, beginAttempt,
  recordSuccess, recordFailure, recordDeferral, recordPause,
} from './checkpoint';
import { dispositionOf, type SyncDisposition } from './failure';

/**
 * Why a tick did nothing, said precisely.
 *
 * Three very different holds used to share one sentence about backing off,
 * which made a rate-limited sync and a sync with a dead key read the same in
 * the logs — and those are the two cases where knowing which is which is the
 * whole job.
 */
const HOLD_REASON: Record<'paused' | 'deferred' | 'backoff', string> = {
  backoff: 'backing off after a previous failure',
  deferred: 'waiting out a rate limit the store asked for',
  paused: 'paused: a credential was refused, so only an occasional probe runs',
};

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
  /** How the failure was handled. Null when the run did not fail. */
  disposition: SyncDisposition | null;
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
    exhausted: false, error: null, disposition: null,
  };

  const checkpoint = await loadCheckpoint(db, key);
  if (!options.force) {
    // `force` is the operator's way past all three holds, a pause included:
    // the person who has just rotated a key should not have to wait out a
    // probe interval to find out whether it worked.
    const hold = holdReason(checkpoint, nowMs);
    if (hold) {
      report.skipped = HOLD_REASON[hold];
      return report;
    }
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

    /**
     * NOT EVERY FAILURE IS THE SAME FAILURE. The store client classified this
     * one from the response — never from the message — and the three answers
     * are genuinely different operations, not three severities of one.
     *
     * The cursor is handled identically in all three: it advances to the page
     * that FAILED, so whenever the sync resumes it does so there rather than
     * re-walking what was just stored.
     */
    const failure = dispositionOf(walked.error);
    report.disposition = failure.disposition;

    if (failure.disposition === 'park') {
      await recordPause(db, key, walked.error, nowMs, walked.nextToken);
    } else if (failure.disposition === 'defer') {
      await recordDeferral(db, key, nowMs + failure.deferMs!, nowMs, walked.nextToken);
    } else {
      await recordFailure(db, key, walked.error, nowMs, walked.nextToken);
    }
    return report;
  }

  await recordSuccess(db, key, walked.nextToken, nowMs);
  return report;
}
