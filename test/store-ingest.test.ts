/**
 * The Google ingestion core — normalisation, hashing, paging, the idempotent
 * upsert, edit history, retries and checkpoints.
 *
 * NO CREDENTIAL EXISTS YET, AND THAT IS THE POINT. The fetcher is injected, so
 * everything hard about syncing a store is exercised here against fixtures
 * built from Google's documented response shape. When the service account
 * arrives, Phase 1 supplies one function that returns a page and this whole
 * path is already proven.
 *
 * The headline property, which several tests approach from different sides:
 * RE-SYNCING A WINDOW WRITES NOTHING. Everything else — resuming a cursor,
 * retrying a failed page, re-importing an overlapping CSV range later — is
 * only safe because that holds.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  canonicalize, hashRaw, fromGooglePlay, normalizeGooglePlay, NormalizeError,
} from '../src/store/normalize';
import { upsertReview } from '../src/store/upsert';
import { paginate } from '../src/store/paginate';
import { runIngest } from '../src/store/ingest';
import { loadCheckpoint, backoffMs, isDue, windowConsumed, MAX_BACKOFF_MS } from '../src/store/checkpoint';

const APP = 'com.miden.wallet';
const NOW = 1_788_300_000_000;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM store_review_events').run();
  await env.DB.prepare('DELETE FROM store_review_versions').run();
  await env.DB.prepare('DELETE FROM store_reviews').run();
  await env.DB.prepare('DELETE FROM store_sync_state').run();
});

/** A review in the shape Google's `reviews.list` documents. */
function gpReview(over: Record<string, any> = {}) {
  return {
    reviewId: over.reviewId ?? 'gp-1',
    authorName: over.authorName ?? 'M. Reyes',
    comments: [
      {
        userComment: {
          text: over.text ?? 'Private send fails every time since the update.',
          // `in`, not `??` — an explicit null must actually remove the field.
          // With `??` this fixture silently kept the default and N4 asserted
          // nothing at all.
          lastModified: 'lastModified' in over ? over.lastModified : { seconds: '1788190000', nanos: 0 },
          starRating: over.starRating ?? 2,
          reviewerLanguage: 'en',
          device: 'panther',
          androidOsVersion: 34,
          appVersionCode: 11519,
          appVersionName: '1.15.19',
          deviceMetadata: { productName: 'Pixel 7' },
          ...(over.userComment ?? {}),
        },
      },
      ...(over.developerReply
        ? [{ developerComment: { text: over.developerReply, lastModified: { seconds: '1788200000' } } }]
        : []),
    ],
  };
}

const rowOf = (id: string) => env.DB
  .prepare('SELECT * FROM store_reviews WHERE platform_review_id = ?').bind(id).first<any>();
const versionsOf = (srid: string) => env.DB
  .prepare('SELECT * FROM store_review_versions WHERE store_review_id = ? ORDER BY id').bind(srid).all<any>();
const eventsOf = (srid: string) => env.DB
  .prepare('SELECT * FROM store_review_events WHERE store_review_id = ? ORDER BY id').bind(srid).all<any>();

describe('normalisation', () => {
  it('N1. maps a documented Google payload onto the canonical record', async () => {
    const r = await normalizeGooglePlay(gpReview(), APP, NOW);
    expect(r.platformReviewId).toBe('gp-1');
    expect(r.platform).toBe('android');
    expect(r.source).toBe('google_play');
    expect(r.reviewBody).toContain('Private send fails');
    expect(r.rating).toBe(2);
    expect(r.reviewerName).toBe('M. Reyes');
    expect(r.appVersion).toBe('1.15.19');
    expect(r.appVersionCode).toBe(11519);
    expect(r.deviceProduct).toBe('Pixel 7');
    expect(r.osVersion).toBe('34');
    expect(r.language).toBe('en');
    // A language is not a country and must never be stored as one.
    expect(r.territory).toBeNull();
    expect(r.reviewCreatedAt).toBe(1_788_190_000_000);
  });

  it('N2. refuses a review with no reviewId rather than inventing one', async () => {
    // A synthesised id would be unique every run, so re-importing would create
    // a second row for every review — the exact failure the unique index
    // exists to prevent, arriving through the back door.
    expect(() => fromGooglePlay({ authorName: 'x', comments: [] }, APP, NOW))
      .toThrow(NormalizeError);
    expect(() => fromGooglePlay(null, APP, NOW)).toThrow(NormalizeError);
  });

  it('N3. the hash is stable when keys move, and changes when content does', async () => {
    // JSON key order is not guaranteed. Hashing raw text would make an
    // unchanged review look edited whenever a key moved, filling the version
    // history with identical copies of itself.
    const a = { reviewId: 'x', authorName: 'a', comments: [{ n: 1 }] };
    const b = { comments: [{ n: 1 }], authorName: 'a', reviewId: 'x' };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(await hashRaw(a)).toBe(await hashRaw(b));
    expect(await hashRaw({ ...a, authorName: 'z' })).not.toBe(await hashRaw(a));
  });

  it('N4. a payload with no usable timestamp still gets an ordering key', async () => {
    // review_created_at is NOT NULL because every queue orders by it. An
    // ordering column that can be null makes the order undefined.
    const r = await normalizeGooglePlay(gpReview({ lastModified: null }), APP, NOW);
    expect(r.reviewCreatedAt).toBe(NOW);
    expect(r.reviewUpdatedAt).toBeNull();
  });

  it('N5. a reply already on the store is captured', async () => {
    const r = await normalizeGooglePlay(gpReview({ developerReply: 'Sorry — fixed in 1.15.20.' }), APP, NOW);
    expect(r.existingReplyText).toBe('Sorry — fixed in 1.15.20.');
    expect(r.existingReplyAt).toBe(1_788_200_000_000);
  });
});

