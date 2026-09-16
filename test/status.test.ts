/**
 * Plan §10 test 16 — the /status contract the form reads.
 *
 * This is a PRESENTATION contract, not the internal state machine, and the
 * spam layer must not change it: quarantined already reports as `received` on
 * purpose, and as of Phase 1 `suspected_spam` and `spam` are pinned there too.
 */
import { env } from 'cloudflare:test';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import {
  callWorker, installFetchStub, restoreFetch, seedSubmission, seedMirrorIssue,
} from './helpers';
import schemaSql from '../schema.sql?raw';

beforeAll(() => installFetchStub());
afterEach(() => { restoreFetch(); installFetchStub(); });

async function status(ids: string[]) {
  const res = await callWorker(
    new Request(`https://mfv2.test/status?ids=${ids.join(',')}`, { method: 'GET' })
  );
  expect(res.status).toBe(200);
  return res.json<any>();
}

describe('/status', () => {
  it('16a. reports `filed` with the mirror title for a published report', async () => {
    await seedMirrorIssue({ number: 4100, title: 'Mirror title wins', state: 'open' });
    const id = await seedSubmission();
    await env.DB.prepare(
      "UPDATE submissions SET state='published', published_issue=4100, published_title='Stored title' WHERE submission_id=?"
    ).bind(id).run();

    const { results, repo } = await status([id]);

    expect(results[id]).toMatchObject({ status: 'filed', issue: 4100, duplicate: false });
    // Mirror first: a maintainer renaming the issue reaches the reporter.
    expect(results[id].title).toBe('Mirror title wins');
    // The repo travels with the results so the form never hardcodes it.
    expect(repo).toBe(env.TARGET_REPO);
  });

  it('16b. reports `attached` for a folded report, sourced from dup_links', async () => {
    await seedMirrorIssue({ number: 4101, title: 'Folded into this', state: 'open' });
    const id = await seedSubmission();
    await env.DB.prepare(
      "UPDATE submissions SET state='published' WHERE submission_id=?"
    ).bind(id).run();
    await env.DB.prepare(
      'INSERT INTO dup_links (submission_id, issue_number, confidence, linked_at) VALUES (?,?,?,?)'
    ).bind(id, 4101, 0.93, Date.now()).run();

    const { results } = await status([id]);

    expect(results[id]).toMatchObject({
      status: 'attached', issue: 4101, duplicate: true, title: 'Folded into this',
    });
  });

  it('16c. collapses `capped` and `deferred` to `queued` without leaking which limiter closed', async () => {
    const capped = await seedSubmission({ state: 'capped' });
    const deferred = await seedSubmission({ state: 'deferred' });

    const { results } = await status([capped, deferred]);

    expect(results[capped]).toMatchObject({ status: 'queued', issue: null, duplicate: false });
    expect(results[deferred]).toMatchObject({ status: 'queued', issue: null });
  });

  it('16d. reports in-flight work as `reviewing`', async () => {
    const claimed = await seedSubmission({ state: 'claimed' });
    const publishing = await seedSubmission({ state: 'publishing' });

    const { results } = await status([claimed, publishing]);

    expect(results[claimed].status).toBe('reviewing');
    expect(results[publishing].status).toBe('reviewing');
  });

  it('16e. reports quarantined, failed and both spam states neutrally as `received`', async () => {
    const quarantined = await seedSubmission({ state: 'quarantined' });
    const failed = await seedSubmission({ state: 'failed' });
    const suspected = await seedSubmission({ state: 'suspected_spam' });
    const spam = await seedSubmission({ state: 'spam' });

    const { results } = await status([quarantined, failed, suspected, spam]);

    // Deliberately lossy. Quarantine answers 202 by design so a false positive
    // tells an attacker nothing, and a parked row is an operator's problem the
    // reporter cannot act on. The spam layer inherits this mapping.
    expect(results[quarantined].status).toBe('received');
    expect(results[failed].status).toBe('received');

    // Telling a reporter they were flagged tells a spammer their probe worked,
    // and tells a false-positive victim something they cannot act on. Neutral
    // is the only answer that is safe in both directions. Phase 1 turns this
    // from a comment in publicStatus() into a fact the suite enforces.
    expect(results[suspected].status).toBe('received');
    expect(results[spam].status).toBe('received');
  });

  it('16e2. leaks the internal state in NO field of the response, not just `status`', async () => {
    // The assertion 16e was missing. It checked the field it was thinking
    // about; the response also carried a raw `state` beside it, which answered
    // exactly the question `status` was carefully built to answer neutrally.
    //
    // /status needs no credential and a reporter picks their own
    // submission_id, so that field was a per-submission classifier oracle:
    // submit a probe, read back `suspected_spam`, adjust, repeat. Asserting on
    // the WHOLE serialised response is what makes the neutrality real rather
    // than true of one property.
    const ids = await Promise.all([
      seedSubmission({ state: 'suspected_spam', spam_status: 'suspected' }),
      seedSubmission({ state: 'spam', spam_status: 'spam' }),
      seedSubmission({ state: 'quarantined' }),
      seedSubmission({ state: 'capped' }),
      seedSubmission({ state: 'failed' }),
    ]);

    const body = await status(ids);
    // `title` is excluded from the substring sweep and only from that: it is
    // maintainer-controlled text copied from issue_mirror, so a real issue
    // called "marks legit tx as spam" would fail this for no security reason.
    // Every other field is swept.
    const serialised = JSON.stringify(
      Object.fromEntries(Object.entries(body.results).map(
        ([k, v]: [string, any]) => [k, { ...v, title: undefined }]
      ))
    );

    for (const word of ['suspected_spam', 'spam', 'quarantined', 'capped', 'deferred', 'claimed']) {
      expect(serialised, `internal vocabulary leaked: ${word}`).not.toContain(word);
    }
    // And no field named `state` at all, however it might be populated later.
    for (const id of ids) expect(body.results[id]).not.toHaveProperty('state');
    // Only the presentation vocabulary.
    const allowed = new Set(['received', 'reviewing', 'queued', 'attached', 'filed']);
    for (const id of ids) expect(allowed.has(body.results[id].status)).toBe(true);
  });

  it('16f. maps an unrecognised internal state to `received` rather than leaking it', async () => {
    // publicStatus() has no case for the spam states — they reach `received` by
    // falling through to the default. That is what makes every state added
    // LATER neutral by default, so a new internal state cannot leak to the
    // public API because someone forgot to add it here. This test guards the
    // fall-through itself, not any particular state name.
    const future = await seedSubmission({ state: 'some_state_added_later' });

    const { results } = await status([future]);

    expect(results[future].status).toBe('received');
  });

  it('16g. ignores ids that are not UUIDv4 and returns an empty result set', async () => {
    const { results, repo } = await status(['not-a-uuid', '../../etc/passwd']);
    expect(results).toEqual({});
    expect(repo).toBe(env.TARGET_REPO);
  });
});

