/**
 * A person's own summary of a store review.
 *
 * The AI's summary is recorded exactly as the model returned it (ai_structured),
 * so a correction never overwrites it: it is written to human_summary beside it,
 * shown instead of it, and the AI's stays on record (migration 0010).
 *
 * Same credential and conflict discipline as a decision: the signed-in session
 * plus a CSRF token (checked by the route), and a compare-and-swap on the edit
 * the person saw, so two people editing at once never silently overwrite each
 * other. Saving an empty summary clears the edit and shows the AI's again.
 */
import type { ActionResult } from './reply-flow';

export const SUMMARY_MAX_CHARS = 500;

export const SUMMARY_MSG = {
  notFound: 'That review is not in the console.',
  tooLong: `Keep the summary to ${SUMMARY_MAX_CHARS} characters.`,
  conflict: 'This summary changed since the page loaded. Reload to see the latest.',
} as const;

export interface SummaryInput {
  reviewId: string;
  user: string;
  /** The `human_summary_at` the page showed, '' when there was none. */
  seenEditedAt: string;
  summary: unknown;
  nowMs: number;
}

export function aiSummaryOf(aiStructured: string | null): string {
  try {
    const st = JSON.parse(aiStructured ?? '{}');
    return typeof st?.summary === 'string' ? st.summary.trim() : '';
  } catch {
    return '';
  }
}

export async function runSummary(db: D1Database, a: SummaryInput): Promise<ActionResult> {
  const row = await db.prepare(
    'SELECT human_summary, human_summary_at, ai_structured FROM store_reviews WHERE store_review_id = ?'
  ).bind(a.reviewId).first<{ human_summary: string | null; human_summary_at: number | null; ai_structured: string | null }>();
  if (!row) return { ok: false, status: 404, message: SUMMARY_MSG.notFound };

  const seen = a.seenEditedAt === '' ? null : Number(a.seenEditedAt);
  if ((row.human_summary_at ?? null) !== seen) return { ok: false, status: 409, message: SUMMARY_MSG.conflict };

  const text = String(a.summary ?? '').replace(/\r\n/g, '\n').trim();
  if ([...text].length > SUMMARY_MAX_CHARS) return { ok: false, status: 400, message: SUMMARY_MSG.tooLong };

  const cleared = text === '';
  // Saving what is already shown changes nothing and records nothing: an empty box
  // with no edit, or the AI's own words back again with no edit.
  if (row.human_summary == null && (cleared || text === aiSummaryOf(row.ai_structured))) return { ok: true };
  if (row.human_summary != null && text === row.human_summary) return { ok: true };
  const res = await db.prepare(
    `UPDATE store_reviews SET human_summary = ?, human_summary_by = ?, human_summary_at = ?
      WHERE store_review_id = ? AND human_summary_at IS ?`
  ).bind(cleared ? null : text, cleared ? null : a.user, cleared ? null : a.nowMs, a.reviewId, seen).run();
  if ((res.meta?.changes ?? 0) === 0) return { ok: false, status: 409, message: SUMMARY_MSG.conflict };

  await db.prepare(
    `INSERT INTO store_review_events (store_review_id, at, kind, from_state, to_state, detail, actor)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(a.reviewId, a.nowMs, 'summary', null, null,
    cleared ? "Summary edit removed, showing the AI's summary" : 'Summary edited', a.user).run();
  return { ok: true };
}
