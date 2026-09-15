/**
 * The reply, as the console shows it: the panel on one review, and the preview
 * under a review in the list.
 *
 * RENDERING ONLY. Nothing here writes, and the forms it draws post to routes
 * that do not exist until the reply actions land behind their own checks. The
 * shape is fixed by the schema rather than invented here:
 *
 *   - `store_reviews.current_reply_id` is the reply being worked on or shown;
 *     every other row for the review is history.
 *   - An approved reply is never edited in place. Changing it starts a new
 *     draft and the approved row is superseded, so what was approved and what
 *     was published are always the same text. The panel therefore offers
 *     "change", never an editable field, once a reply is approved.
 *   - A flagged review stays replyable (SAFETY-CONTROLS §10). Its text is
 *     redacted; its reply panel is not.
 *
 * A reply that is already on the store but was not written here — Google
 * returns it on the review as `developerComment` — is shown as published, so
 * nobody writes a second answer under the first.
 */
import { esc } from '../lib/admin-chrome';
import { REPLY_STATE_LABEL } from './states';
import { fromGooglePlay } from './normalize';

/** Google Play's limit, applied to both stores at save. */
export const REPLY_MAX_CHARS = 350;

export interface ReplyRow {
  reply_id: string;
  store_review_id: string;
  body: string;
  source: string;
  state: string;
  created_at: number;
  created_by: string | null;
  approved_at: number | null;
  approved_by: string | null;
  published_at: number | null;
  external_state: string | null;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
}

/** A reply already on the store that did not come from the console. */
export interface StoreReply { text: string; at: number | null }

const when = (ms: number | null) =>
  ms ? `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC` : 'unknown date';

/** Characters as a person counts them, not UTF-16 units. */
export const replyLength = (text: string) => Array.from(text).length;

const storeName = (source: string) => (source === 'app_store' ? 'the App Store' : 'Google Play');

/**
 * The reply Google already holds for a review, read from the stored original.
 *
 * Parsed by the same function sync uses, so the console and the sync can never
 * disagree about whether a review has been answered. The App Store returns its
 * response as a separate resource, so iOS has none here.
 */
export function storeReplyOf(review: { source: string; app_id: string; raw_json?: string | null }): StoreReply | null {
  if (review.source !== 'google_play' || !review.raw_json) return null;
  try {
    const rec = fromGooglePlay(JSON.parse(review.raw_json), review.app_id, 0);
    return rec.existingReplyText ? { text: rec.existingReplyText, at: rec.existingReplyAt } : null;
  } catch {
    return null;
  }
}

const CHIP: Record<string, string> = {
  draft: 'b-queued', approved: 'b-actionable', publishing: 'b-deferred', pending_publish: 'b-deferred',
  published: 'b-published', failed: 'b-spam', superseded: 'b-queued',
};
/** Reply-row states onto the labels the list's badges already use. */
const LABEL: Record<string, string> = {
  draft: REPLY_STATE_LABEL.drafted, approved: REPLY_STATE_LABEL.approved,
  publishing: REPLY_STATE_LABEL.publishing, pending_publish: REPLY_STATE_LABEL.pending_publish,
  published: REPLY_STATE_LABEL.published, failed: REPLY_STATE_LABEL.failed, superseded: 'Replaced',
};

const chip = (state: string) =>
  `<span class="badge ${CHIP[state] ?? 'b-queued'}">${esc(LABEL[state] ?? state)}</span>`;

/**
 * "Developer reply" is what both stores call a reply people can read. Anything
 * not yet on the store is labelled as what it is instead, so an unsent draft
 * never looks public.
 */
const PREVIEW_LABEL: Record<string, string> = {
  published: 'Developer reply', draft: 'Draft reply', approved: 'Approved reply, not sent',
  publishing: 'Sending reply', pending_publish: REPLY_STATE_LABEL.pending_publish,
  failed: 'Reply not sent', superseded: 'Reply',
};

const bubble = (text: string, state: string) =>
  `<div class="reply-bubble"><span class="reply-from">${esc(state === 'published' ? 'Developer reply' : 'Reply')}</span><p>${esc(text)}</p></div>`;

const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

function action(base: string, path: string, csrf: string, label: string, cls = ''): string {
  return `<form class="inline" method="POST" action="${esc(`${base}/${path}`)}">${hidden(csrf)}
    <button type="submit"${cls ? ` class="${cls}"` : ''}>${esc(label)}</button></form>`;
}

function composer(base: string, csrf: string, text = '', buttons: string): string {
  return `<form class="reply-form" method="POST" action="${esc(`${base}/draft`)}">${hidden(csrf)}
    <label class="fl"><span>Your reply</span>
      <textarea name="body" rows="4" maxlength="${REPLY_MAX_CHARS}" required>${esc(text)}</textarea></label>
    <p class="reply-hint">Up to ${REPLY_MAX_CHARS} characters.</p>
    <div class="actions">${buttons}</div>
  </form>`;
}

export interface PanelInput {
  review: { store_review_id: string; source: string };
  current: ReplyRow | null;
  history: ReplyRow[];
  storeReply: StoreReply | null;
  csrf: string;
  sendingEnabled: boolean;
}

