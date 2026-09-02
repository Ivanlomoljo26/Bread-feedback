/**
 * Phase 4 — AI classification.
 *
 * The model's authority is the whole subject here. A store review is text a
 * stranger wrote in a public listing: the most directly attacker-controlled
 * input this service has, cheaper to post than a form submission. So the tests
 * that matter are about what the model CANNOT do — not what it usually does.
 *
 * Every case runs against a stubbed Anthropic endpoint. That is not a
 * limitation: it is the only way to assert what happens when the model returns
 * something hostile, truncated, or absurd, which a live model will not do on
 * demand and which is exactly when the guards have to hold.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  installFetchStub, restoreFetch, route, seedStoreReview, seedAdmin, adminHeaders,
} from './helpers';
import {
  validateClassification, buildUserMessage, StoreClassifierError,
  classifyStoreReview, DEFAULT_MODEL, STORE_PROMPT_VERSION,
} from '../src/store/classify';
import { runClassifyBatch } from '../src/store/classify-batch';

const NOW = 1_788_300_000_000;

beforeAll(() => installFetchStub());
afterEach(() => { restoreFetch(); installFetchStub(); });
beforeEach(async () => {
  await seedAdmin();
  await env.DB.prepare('DELETE FROM store_review_events').run();
  await env.DB.prepare('DELETE FROM store_reviews').run();
});

/** Captures what was sent, and answers with whatever the test dictates. */
let sent: any[] = [];
function mockModel(body: unknown, opts: { status?: number; stopReason?: string } = {}) {
  sent = [];
  route({
    match: (u, m) => u.host === 'api.anthropic.com' && m === 'POST',
    respond: (raw) => {
      sent.push(JSON.parse(raw ?? '{}'));
      if (opts.status && opts.status !== 200) {
        return new Response('upstream said no', { status: opts.status });
      }
      return Response.json({
        model: 'claude-opus-5',
        stop_reason: opts.stopReason ?? 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'text', text: JSON.stringify(body) }],
      });
    },
  });
}

const GOOD = {
  labels: ['bug', 'functional_issue'],
  confidence: 0.8,
  summary: 'Private sends stop at the proving step.',
  affected_area: 'send',
  reproducible: true,
  version_mentioned: '1.15.19',
  missing_information: null,
};

const classifyEnv = () => ({
  LLM_API_KEY_PRIMARY: 'k1', LLM_API_KEY_FALLBACK: 'k2',
} as any);

describe('what the model is allowed to say', () => {
  it('K1. invented labels are dropped, allowlisted ones kept', async () => {
    // The schema already restricts labels to the allowlist. This is the check
    // that makes it a guarantee rather than a request: a schema is something we
    // ask the model for, and models are not bound by what we ask.
    const v = validateClassification({
      ...GOOD, labels: ['bug', 'ADMIN_OVERRIDE', 'eligible', 'ui_issue', 42],
    }, 'm');
    expect(v.labels).toEqual(['bug', 'ui_issue']);
  });

  it('K2. confidence is clamped, never a reason to fail a review', async () => {
    expect(validateClassification({ ...GOOD, confidence: 99 }, 'm').confidence).toBe(1);
    expect(validateClassification({ ...GOOD, confidence: -3 }, 'm').confidence).toBe(0);
    // Telemetry. A nonsense number must not stop a real review being classified.
    expect(validateClassification({ ...GOOD, confidence: 'high' }, 'm').confidence).toBe(0);
  });

  it('K3. a response that is not an object is refused outright', async () => {
    expect(() => validateClassification(null, 'm')).toThrow(StoreClassifierError);
    expect(() => validateClassification('ok', 'm')).toThrow(StoreClassifierError);
  });

  it('K4. free-text fields are length-bounded', async () => {
    const v = validateClassification({ ...GOOD, summary: 'x'.repeat(5000) }, 'm');
    expect(v.structured.summary.length).toBeLessThanOrEqual(600);
  });

  it('K5. the review is sent as delimited data, and nothing else is sent', async () => {
    const msg = buildUserMessage({ title: 'T', body: 'B', rating: 2 });
    expect(msg).toContain('<review>');
    expect(msg).toContain('</review>');

    mockModel(GOOD);
    await classifyStoreReview({ title: 'T', body: 'B', rating: 2 }, classifyEnv());
    const req = sent[0];
    // No tools. The model has nothing to reach for even if it tried.
    expect(req.tools).toBeUndefined();
    expect(req.model).toBe(DEFAULT_MODEL);
    // Low effort rather than thinking disabled — disabling it on this family
    // can leak reasoning tags or a tool call into visible text.
    expect(req.output_config.effort).toBe('low');
    expect(req.thinking).toBeUndefined();
  });
});

