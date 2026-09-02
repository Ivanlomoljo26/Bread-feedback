/**
 * The ONE place that decides whether a store review is new, edited, or already
 * known. Every producer goes through here.
 *
 * The Google Play API, the App Store Connect API and a future Play Console CSV
 * importer all hand this function a `NormalizedReview` and get back one of
 * three outcomes. None of them contains a line of deduplication logic of its
 * own, and that is the entire point: three implementations of "is this a
 * duplicate" would be three chances to disagree, and the disagreement would
 * appear as the same review stored twice.
 *
 * IDEMPOTENT BY CONSTRUCTION. Re-syncing a window that has already been synced
 * writes nothing but a `last_synced_at` bump. That property is what makes the
 * whole retry story cheap: a lost cursor, a crashed run, a re-import of an
 * overlapping CSV range — all of them cost time, not correctness. Nothing
 * downstream has to reason about whether it has seen a review before.
 *
 * A HUMAN'S DECISION IS NEVER OVERWRITTEN BY AN EDIT.
 * When a review's text changes upstream, this refreshes the derived columns and
 * writes a version row. It does NOT touch `eligibility`, `human_labels`,
 * `human_decision`, `human_decided_at/_by`, or `review_state`. A review's
 * author must not be able to move it through our pipeline by editing what they
 * wrote — including moving it backwards, which would silently discard a
 * judgement someone made. The edit is recorded as an event instead, so the
 * console can show "edited after your decision" and let a person choose.
 */
import { scanForSecrets } from '../lib/secret-scan';
import { assertUpsertable, type NormalizedReview } from './normalize';

export type UpsertOutcome = 'created' | 'updated' | 'unchanged';

export interface UpsertResult {
  outcome: UpsertOutcome;
  storeReviewId: string;
  /** True when the secret scanner flagged this review's text. */
  flagged: boolean;
}

interface ExistingRow {
  store_review_id: string;
  raw_hash: string;
  review_state: string;
  human_decided_at: number | null;
}

/**
 * Scans the review's text and returns what to store.
 *
 * Runs at INGEST, not at render, for two reasons. The console must be able to
 * redact without re-scanning on every page view; and a review that contains a
 * seed phrase must be marked the moment it enters the system, not the first
 * time somebody happens to look at it.
 *
 * Reasons are hit KINDS only — never the matched value. The same rule
 * `spam_reasons` follows: copying the secret into a column in order to record
 * that we found a secret would defeat the point of finding it.
 */
function scan(r: NormalizedReview): { status: 'clean' | 'flagged'; reasons: string } {
  const text = [r.reviewTitle, r.reviewBody].filter(Boolean).join('\n');
  const hits = text ? scanForSecrets(text) : [];
  return {
    status: hits.length > 0 ? 'flagged' : 'clean',
    reasons: JSON.stringify(hits.map((h) => h.kind)),
  };
}