export function replyPanel(p: PanelInput): string {
  const store = storeName(p.review.source);
  const base = `/admin/store/${encodeURIComponent(p.review.store_review_id)}/reply`;
  const c = p.current;

  const intro = `<p class="reply-intro">Replies are public and appear under the review on ${esc(store)}.</p>`;
  const off = p.sendingEnabled ? '' : `<p class="reply-off">Sending is switched off. Replies can be written
    and approved here, but nothing is sent to ${esc(store)} yet.</p>`;

  let main: string;
  if (!c && !p.storeReply) {
    main = `<div class="reply-card">${composer(base, p.csrf, '',
      '<button type="submit" class="btn-ok">Save draft</button>')}</div>`;
  } else if (!c && p.storeReply) {
    main = `<div class="reply-card">
      <div class="reply-head">${chip('published')}
        <span class="reply-meta">On ${esc(store)} · ${esc(when(p.storeReply.at))}</span>
        <span class="tag">written outside the console</span></div>
      ${bubble(p.storeReply.text, 'published')}
      <div class="actions">${action(base, 'edit', p.csrf, 'Edit reply')}</div>
      <p class="note">Editing starts a new draft. The published reply stays up until the replacement is published.</p>
    </div>`;
  } else if (c!.state === 'draft') {
    main = `<div class="reply-card">
      <div class="reply-head">${chip('draft')}
        <span class="reply-meta">Saved by ${esc(c!.created_by ?? 'unknown')} · ${esc(when(c!.created_at))}</span>
        <span class="reply-count">${replyLength(c!.body)} / ${REPLY_MAX_CHARS} characters</span></div>
      ${composer(base, p.csrf, c!.body,
        `<button type="submit">Save changes</button>
         <button type="submit" class="btn-ok" formaction="${esc(`${base}/approve`)}">Approve reply</button>`)}
      <p class="note">Approving locks this version's text. When sending is enabled, it will be sent exactly as approved.</p>
      <div class="reply-aside">${action(base, 'discard', p.csrf, 'Discard draft', 'btn-danger')}</div>
    </div>`;
  } else if (c!.state === 'approved') {
    main = `<div class="reply-card">
      <div class="reply-head">${chip('approved')}
        <span class="reply-meta">Approved by ${esc(c!.approved_by ?? 'unknown')} · ${esc(when(c!.approved_at))}</span></div>
      ${bubble(c!.body, c!.state)}
      <p class="reply-status">${p.sendingEnabled ? 'Waiting to send.' : 'Waiting to send. Sending is switched off.'}</p>
      <div class="actions">${action(base, 'change', p.csrf, 'Change reply')}</div>
      <p class="note">Changing an approved reply starts a new draft. This version is kept in the history.</p>
    </div>`;
  } else if (c!.state === 'publishing') {
    main = `<div class="reply-card">
      <div class="reply-head">${chip('publishing')}
        <span class="reply-meta">Sending to ${esc(store)} · attempt ${esc(String(Math.max(1, c!.attempts)))}</span></div>
      ${bubble(c!.body, c!.state)}
    </div>`;
  } else if (c!.state === 'pending_publish') {
    main = `<div class="reply-card">
      <div class="reply-head">${chip('pending_publish')}
        <span class="reply-meta">Sent to the App Store · ${esc(when(c!.published_at))}</span></div>
      ${bubble(c!.body, c!.state)}
      <p class="reply-status">It appears on the App Store once Apple publishes it.</p>
    </div>`;
  } else if (c!.state === 'published') {
    main = `<div class="reply-card">
      <div class="reply-head">${chip('published')}
        <span class="reply-meta">Published on ${esc(store)} · ${esc(when(c!.published_at))}</span></div>
      ${bubble(c!.body, c!.state)}
      <div class="actions">${action(base, 'edit', p.csrf, 'Edit reply')}</div>
      <p class="note">Editing starts a new draft. The published reply stays up until the replacement is published.</p>
    </div>`;
  } else {
    // failed
    main = `<div class="reply-card">
      <div class="reply-head">${chip('failed')}
        <span class="reply-meta">Not sent · ${esc(String(c!.attempts))} attempt${c!.attempts === 1 ? '' : 's'}</span></div>
      ${bubble(c!.body, c!.state)}
      ${c!.last_error ? `<p class="reply-error">${esc(p.review.source === 'app_store' ? 'The App Store' : 'Google Play')} said: ${
        esc(String(c!.last_error).slice(0, 300))}</p>` : ''}
      <div class="actions">${action(base, 'retry', p.csrf, 'Try again', 'btn-ok')}${action(base, 'change', p.csrf, 'Change reply')}</div>
    </div>`;
  }

  const earlier = p.history.filter((h) => h.reply_id !== c?.reply_id);
  const history = earlier.length === 0 ? '' : `<details class="reply-history">
      <summary>Earlier versions (${earlier.length})</summary>
      ${earlier.map((h) => `<div class="reply-old">
        <div class="reply-head">${chip(h.state)}
          <span class="reply-meta">${esc(h.created_by ?? 'unknown')} · ${esc(when(h.created_at))}</span></div>
        ${bubble(h.body, h.state)}</div>`).join('')}
    </details>`;

  return `${intro}${off}${main}${history}`;
}

/** Under a review in the list: the reply's text, clamped. State is already a badge. */
export function replyPreview(current: Pick<ReplyRow, 'body' | 'state'> | null, storeReply: StoreReply | null): string {
  const text = current?.body ?? storeReply?.text;
  if (!text) return '';
  const label = current ? (PREVIEW_LABEL[current.state] ?? 'Reply') : PREVIEW_LABEL.published;
  return `<div class="reply-mini"><span class="reply-from">${esc(label)}</span><p>${esc(text)}</p></div>`;
}