describe('the single dedup path', () => {
  it('U1. a first sight creates the row, one version, and an event', async () => {
    const r = await normalizeGooglePlay(gpReview(), APP, NOW);
    const res = await upsertReview(env.DB, r, NOW);
    expect(res.outcome).toBe('created');

    const row = await rowOf('gp-1');
    expect(row.review_state).toBe('new');
    expect(row.eligibility).toBe('undecided');
    expect(row.handoff_state).toBe('none');
    expect((await versionsOf(res.storeReviewId)).results).toHaveLength(1);
    expect((await eventsOf(res.storeReviewId)).results).toHaveLength(1);
  });

  it('U2. re-syncing the same review writes nothing but the clock', async () => {
    const r = await normalizeGooglePlay(gpReview(), APP, NOW);
    const first = await upsertReview(env.DB, r, NOW);

    const again = await normalizeGooglePlay(gpReview(), APP, NOW + 1000);
    const second = await upsertReview(env.DB, again, NOW + 1000);

    expect(second.outcome).toBe('unchanged');
    expect(second.storeReviewId).toBe(first.storeReviewId);
    // A run seeing a thousand unchanged reviews must not write a thousand rows
    // saying so.
    expect((await versionsOf(first.storeReviewId)).results).toHaveLength(1);
    expect((await eventsOf(first.storeReviewId)).results).toHaveLength(1);
    expect((await rowOf('gp-1')).last_synced_at).toBe(NOW + 1000);
  });

  it('U3. an edit adds a version and keeps the original readable', async () => {
    const first = await upsertReview(env.DB, await normalizeGooglePlay(gpReview(), APP, NOW), NOW);
    const edited = gpReview({ text: 'Actually it works now, my network was down.', starRating: 4 });
    const res = await upsertReview(env.DB, await normalizeGooglePlay(edited, APP, NOW + 5000), NOW + 5000);

    expect(res.outcome).toBe('updated');
    expect(res.storeReviewId).toBe(first.storeReviewId);

    const row = await rowOf('gp-1');
    expect(row.review_body).toContain('Actually it works now');
    expect(row.rating).toBe(4);
    // The ordering anchor does not move for a correction — a reviewer's list
    // must not reshuffle under them.
    expect(row.review_created_at).toBe(1_788_190_000_000);

    const versions = (await versionsOf(first.storeReviewId)).results;
    expect(versions).toHaveLength(2);
    // The first row is the original as received and is never rewritten.
    expect(JSON.parse(versions[0].raw_json).comments[0].userComment.text)
      .toContain('Private send fails');
    expect(versions[0].rating).toBe(2);
  });

  it('U4. an edit never overwrites a human decision', async () => {
    const first = await upsertReview(env.DB, await normalizeGooglePlay(gpReview(), APP, NOW), NOW);
    await env.DB.prepare(
      `UPDATE store_reviews SET review_state='not_actionable', eligibility='not_eligible',
              human_labels='["praise"]', human_decided_at=?, human_decided_by='ivan'
        WHERE store_review_id=?`
    ).bind(NOW + 100, first.storeReviewId).run();

    await upsertReview(
      env.DB,
      await normalizeGooglePlay(gpReview({ text: 'THE APP STOLE MY FUNDS' }), APP, NOW + 200),
      NOW + 200
    );

    const row = await rowOf('gp-1');
    // A review's author must not be able to move it through our pipeline, in
    // either direction, by editing what they wrote.
    expect(row.review_state).toBe('not_actionable');
    expect(row.eligibility).toBe('not_eligible');
    expect(row.human_labels).toBe('["praise"]');
    expect(row.human_decided_by).toBe('ivan');
    // But it is said out loud, because it is what a human needs to notice.
    const detail = (await eventsOf(first.storeReviewId)).results.map((e: any) => e.detail).join(' ');
    expect(detail).toContain('AFTER a human decision');
  });

  it('U5. a review containing a seed phrase is flagged, and the secret is not copied', async () => {
    const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const res = await upsertReview(
      env.DB,
      await normalizeGooglePlay(gpReview({ text: `help me ${seed}` }), APP, NOW),
      NOW
    );
    expect(res.flagged).toBe(true);

    const row = await rowOf('gp-1');
    expect(row.secret_scan_status).toBe('flagged');
    // Reason CODES only. Recording the secret in order to record that we found
    // a secret would defeat the point of finding it.
    expect(row.secret_scan_reasons).not.toContain('abandon');
    expect(JSON.parse(row.secret_scan_reasons).length).toBeGreaterThan(0);
  });

  it('U6. the same review id on two stores is two reviews', async () => {
    await upsertReview(env.DB, await normalizeGooglePlay(gpReview({ reviewId: 'shared' }), APP, NOW), NOW);
    const apple = await normalizeGooglePlay(gpReview({ reviewId: 'shared' }), APP, NOW);
    // Identity is (source, app_id, platform_review_id) — never the id alone.
    const res = await upsertReview(
      env.DB, { ...apple, source: 'app_store', platform: 'ios' }, NOW
    );
    expect(res.outcome).toBe('created');
    const { results } = await env.DB
      .prepare('SELECT source FROM store_reviews WHERE platform_review_id = ?').bind('shared').all<any>();
    expect(results).toHaveLength(2);
  });

  it('U7. a record built by hand, without normalising, is refused', async () => {
    const r = await normalizeGooglePlay(gpReview(), APP, NOW);
    // An empty rawHash would make every future sync of this review look like
    // an edit. The guard runs for every producer, not just the careful ones.
    await expect(upsertReview(env.DB, { ...r, rawHash: '' }, NOW)).rejects.toThrow(NormalizeError);
    await expect(upsertReview(env.DB, { ...r, platformReviewId: '' }, NOW)).rejects.toThrow(NormalizeError);
  });
});

