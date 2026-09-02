/**
 * Store Reviews in the console — the Android and iOS pages.
 *
 * PHASE 0. This is the read surface only, and there is nothing to read yet:
 * no sync runs, so every page is empty until Google Play and App Store
 * credentials exist. Filters, search, sorting and the per-review detail page
 * are Phase 3; classification is Phase 4; the reply and handoff ACTIONS are
 * Phases 5 and 6.
 *
 * NOTHING HERE WRITES. Not to store_reviews, and — this is the one that
 * matters — not to `submissions`. The existing feedback pipeline cannot be
 * reached from this file at all, which is the boundary the whole design rests
 * on. When the handoff arrives it will be its own module with its own guard.
 *
 * ACCESS. These pages currently inherit /admin/review's open access, which is
 * safe only while they are read-only and empty. Before the reply-approval and
 * handoff actions land, they must sit behind a credential: approving a reply
 * publishes public text under Bread Wallet's developer account, and the handoff
 * opens a public issue on a third-party repository. Neither is an action an
 * uncredentialed page may offer. Decided with Ivan on 2026-09-02.
 *
 * Every rule review.ts renders under holds here too, and for the same reason:
 * a store review is attacker-controlled text. Zero JavaScript, everything
 * escaped, bodies inside <pre>, and a review flagged by the secret scanner is
 * never rendered at all.
 */
import { esc, page, sidebar } from '../lib/admin-chrome';
import { PLATFORMS, buildNav } from '../lib/admin-nav';
import { REVIEW_STATE_LABEL, REPLY_STATE_LABEL } from './states';

interface StoreEnv {
  DB: D1Database;
}

/** The columns the list page reads. Named, never `SELECT *`. */
const LIST_COLUMNS = `store_review_id, platform, source, platform_review_id,
  review_title, review_body, rating, reviewer_name, territory, language,
  review_created_at, review_updated_at, app_version, device,
  review_state, reply_state, handoff_state, eligibility,
  ai_labels, human_labels, secret_scan_status, sync_error`;

/**
 * A rating, as stars.
 *
 * Text, not an image or a webfont — the CSP forbids both, and a star is the
 * one glyph every platform draws the same way. `aria-label` carries the number
 * so a screen reader is told "3 out of 5" rather than five ambiguous symbols.
 */
function stars(rating: number | null): string {
  if (rating == null || rating < 1 || rating > 5) {
    return '<span class="tag">no rating</span>';
  }
  const n = Math.round(rating);
  const glyphs = '★'.repeat(n) + '☆'.repeat(5 - n);
  // Low ratings are the ones worth finding in a list, so they are the ones
  // that get colour. A 5-star review does not need to catch the eye.
  const cls = n <= 2 ? 'rating r-low' : 'rating';
  return `<span class="${cls}" aria-label="${n} out of 5">${glyphs}</span>`;
}