/**
 * Deployment traceability. Cloudflare recorded `Source: Unknown` for every
 * deployment this Worker had, so "is master what is running?" was answerable
 * only by comparing commit dates against deployment timestamps — inference,
 * not a fact. scripts/deploy.sh injects COMMIT_SHA; this is the half that can
 * be checked from outside, against the thing actually serving traffic.
 */
describe('/health — which commit is running', () => {
  it('16f. reports the injected commit, and says `dev` when there is none', async () => {
    const health = await (await callWorker(new Request('https://mfv2.test/health'))).json<any>();
    // Nothing injects it under vitest, so it must say so rather than invent one.
    expect(health.commit).toBe('dev');

    const prev = (env as any).COMMIT_SHA;
    (env as any).COMMIT_SHA = 'f64169b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7';
    try {
      const tagged = await (await callWorker(new Request('https://mfv2.test/health'))).json<any>();
      expect(tagged.commit).toBe('f64169b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7');
      // The census stays gone. Adding a field to /health must not reopen the
      // classifier-tuning oracle that test 45e closed.
      const asText = JSON.stringify(tagged);
      expect(asText).not.toContain('suspected_spam');
      expect(tagged.pipeline).toBeUndefined();
    } finally {
      (env as any).COMMIT_SHA = prev;
    }
  });
});