describe('paging', () => {
  const pager = (pages: Array<{ items: any[]; nextToken: string | null }>) => {
    let i = 0;
    return async () => pages[i++] ?? { items: [], nextToken: null };
  };

  it('P1. walks to the end and reports exhaustion', async () => {
    const out = await paginate(pager([
      { items: [1, 2], nextToken: 't1' },
      { items: [3], nextToken: null },
    ]));
    expect(out.items).toEqual([1, 2, 3]);
    expect(out.exhausted).toBe(true);
    expect(out.nextToken).toBeNull();
    expect(out.pages).toBe(2);
  });

  it('P2. stops at the page budget and hands back a resume token', async () => {
    const out = await paginate(pager([
      { items: [1], nextToken: 'a' }, { items: [2], nextToken: 'b' }, { items: [3], nextToken: 'c' },
    ]), { maxPages: 2 });
    expect(out.items).toEqual([1, 2]);
    expect(out.exhausted).toBe(false);
    expect(out.nextToken).toBe('b');
  });

  it('P3. a failing page keeps what was already collected', async () => {
    let n = 0;
    const out = await paginate(async () => {
      n += 1;
      if (n === 1) return { items: ['a', 'b'], nextToken: 'page2' };
      throw new Error('502 upstream');
    });
    // Discarding good pages because a later one failed risks reviews that
    // Google's 7-day window may never offer again.
    expect(out.items).toEqual(['a', 'b']);
    expect(out.error).toBeTruthy();
    // The cursor points at the page that failed, so the retry resumes there.
    expect(out.nextToken).toBe('page2');
  });

  it('P4. a token pointing at itself ends the walk instead of looping', async () => {
    const out = await paginate(async () => ({ items: [1], nextToken: 'same' }), { maxPages: 100 });
    expect(out.pages).toBeLessThanOrEqual(2);
    expect(out.exhausted).toBe(true);
  });
});