/** Append-only. Never UPDATEd — the discipline `state_log` follows. */
async function logEvent(
  db: D1Database, storeReviewId: string, at: number,
  kind: string, detail: string, fromState?: string | null, toState?: string | null
): Promise<void> {
  await db.prepare(
    `INSERT INTO store_review_events
       (store_review_id, at, kind, from_state, to_state, detail, actor)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(storeReviewId, at, kind, fromState ?? null, toState ?? null, detail, 'sync').run();
}

/**
 * Writes one normalised review. Safe to call repeatedly with the same input.
 *
 * `newId` is injected so tests are deterministic; production passes
 * `crypto.randomUUID`.
 */
export async function upsertReview(
  db: D1Database,
  record: NormalizedReview,
  nowMs: number,
  newId: () => string = () => crypto.randomUUID()
): Promise<UpsertResult> {
  // Guards every producer, not just the one that remembered to ask.
  assertUpsertable(record);

  const existing = await db.prepare(
    `SELECT store_review_id, raw_hash, review_state, human_decided_at
       FROM store_reviews
      WHERE source = ? AND app_id = ? AND platform_review_id = ?`
  ).bind(record.source, record.appId, record.platformReviewId).first<ExistingRow>();

  const sec = scan(record);

  // ---- already known, and unchanged -------------------------------------
  if (existing && existing.raw_hash === record.rawHash) {
    // Only the sync clock moves. No version row, no event: a run that sees a
    // thousand unchanged reviews must not write a thousand rows saying so.
    await db.prepare(
      'UPDATE store_reviews SET last_synced_at = ?, sync_error = NULL WHERE store_review_id = ?'
    ).bind(nowMs, existing.store_review_id).run();
    return { outcome: 'unchanged', storeReviewId: existing.store_review_id, flagged: sec.status === 'flagged' };
  }

  // ---- already known, and edited upstream --------------------------------
  if (existing) {
    await db.prepare(
      `UPDATE store_reviews SET
         raw_json = ?, raw_hash = ?, last_synced_at = ?,
         review_title = ?, review_body = ?, rating = ?, reviewer_name = ?,
         territory = ?, language = ?, review_updated_at = ?,
         app_version = ?, app_version_code = ?, device = ?, device_product = ?, os_version = ?,
         secret_scan_status = ?, secret_scan_reasons = ?, secret_scanned_at = ?,
         sync_error = NULL
       WHERE store_review_id = ?`
    ).bind(
      JSON.stringify(record.raw), record.rawHash, nowMs,
      record.reviewTitle, record.reviewBody, record.rating, record.reviewerName,
      record.territory, record.language, record.reviewUpdatedAt,
      record.appVersion, record.appVersionCode, record.device, record.deviceProduct, record.osVersion,
      sec.status, sec.reasons, nowMs,
      existing.store_review_id
    ).run();

    // review_created_at is NOT refreshed. It anchors the queue's ordering, and
    // an edit is not a new review arriving — letting it move would reshuffle a
    // reviewer's list under them for a one-word correction.

    await recordVersion(db, existing.store_review_id, record, nowMs);

    // Said plainly in the audit trail, because it is the case a human needs to
    // notice: the text they judged is not the text that is there now.
    const afterDecision = existing.human_decided_at != null;
    await logEvent(
      db, existing.store_review_id, nowMs, 'sync',
      afterDecision
        ? 'edited upstream AFTER a human decision; decision left untouched'
        : 'edited upstream',
      existing.review_state, existing.review_state
    );

    return { outcome: 'updated', storeReviewId: existing.store_review_id, flagged: sec.status === 'flagged' };
  }

  // ---- new ---------------------------------------------------------------
  const id = newId();
  // A review that already carries a developer reply is recorded as replied, so
  // the console never offers to answer something that has been answered. The
  // reply's own history is Phase 6's table to own; this only prevents a second
  // reply appearing under the first.
  const replyState = record.existingReplyText ? 'published' : 'none';

  await db.prepare(
    `INSERT INTO store_reviews
       (store_review_id, platform, source, app_id, platform_review_id,
        raw_json, raw_hash, first_seen_at, last_synced_at,
        review_title, review_body, rating, reviewer_name, territory, language,
        review_created_at, review_updated_at,
        app_version, app_version_code, device, device_product, os_version,
        review_state, reply_state, handoff_state, eligibility,
        secret_scan_status, secret_scan_reasons, secret_scanned_at)
     VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?)
     ON CONFLICT(source, app_id, platform_review_id) DO NOTHING`
  ).bind(
    id, record.platform, record.source, record.appId, record.platformReviewId,
    JSON.stringify(record.raw), record.rawHash, nowMs, nowMs,
    record.reviewTitle, record.reviewBody, record.rating, record.reviewerName,
    record.territory, record.language,
    record.reviewCreatedAt, record.reviewUpdatedAt,
    record.appVersion, record.appVersionCode, record.device, record.deviceProduct, record.osVersion,
    'new', replyState, 'none', 'undecided',
    sec.status, sec.reasons, nowMs
  ).run();

  /**
   * ON CONFLICT DO NOTHING, then read back.
   *
   * Two sync runs overlapping — a retry landing on top of a slow run, or the
   * rotor firing twice — must produce ONE row, not a unique-constraint error
   * that fails an otherwise good batch. The conflict target is exactly the
   * index the whole design rests on, so the loser of the race reads the
   * winner's row and reports `unchanged` rather than duplicating it.
   */
  const stored = await db.prepare(
    `SELECT store_review_id, raw_hash, review_state, human_decided_at
       FROM store_reviews
      WHERE source = ? AND app_id = ? AND platform_review_id = ?`
  ).bind(record.source, record.appId, record.platformReviewId).first<ExistingRow>();

  if (!stored) throw new Error('upsert: row vanished immediately after insert');
  if (stored.store_review_id !== id) {
    // Someone else inserted it between our SELECT and our INSERT.
    return { outcome: 'unchanged', storeReviewId: stored.store_review_id, flagged: sec.status === 'flagged' };
  }

  await recordVersion(db, id, record, nowMs);
  await logEvent(db, id, nowMs, 'sync', `first seen from ${record.source}`, null, 'new');
  return { outcome: 'created', storeReviewId: id, flagged: sec.status === 'flagged' };
}

/**
 * One row per distinct payload ever seen.
 *
 * UNIQUE(store_review_id, raw_hash) does the work: an unchanged re-sync writes
 * nothing, and an edit writes exactly one row. The FIRST row is the original as
 * received and is never updated or deleted — a reviewer must always be able to
 * read what was actually said, not only the latest revision of it.
 */
async function recordVersion(
  db: D1Database, storeReviewId: string, record: NormalizedReview, nowMs: number
): Promise<void> {
  await db.prepare(
    `INSERT INTO store_review_versions (store_review_id, raw_hash, raw_json, rating, observed_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(store_review_id, raw_hash) DO NOTHING`
  ).bind(storeReviewId, record.rawHash, JSON.stringify(record.raw), record.rating, nowMs).run();
}