describe('failures are failures, not classifications', () => {
  it('K6. a refusal is not a verdict', async () => {
    mockModel(GOOD, { stopReason: 'refusal' });
    await expect(classifyStoreReview({ body: 'x' }, classifyEnv()))
      .rejects.toThrow(StoreClassifierError);
  });

  it('K7. a truncated response is not a verdict', async () => {
    // Half a classification parsed as a whole one would store a label nobody
    // reached.
    mockModel(GOOD, { stopReason: 'max_tokens' });
    await expect(classifyStoreReview({ body: 'x' }, classifyEnv()))
      .rejects.toThrow(/truncated/);
  });

  it('K8. both keys failing throws rather than returning "no labels"', async () => {
    // An empty label set is a REAL answer meaning "nothing fits". An outage
    // must not be able to produce one.
    mockModel(GOOD, { status: 500 });
    await expect(classifyStoreReview({ body: 'x' }, classifyEnv()))
      .rejects.toThrow(StoreClassifierError);
    expect(sent).toHaveLength(2);   // primary, then fallback
  });
});

describe('the batch runner', () => {
  const batchEnv = (over: Record<string, string> = {}) => ({
    DB: env.DB,
    LLM_API_KEY_PRIMARY: 'k1',
    LLM_API_KEY_FALLBACK: 'k2',
    STORE_CLASSIFY_ENABLED: 'true',
    ...over,
  } as any);

  const rowOf = (id: string) => env.DB
    .prepare('SELECT * FROM store_reviews WHERE store_review_id = ?').bind(id).first<any>();

  it('K9. off unless the literal "true"', async () => {
    await seedStoreReview({ review_state: 'new' });
    mockModel(GOOD);

    for (const value of ['false', 'TRUE', '1', 'yes', '']) {
      const r = await runClassifyBatch(batchEnv({ STORE_CLASSIFY_ENABLED: value }), NOW);
      expect(r.enabled, value).toBe(false);
      expect(r.claimed, value).toBe(0);
    }
    // A typo can never arm it.
    expect(sent).toHaveLength(0);
  });

  it('K10. a classified review carries the suggestion, the model and the prompt version', async () => {
    const id = await seedStoreReview({ review_state: 'new', review_body: 'private send hangs' });
    mockModel(GOOD);

    const report = await runClassifyBatch(batchEnv(), NOW);
    expect(report.classified).toBe(1);

    const row = await rowOf(id);
    expect(JSON.parse(row.ai_labels)).toEqual(['bug', 'functional_issue']);
    expect(row.review_state).toBe('awaiting_review');
    expect(row.ai_prompt_version).toBe(STORE_PROMPT_VERSION);
    expect(row.ai_model).toBeTruthy();
    expect(JSON.parse(row.ai_structured).affected_area).toBe('send');
  });

  it('K11. THE MODEL CANNOT TOUCH A HUMAN DECISION', async () => {
    // The load-bearing test. A model must not be able to move a review towards
    // a public GitHub issue, so nothing it returns may reach eligibility or any
    // human column — including when it returns those very words as labels.
    const id = await seedStoreReview({ review_state: 'new' });
    mockModel({ ...GOOD, labels: ['bug', 'eligible', 'actionable'] });

    await runClassifyBatch(batchEnv(), NOW);

    const row = await rowOf(id);
    expect(row.eligibility).toBe('undecided');
    expect(row.human_labels).toBeNull();
    expect(row.human_decided_at).toBeNull();
    expect(row.human_decided_by).toBeNull();
    expect(row.handoff_state).toBe('none');
    // And the words it tried to use are not labels at all.
    expect(JSON.parse(row.ai_labels)).toEqual(['bug']);
  });

  it('K12. A FLAGGED REVIEW IS NEVER SENT TO THE MODEL', async () => {
    // Its text may hold a seed phrase somebody pasted looking for help.
    // Transmitting that to a third party to learn a label we do not need is
    // the wrong trade — a human sees the review either way.
    const id = await seedStoreReview({ review_state: 'new', secret_scan_status: 'flagged' });
    mockModel(GOOD);

    const report = await runClassifyBatch(batchEnv(), NOW);
    expect(report.skippedFlagged).toBe(1);
    expect(report.classified).toBe(0);
    expect(sent).toHaveLength(0);          // nothing left the Worker

    const row = await rowOf(id);
    expect(row.review_state).toBe('awaiting_review');   // still reaches a human
    expect(row.ai_labels).toBeNull();

    const { results } = await env.DB.prepare(
      'SELECT detail FROM store_review_events WHERE store_review_id = ?').bind(id).all<any>();
    expect(results.map((e: any) => e.detail).join(' ')).toContain('secret scanner');
  });

  it('K13. a failure returns the review to the queue instead of stranding it', async () => {
    const id = await seedStoreReview({ review_state: 'new' });
    mockModel(GOOD, { status: 503 });

    const report = await runClassifyBatch(batchEnv(), NOW);
    expect(report.failed).toBe(1);

    const row = await rowOf(id);
    // Back to `new`, so the next tick retries. A classifier outage must not
    // cost a review its place.
    expect(row.review_state).toBe('new');
    expect(row.ai_classified_at).toBeNull();
    // And it does NOT masquerade as a sync failure — those have a 7-day clock.
    expect(row.sync_error).toBeNull();
  });

  it('K14. only reviews waiting for a suggestion are claimed', async () => {
    await seedStoreReview({ review_state: 'awaiting_review', review_body: 'ALREADY-SEEN' });
    await seedStoreReview({ review_state: 'actionable', review_body: 'DECIDED' });
    const fresh = await seedStoreReview({ review_state: 'new', review_body: 'FRESH' });
    mockModel(GOOD);

    const report = await runClassifyBatch(batchEnv(), NOW);
    expect(report.claimed).toBe(1);
    // Re-classifying a decided review would overwrite a suggestion a human has
    // already worked from.
    expect((await rowOf(fresh)).review_state).toBe('awaiting_review');
  });

  it('K15. the batch size is bounded whatever the var says', async () => {
    for (let i = 0; i < 8; i += 1) await seedStoreReview({ review_state: 'new' });
    mockModel(GOOD);
    // The free plan allows 50 subrequests per invocation; an unbounded batch
    // would fail the whole tick rather than do less work.
    const report = await runClassifyBatch(batchEnv({ STORE_CLASSIFY_BATCH: '999' }), NOW);
    expect(report.claimed).toBeLessThanOrEqual(20);
  });
});