describe('a sync run', () => {
  const source = (fetchPage: any) => ({
    source: 'google_play' as const, appId: APP, fetchPage, normalize: normalizeGooglePlay,
  });

  it('I1. a clean run stores the reviews and checkpoints its success', async () => {
    const report = await runIngest(env.DB, source(async () => ({
      items: [gpReview({ reviewId: 'a' }), gpReview({ reviewId: 'b' })], nextToken: null,
    })), NOW);

    expect(report.created).toBe(2);
    expect(report.error).toBeNull();
    expect(report.exhausted).toBe(true);

    const cp = await loadCheckpoint(env.DB, `google_play:${APP}`);
    expect(cp?.last_success_at).toBe(NOW);
    expect(cp?.consecutive_failures).toBe(0);
  });

  it('I2. RE-RUNNING THE SAME WINDOW WRITES NO DUPLICATES', async () => {
    // The property everything else rests on. A lost cursor, a crashed run, a
    // re-imported CSV range: all cost time, not correctness.
    const page = async () => ({ items: [gpReview({ reviewId: 'a' }), gpReview({ reviewId: 'b' })], nextToken: null });
    await runIngest(env.DB, source(page), NOW);
    const second = await runIngest(env.DB, source(page), NOW + 60_000);

    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(2);
    const { results } = await env.DB.prepare('SELECT store_review_id FROM store_reviews').all<any>();
    expect(results).toHaveLength(2);
  });

  it('I3. a partial failure stores what it got and resumes at the failing page', async () => {
    let n = 0;
    const report = await runIngest(env.DB, source(async () => {
      n += 1;
      if (n === 1) return { items: [gpReview({ reviewId: 'a' })], nextToken: 'p2' };
      throw new Error('503 from Google');
    }), NOW);

    expect(report.created).toBe(1);
    expect(report.error).toContain('503');

    const cp = await loadCheckpoint(env.DB, `google_play:${APP}`);
    expect(cp?.consecutive_failures).toBe(1);
    expect(cp?.cursor).toBe('p2');
    // A failed run never claims success — that is what the staleness alarm reads.
    expect(cp?.last_success_at).toBeNull();
  });

  it('I4. one unusable payload does not block the good ones behind it', async () => {
    const report = await runIngest(env.DB, source(async () => ({
      items: [gpReview({ reviewId: 'ok1' }), { authorName: 'no id here' }, gpReview({ reviewId: 'ok2' })],
      nextToken: null,
    })), NOW);

    expect(report.created).toBe(2);
    expect(report.rejected).toBe(1);
    // A single malformed record must not hold every good review behind it, on
    // a clock.
    expect(report.error).toBeNull();
  });

  it('I5. backoff skips a run that is not due, and force overrides it', async () => {
    let calls = 0;
    const failing = source(async () => { calls += 1; throw new Error('down'); });
    await runIngest(env.DB, failing, NOW);
    expect(calls).toBe(1);

    // One minute after the first failure, the next tick must not hammer it.
    const skipped = await runIngest(env.DB, failing, NOW + 1000);
    expect(skipped.ran).toBe(false);
    expect(skipped.skipped).toContain('backing off');
    expect(calls).toBe(1);

    const forced = await runIngest(env.DB, failing, NOW + 2000, { force: true });
    expect(forced.ran).toBe(true);
    expect(calls).toBe(2);
  });

  it('I6. backoff is capped far below the 7-day window', async () => {
    // Unbounded doubling reaches days within a dozen failures, and a day of
    // backoff against a 168-hour window is a day of reviews at risk.
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBeLessThan(7 * 24 * 3_600_000 / 24);

    // A source that has never run is always due; the first run must not be
    // delayed by a backoff computed from no history.
    expect(isDue(null, NOW)).toBe(true);
  });

  it('I7. the staleness measure is a countdown against the window, not a health check', async () => {
    expect(windowConsumed(null, NOW)).toBeNull();          // never synced != data lost
    const half = { last_success_at: NOW - 3.5 * 24 * 3_600_000 } as any;
    expect(windowConsumed(half, NOW)).toBeCloseTo(0.5, 2);
    const gone = { last_success_at: NOW - 8 * 24 * 3_600_000 } as any;
    expect(windowConsumed(gone, NOW)!).toBeGreaterThan(1);  // reviews now unreachable
  });
});
