/**
 * Plan §10 test 16 — the /status contract the form reads.
 *
 * This is a PRESENTATION contract, not the internal state machine, and the
 * spam layer must not change it: quarantined already reports as `received` on
 * purpose, and `suspected_spam` / `spam` will join it there.
 */
import { env } from 'cloudflare:test';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import {
  callWorker, installFetchStub, restoreFetch, seedSubmission, seedMirrorIssue,
} from './helpers';

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

  it('16e. reports quarantined and failed neutrally as `received`', async () => {
    const quarantined = await seedSubmission({ state: 'quarantined' });
    const failed = await seedSubmission({ state: 'failed' });

    const { results } = await status([quarantined, failed]);

    // Deliberately lossy. Quarantine answers 202 by design so a false positive
    // tells an attacker nothing, and a parked row is an operator's problem the
    // reporter cannot act on. The spam layer inherits this mapping.
    expect(results[quarantined].status).toBe('received');
    expect(results[failed].status).toBe('received');
  });

  it('16f. ignores ids that are not UUIDv4 and returns an empty result set', async () => {
    const { results, repo } = await status(['not-a-uuid', '../../etc/passwd']);
    expect(results).toEqual({});
    expect(repo).toBe(env.TARGET_REPO);
  });
});