describe('the console shows it as a suggestion', () => {
  it('K16. the detail page labels the AI output, its confidence and its version', async () => {
    const id = await seedStoreReview({
      review_state: 'awaiting_review',
      ai_labels: '["bug"]', ai_confidence: 0.82, ai_model: 'claude-opus-5',
      ai_prompt_version: STORE_PROMPT_VERSION, ai_classified_at: NOW,
      ai_structured: JSON.stringify({ summary: 'Sends hang at proving.', affected_area: 'send' }),
    });
    const { callWorker } = await import('./helpers');
    const html = await (await callWorker(new Request(
      `https://mfv2.test/admin/store/${id}`, { headers: await adminHeaders() }))).text();

    expect(html).toContain('What the AI suggests');
    expect(html).toContain('Sends hang at proving.');
    // Confidence is telemetry and the page has to say so, or a number beside a
    // label reads as a verdict.
    expect(html).toContain('telemetry, not a decision');
    expect(html).toContain(STORE_PROMPT_VERSION);
  });

  it('K17. an unclassified flagged review explains why it has no suggestion', async () => {
    const id = await seedStoreReview({
      review_state: 'awaiting_review', secret_scan_status: 'flagged',
    });
    const { callWorker } = await import('./helpers');
    const html = await (await callWorker(new Request(
      `https://mfv2.test/admin/store/${id}`, { headers: await adminHeaders() }))).text();
    expect(html).toContain('never sent to the model');
  });
});