/**
 * A sync that has stopped collecting is invisible from outside until somebody
 * opens the console and notices the queue has not grown — and it is the one
 * failure with a deadline, because the reviews it is not collecting age out of
 * the API in 7 days and never come back.
 */
describe('/health — whether the stores are still being collected', () => {
  const PKG = 'com.miden.wallet';
  const hours = (n: number) => n * 3_600_000;

  const health = async () => (await callWorker(new Request('https://mfv2.test/health'))).json<any>();

  const seedSync = (key: string, row: Record<string, unknown>) => env.DB.prepare(
    `INSERT INTO store_sync_state
       (key, cursor, last_success_at, last_attempt_at, consecutive_failures, last_error,
        defer_until, paused_at, paused_reason, updated_at)
     VALUES (?1,NULL,?2,?3,?4,?5,?6,?7,?8,?3)
     ON CONFLICT(key) DO UPDATE SET
       last_success_at=?2, last_attempt_at=?3, consecutive_failures=?4,
       last_error=?5, defer_until=?6, paused_at=?7, paused_reason=?8, updated_at=?3`
  ).bind(
    key, row.last_success_at ?? null, row.last_attempt_at ?? Date.now(), row.consecutive_failures ?? 0,
    row.last_error ?? null, row.defer_until ?? null, row.paused_at ?? null, row.paused_reason ?? null
  ).run();

  afterEach(() => env.DB.prepare('DELETE FROM store_sync_state').run());

  it('16g. names both stores even when neither has ever run, and says which switches are on', async () => {
    const { stores } = await health();

    // A source with no row at all is the state worth reporting most plainly.
    // Leaving it out would read as healthy.
    expect(Object.keys(stores).sort()).toEqual(['app_store', 'google_play']);
    expect(stores.google_play).toEqual({
      enabled: false, state: 'never', lastSuccessHours: null, consecutiveFailures: 0, windowConsumed: null,
    });
    // Never synced is not the same as having lost anything.
    expect(stores.app_store.windowConsumed).toBeNull();

    const saved = [(env as any).STORE_SYNC_ENABLED, (env as any).APP_STORE_SYNC_ENABLED];
    try {
      (env as any).STORE_SYNC_ENABLED = 'true';
      (env as any).APP_STORE_SYNC_ENABLED = 'false';
      const on = (await health()).stores;
      // Read exactly as the sync path reads them: the App Store needs both.
      expect(on.google_play.enabled).toBe(true);
      expect(on.app_store.enabled).toBe(false);
    } finally {
      [(env as any).STORE_SYNC_ENABLED, (env as any).APP_STORE_SYNC_ENABLED] = saved;
    }
  });

  it('16h. a stopped sync is visible from outside, and the window countdown is the number to alarm on', async () => {
    const now = Date.now();
    await seedSync(`google_play:${PKG}`, {
      last_success_at: now - hours(84),        // half the 7-day window burned
      consecutive_failures: 6,
      last_error: 'reviews.list failed (HTTP 401, PERMISSION_DENIED)',
      paused_at: now - hours(1),
      paused_reason: 'reviews.list failed (HTTP 401, PERMISSION_DENIED)',
    });
    await seedSync('app_store:com.miden.bread', {
      last_success_at: now - hours(2),
      defer_until: now + hours(1),
    });

    const { stores } = await health();

    // The hold is what explains why nothing is happening, so it is what `state`
    // reports — a credential refused, and a wait the store asked for.
    expect(stores.google_play).toMatchObject({ state: 'paused', consecutiveFailures: 6 });
    expect(stores.google_play.lastSuccessHours).toBeCloseTo(84, 1);
    // THIS is the alarm: 1 means reviews have begun ageing out for good.
    expect(stores.google_play.windowConsumed).toBeCloseTo(0.5, 2);
    expect(stores.app_store).toMatchObject({ state: 'deferred', consecutiveFailures: 0 });
    // THE COUNTDOWN IS GOOGLE'S ALONE. App Store Connect serves a review's whole
    // history, so an Apple sync that has been down for hours has lost nothing;
    // a fraction here would assert a deadline that does not exist and page
    // somebody for it. It stays null however long that sync has been stopped.
    expect(stores.app_store.windowConsumed).toBeNull();
    expect(stores.app_store.lastSuccessHours).toBeCloseTo(2, 1);

    /**
     * /health is untokened, so what it may carry is as much the point as what
     * it says. The reason a sync is paused is built from an upstream response
     * and belongs where somebody has signed in; the configured app id is not
     * this route's to publish either.
     */
    const asText = JSON.stringify(stores);
    expect(asText).not.toContain('PERMISSION_DENIED');
    expect(asText).not.toContain('HTTP 401');
    expect(asText).not.toContain(PKG);
    expect(asText).not.toContain('com.miden.bread');
  });

  it('16j. a sync that is switched on and has never succeeded never reads as healthy', async () => {
    /**
     * THE CASE THAT WOULD OTHERWISE LOOK CALM. A sync nobody has ever got
     * working has no failures to report once its backoff lapses, no hold, and
     * an empty queue — the same shape as a healthy sync on a quiet week. The
     * two must not be confusable, because one of them is collecting nothing.
     */
    const saved = (env as any).STORE_SYNC_ENABLED;
    try {
      (env as any).STORE_SYNC_ENABLED = 'true';

      // Switched on, attempted, and no success ever recorded.
      await seedSync(`google_play:${PKG}`, { last_success_at: null, last_attempt_at: Date.now() });
      const never = (await health()).stores.google_play;
      expect(never).toMatchObject({ enabled: true, state: 'never' });
      expect(never.lastSuccessHours).toBeNull();
      // Not a claim that anything was lost: nothing was ever collected.
      expect(never.windowConsumed).toBeNull();

      // A healthy one differs on every field that matters.
      await seedSync(`google_play:${PKG}`, { last_success_at: Date.now() - 600_000 });
      const ok = (await health()).stores.google_play;
      expect(ok.state).toBe('ok');
      expect(ok.lastSuccessHours).toBeCloseTo(0.17, 1);
      expect(ok.windowConsumed).toBeCloseTo(0.001, 3);
    } finally {
      (env as any).STORE_SYNC_ENABLED = saved;
    }
  });

  it('16i. an unmigrated database makes the store status say so, not the endpoint fail', async () => {
    // /health is what an uptime monitor calls. A Worker deployed ahead of its
    // migration must still answer it, and must not claim the syncs are fine.
    //
    // THE TABLE IS PUT BACK FROM schema.sql, never from DDL written out here.
    // A hand-rolled copy in a test is the drift S6 exists to catch: it passes
    // the day it is written and quietly describes a different table after the
    // next migration.
    const restore = schemaSql
      .split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
      .split(';').map((stmt) => stmt.trim())
      .filter((stmt) => stmt && stmt.includes('store_sync_state'));
    expect(restore.length).toBeGreaterThan(0);

    await env.DB.prepare('DROP TABLE IF EXISTS store_sync_state').run();
    try {
      const res = await callWorker(new Request('https://mfv2.test/health'));
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.ok).toBe(true);
      expect(body.stores.google_play.state).toBe('unavailable');
      expect(body.stores.app_store.state).toBe('unavailable');
    } finally {
      for (const stmt of restore) await env.DB.prepare(stmt).run();
    }

    // Put back as schema.sql declares it, so nothing after this test inherits
    // a different table.
    const cols = await env.DB.prepare('PRAGMA table_info(store_sync_state)').all<{ name: string }>();
    expect(cols.results.map((c) => c.name).sort()).toEqual([
      'consecutive_failures', 'cursor', 'defer_until', 'key', 'last_attempt_at',
      'last_error', 'last_success_at', 'paused_at', 'paused_reason', 'updated_at',
    ]);
  });
});