function when(ms: number | null): string {
  if (!ms) return 'unknown date';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/** Labels, whichever set is authoritative: a human's overrules the model's. */
function labelChips(row: any): string {
  let labels: unknown = [];
  const raw = row.human_labels ?? row.ai_labels;
  try { labels = JSON.parse(raw ?? '[]'); } catch { labels = []; }
  if (!Array.isArray(labels) || labels.length === 0) return '';
  const by = row.human_labels ? 'yours' : 'suggested';
  // Escaped even though these come from an allowlist. This page must not
  // depend on a guarantee made in another module.
  return `<div class="chips">${
    labels.map((l) => `<span class="tag">${esc(l)}</span>`).join('')
  }<span class="tag">${esc(by)}</span></div>`;
}

function renderReview(row: any): string {
  // A flagged review is NEVER rendered. The scanner runs at sync precisely so
  // that a seed phrase someone pasted into a public store review does not get
  // copied onto a second screen. What it looked like is in raw_json, which
  // this page does not read.
  const flagged = row.secret_scan_status === 'flagged';
  const body = flagged
    ? '<pre class="redacted">[redacted — this review appeared to contain a key or seed phrase]</pre>'
    : `<pre>${esc(row.review_body ?? '')}</pre>`;

  const title = row.review_title && !flagged
    ? `<p class="rv-title">${esc(row.review_title)}</p>`
    : '';

  const meta = [
    row.reviewer_name ? `by <b>${esc(row.reviewer_name)}</b>` : null,
    row.app_version ? `version <b>${esc(row.app_version)}</b>` : null,
    row.device ? `device <b>${esc(row.device)}</b>` : null,
    row.territory ? `<b>${esc(row.territory)}</b>` : null,
    row.review_updated_at ? `edited <b>${esc(when(row.review_updated_at))}</b>` : null,
  ].filter(Boolean).join(' <span class="sep">·</span> ');

  const reply = row.reply_state && row.reply_state !== 'none'
    ? `<span class="badge b-queued">${esc(REPLY_STATE_LABEL[row.reply_state] ?? row.reply_state)}</span>`
    : '';

  const stuck = row.sync_error
    ? `<p class="note">Last sync error: ${esc(String(row.sync_error).slice(0, 160))}</p>`
    : '';

  return `<article class="card">
    <div class="card-head">
      <span class="badge b-suspected">${
        esc(REVIEW_STATE_LABEL[row.review_state] ?? row.review_state)}</span>
      ${reply}
      ${stars(row.rating)}
      <span class="when">${esc(when(row.review_created_at))} UTC</span>
      <code class="id">${esc(row.platform_review_id)}</code>
    </div>
    <div class="card-body">
      ${labelChips(row)}
      ${title}
      ${meta ? `<p class="meta">${meta}</p>` : ''}
      ${body}
      ${stuck}
    </div>
  </article>`;
}

/**
 * What to say when a page is empty, which in Phase 0 is always.
 *
 * "No reviews" and "not collecting reviews" are opposite situations and must
 * not share a message — the first is good news and the second is an outage.
 * Which one it is, is decided by whether a sync has ever succeeded.
 */
function emptyState(store: string, syncedAt: number | null): string {
  if (syncedAt) {
    return `<div class="empty">
      <p class="big">✓</p>
      <h3>No reviews to show</h3>
      <p>Nothing new from ${esc(store)} since the last sync
         (${esc(when(syncedAt))} UTC). New reviews appear here automatically.</p>
    </div>`;
  }
  return `<div class="empty">
    <p class="big">◌</p>
    <h3>Not collecting yet</h3>
    <p>No review has been synced from ${esc(store)}. Collection starts once the
       store credentials are configured; until then this page stays empty and
       nothing is being missed on our side.</p>
  </div>`;
}

/**
 * Handles every /admin/store* route. Returns null when the path is not ours,
 * so index.ts can fall through to its other routes.
 */
export async function handleStore(req: Request, env: StoreEnv, url: URL): Promise<Response | null> {
  if (url.pathname !== '/admin/store' && !url.pathname.startsWith('/admin/store/')) return null;

  // A DELIBERATE CLOSED DOOR, not an unfinished router. Phase 0 has exactly
  // one page and no actions, so every other path and every non-GET method is
  // refused here rather than falling through to index.ts's other routes.
  // Phase 5 and 6 add POST endpoints for reply approval and the handoff: those
  // belong in front of this check WITH their own credential, never by relaxing
  // it. See the access note at the top of this file.
  if (url.pathname !== '/admin/store' || req.method !== 'GET') {
    return page('Store Reviews',
      `<div class="refused"><h1>Not found</h1>
       <p><a href="/admin/store?platform=android">Back to Store Reviews</a></p></div>`, 404);
  }

  // Unknown platform falls back rather than erroring, and never interpolates
  // the caller's string into SQL or the page. Same rule the review queue's
  // `?q=` follows.
  const platform = url.searchParams.get('platform') ?? 'android';
  const meta = PLATFORMS[platform];
  if (!meta) {
    return new Response(null, {
      status: 303, headers: { location: '/admin/store?platform=android' },
    });
  }

  const { groups } = await buildNav(env.DB, `store:${platform}`);

  // Reads are defensive for the same reason the nav's counts are: if migration
  // 0007 has not been applied to this database, this throws `no such table`,
  // and an unhandled throw here would take down a page rather than degrade it.
  // A console that cannot show store reviews is a smaller problem than one
  // that returns 500 and tells nobody why.
  let rows: any[] = [];
  let syncedAt: number | null = null;
  let unavailable = false;
  try {
    const listed = await env.DB.prepare(
      `SELECT ${LIST_COLUMNS} FROM store_reviews
        WHERE platform = ? ORDER BY review_created_at DESC LIMIT 100`
    ).bind(platform).all<any>();
    rows = listed.results ?? [];

    const sync = await env.DB.prepare(
      'SELECT MAX(last_success_at) AS at FROM store_sync_state WHERE key LIKE ?'
    ).bind(`${meta.source}:%`).first<{ at: number | null }>();
    syncedAt = sync?.at ?? null;
  } catch (err) {
    unavailable = true;
    console.warn('store review tables unavailable', (err as Error)?.message);
  }

  const body = `<div class="head">
      <h2>${esc(meta.label)}</h2>
      <p>Reviews collected from ${esc(meta.store)}. The original is stored exactly
         as it was posted; everything shown here is derived from it.</p>
    </div>
    ${unavailable
      ? `<div class="empty">
           <p class="big">⚠</p>
           <h3>Store reviews are unavailable</h3>
           <p>The store review tables could not be read. This usually means the
              database migration has not been applied to this environment yet.
              The feedback form and its queues are unaffected.</p>
         </div>`
      : rows.length === 0
        ? emptyState(meta.store, syncedAt)
        : rows.map((r) => renderReview(r)).join('')}`;

  return page(`Store Reviews — ${meta.label}`, body, 200, {}, sidebar(groups));
}
