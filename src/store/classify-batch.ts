/**
 * Running the classifier over reviews that are waiting for one.
 *
 * Claims a small batch, classifies each, records the suggestion, and moves the
 * review to `awaiting_review` — where a human sees it. Nothing here decides
 * anything: `eligibility`, `human_labels` and every other human column are
 * untouched by this file, and cannot be set by a model.
 *
 * A FLAGGED REVIEW IS NEVER SENT TO THE MODEL.
 * The secret scanner runs at sync. If it flagged a review, that review's text
 * may contain a seed phrase or a private key that somebody pasted into a public
 * store listing looking for help. Classifying it would mean transmitting that
 * material to a third-party API to learn something we do not need — the review
 * is going in front of a human either way, and no label is worth the copy. It
 * is moved straight to `awaiting_review` with no AI suggestion and an event
 * saying why.
 *
 * OFF BY DEFAULT. `STORE_CLASSIFY_ENABLED` must be the literal "true", the
 * convention `PUBLISH_ENABLED` and `SPAM_GATE_ENABLED` already follow, so a
 * typo can never arm it. Turning it off is safe: reviews accumulate in
 * `awaiting_review`, and humans can still read, filter and act on them.
 */
import { classifyStoreReview, STORE_PROMPT_VERSION } from './classify';

export interface ClassifyBatchEnv {
  DB: D1Database;
  LLM_API_KEY_PRIMARY: string;
  LLM_API_KEY_FALLBACK: string;
  STORE_CLASSIFY_ENABLED?: string;
  STORE_CLASSIFY_MODEL?: string;
  STORE_CLASSIFY_BATCH?: string;
}

export interface ClassifyBatchReport {
  enabled: boolean;
  claimed: number;
  classified: number;
  skippedFlagged: number;
  failed: number;
}

/**
 * Small on purpose. The free plan allows 50 subrequests per invocation and one
 * classification can spend two (primary key, then fallback). Five leaves room
 * for the rest of the tick; the cost of a small batch is only that the next one
 * runs a minute later.
 */
const DEFAULT_BATCH = 5;

/** Reviews waiting for a suggestion. `new` is where sync leaves them. */
const CLAIMABLE = "review_state = 'new'";

async function logEvent(
  db: D1Database, id: string, at: number, detail: string,
  from: string | null, to: string | null
): Promise<void> {
  await db.prepare(
    `INSERT INTO store_review_events (store_review_id, at, kind, from_state, to_state, detail, actor)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id, at, 'classify', from, to, detail, 'classifier').run();
}

export async function runClassifyBatch(
  env: ClassifyBatchEnv, nowMs: number
): Promise<ClassifyBatchReport> {
  const report: ClassifyBatchReport = {
    enabled: env.STORE_CLASSIFY_ENABLED === 'true',
    claimed: 0, classified: 0, skippedFlagged: 0, failed: 0,
  };
  if (!report.enabled) return report;

  const size = Math.max(1, Math.min(20, Number(env.STORE_CLASSIFY_BATCH ?? DEFAULT_BATCH)));

  const { results } = await env.DB.prepare(
    `SELECT store_review_id, review_title, review_body, rating, secret_scan_status
       FROM store_reviews
      WHERE ${CLAIMABLE}
      ORDER BY review_created_at ASC
      LIMIT ?`
  ).bind(size).all<any>();

  for (const row of results ?? []) {
    const id = row.store_review_id as string;

    /**
     * COMPARE-AND-SWAP, not "select then update".
     *
     * `changes === 0` means another invocation claimed this row between the
     * SELECT above and here — the cron ticking while a previous run is still
     * going, or an operator-triggered run overlapping it. Skipping is correct;
     * classifying it twice would spend money to overwrite a suggestion with
     * another suggestion.
     */
    const claim = await env.DB.prepare(
      `UPDATE store_reviews SET review_state = 'classifying'
        WHERE store_review_id = ? AND review_state = 'new'`
    ).bind(id).run();
    if ((claim.meta?.changes ?? 0) === 0) continue;
    report.claimed += 1;

    // Never transmitted. See the note at the top of this file.
    if (row.secret_scan_status === 'flagged') {
      await env.DB.prepare(
        `UPDATE store_reviews SET review_state = 'awaiting_review' WHERE store_review_id = ?`
      ).bind(id).run();
      await logEvent(env.DB, id, nowMs,
        'not sent to the model: flagged by the secret scanner', 'classifying', 'awaiting_review');
      report.skippedFlagged += 1;
      continue;
    }

    try {
      const result = await classifyStoreReview(
        { title: row.review_title, body: row.review_body, rating: row.rating },
        env
      );

      /**
       * Writes ONLY ai_* columns and the triage state.
       *
       * Not eligibility, not human_labels, not human_decided_*. A model must not
       * be able to move a review towards a public GitHub issue, and the way to
       * guarantee that is for the statement that could do it not to exist.
       */
      await env.DB.prepare(
        `UPDATE store_reviews SET
           ai_labels = ?, ai_confidence = ?, ai_structured = ?,
           ai_model = ?, ai_prompt_version = ?, ai_classified_at = ?,
           review_state = 'awaiting_review'
         WHERE store_review_id = ? AND review_state = 'classifying'`
      ).bind(
        JSON.stringify(result.labels), result.confidence,
        JSON.stringify(result.structured), result.model, result.promptVersion, nowMs,
        id
      ).run();

      await logEvent(env.DB, id, nowMs,
        `labels suggested: ${result.labels.join(', ') || 'none'}`,
        'classifying', 'awaiting_review');
      report.classified += 1;
    } catch (err) {
      /**
       * BACK TO `new`, so it is retried rather than stranded.
       *
       * A classifier outage must not cost a review its place in the queue. The
       * error goes in the event log rather than into sync_error, which belongs
       * to sync — mixing them would make a model outage look like a collection
       * failure, and collection failures are the ones with a 7-day clock.
       */
      await env.DB.prepare(
        `UPDATE store_reviews SET review_state = 'new'
          WHERE store_review_id = ? AND review_state = 'classifying'`
      ).bind(id).run();
      await logEvent(env.DB, id, nowMs,
        `classification failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
        'classifying', 'new');
      report.failed += 1;
    }
  }

  return report;
}

export { STORE_PROMPT_VERSION };
