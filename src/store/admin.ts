/**
 * Store Reviews in the console — the Android and iOS pages, and one review.
 *
 * PHASE 3: the read surface. List, filters, search, sorting, paging, and a
 * detail page carrying the full edit history and processing timeline.
 *
 * STILL NOTHING HERE WRITES. Not to store_reviews, and — this is the one that
 * matters — not to `submissions`. The existing feedback pipeline cannot be
 * reached from this file at all. Classification is Phase 4; the reply and
 * handoff ACTIONS are Phases 5 and 6, and they arrive with their own guard.
 *
 * ACCESS. These pages inherit /admin/review's open access, which is safe while
 * they are read-only. Admin authentication is a known open item, deferred by
 * the maintainer; the actions in Phases 5 and 6 are what turn it from an
 * improvement into a prerequisite, because approving a reply publishes public
 * text under Bread Wallet's developer account and the handoff opens a public
 * issue on a third-party repository.
 *
 * Every rule review.ts renders under holds here too, and for the same reason:
 * a store review is a stranger's text from a public listing. Zero JavaScript,
 * everything escaped, bodies inside <pre>, and a review flagged by the secret
 * scanner is never rendered at all — not its body and not its title.
 *
 * The filter form is a plain <form method=GET>. No script, so the CSP stays
 * `default-src 'none'`; the cost is a Filter button instead of live updating,
 * which on a page listing unpublished user reports is the right trade.
 */
import { esc, page, sidebar } from '../lib/admin-chrome';
import { PLATFORMS, buildNav } from '../lib/admin-nav';
import {
  REVIEW_STATES, REPLY_STATES, HANDOFF_STATES, ELIGIBILITY, LABELS,
  REVIEW_STATE_LABEL, REVIEW_STATE_BADGE, REPLY_STATE_LABEL, HANDOFF_STATE_LABEL,
} from './states';
import {
  parseQuery, buildQuery, withParam, hasFilters, SORTS, PAGE_SIZE, type StoreQuery,
} from './query';
import { isUuidV4 } from '../lib/validate';

interface StoreEnv {
  DB: D1Database;
}

/** The columns the list reads. Named, never `SELECT *`. */
const LIST_COLUMNS = `store_review_id, platform, source, platform_review_id,
  review_title, review_body, rating, reviewer_name, territory, language,
  review_created_at, review_updated_at, app_version, device, device_product,
  review_state, reply_state, handoff_state, eligibility,
  ai_labels, human_labels, secret_scan_status, sync_error`;

/**
 * A rating, as stars. Text, not an image or a webfont — the CSP forbids both,
 * and a star is the one glyph every platform draws the same way. `aria-label`
 * carries the number so a screen reader is told "2 out of 5" rather than five
 * ambiguous symbols.
 */
function stars(rating: number | null): string {
  if (rating == null || rating < 1 || rating > 5) return '<span class="tag">no rating</span>';
  const n = Math.round(rating);
  // Low ratings are the ones worth finding in a list, so they get the colour.
  return `<span class="${n <= 2 ? 'rating r-low' : 'rating'}" aria-label="${n} out of 5">${
    '★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
}

function when(ms: number | null): string {
  if (!ms) return 'unknown date';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function labelChips(row: any): string {
  const raw = row.human_labels ?? row.ai_labels;
  let parsed: unknown = [];
  try { parsed = JSON.parse(raw ?? '[]'); } catch { parsed = []; }
  const labels = Array.isArray(parsed) ? parsed.map(String) : [];
  if (labels.length === 0) return '';
  // WHO said so, set apart from WHAT they said. As a chip among chips,
  // "suggested" read as another label — the one thing it must not look like.
  const by = row.human_labels ? 'Your labels' : 'AI suggests';
  // Escaped even though these come from an allowlist: this page must not
  // depend on a guarantee made in another module.
  return `<div class="chips"><span class="chips-by">${esc(by)}</span>${
    labels.map((l) => `<span class="tag">${esc(l)}</span>`).join('')}</div>`;
}

/** The review's own words, or the placeholder that stands in for them. */
function bodyOf(row: any, cls = ''): string {
  if (row.secret_scan_status === 'flagged') {
    return '<pre class="redacted">[redacted — this review appeared to contain a key or seed phrase]</pre>';
  }
  return `<pre${cls ? ` class="${cls}"` : ''}>${esc(row.review_body ?? '')}</pre>`;
}

function metaLine(row: any): string {
  return [
    row.reviewer_name ? `by <b>${esc(row.reviewer_name)}</b>` : null,
    row.app_version ? `version <b>${esc(row.app_version)}</b>` : null,
    // device_product is the name on the box ("Pixel 7"); `device` is the
    // codename ("panther"). The detail table already preferred the former and
    // the meta line did not, so one page disagreed with itself.
    (row.device_product ?? row.device)
      ? `device <b>${esc(row.device_product ?? row.device)}</b>` : null,
    row.territory ? `<b>${esc(row.territory)}</b>` : null,
    row.review_updated_at ? `edited <b>${esc(when(row.review_updated_at))}</b>` : null,
  ].filter(Boolean).join(' <span class="sep">·</span> ');
}

function badges(row: any): string {
  const out = [
    `<span class="badge ${esc(REVIEW_STATE_BADGE[row.review_state] ?? 'b-queued')}">${
      esc(REVIEW_STATE_LABEL[row.review_state] ?? row.review_state)}</span>`,
  ];
  if (row.reply_state && row.reply_state !== 'none') {
    out.push(`<span class="badge b-queued">${
      esc(REPLY_STATE_LABEL[row.reply_state] ?? row.reply_state)}</span>`);
  }
  if (row.handoff_state && row.handoff_state !== 'none') {
    out.push(`<span class="badge b-queued">${
      esc(HANDOFF_STATE_LABEL[row.handoff_state] ?? row.handoff_state)}</span>`);
  }
  if (row.secret_scan_status === 'flagged') {
    out.push('<span class="badge b-quarantined">Redacted</span>');
  }
  return out.join('');
}

function renderRow(row: any): string {
  const href = `/admin/store/${encodeURIComponent(row.store_review_id)}`;
  const meta = metaLine(row);
  return `<article class="card">
    <div class="card-head">
      ${badges(row)}
      ${stars(row.rating)}
      <span class="when">${esc(when(row.review_created_at))} UTC</span>
      <a class="id" href="${esc(href)}">${esc(row.platform_review_id)} &rsaquo;</a>
    </div>
    <div class="card-body">
      ${labelChips(row)}
      ${row.review_title && row.secret_scan_status !== 'flagged'
        ? `<p class="rv-title">${esc(row.review_title)}</p>` : ''}
      ${meta ? `<p class="meta">${meta}</p>` : ''}
      ${bodyOf(row, 'clamp')}
      ${row.sync_error ? `<p class="note">Last sync error: ${esc(String(row.sync_error).slice(0, 160))}</p>` : ''}
    </div>
  </article>`;
}

/** One <select>, built from an allowlist with the current value preselected. */
function select(
  name: string, current: string | null, groupLabel: string,
  options: ReadonlyArray<readonly [string, string]>
): string {
  return `<label class="fl"><span>${esc(groupLabel)}</span>
    <select name="${esc(name)}">
      <option value="">Any</option>
      ${options.map(([value, label]) =>
        `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
      ).join('')}
    </select></label>`;
}

const pairs = (values: readonly string[], labels: Record<string, string> = {}) =>
  values.map((v) => [v, labels[v] ?? v] as const);

function filterBar(q: StoreQuery): string {
  return `<form class="filters" method="GET" action="/admin/store">
    <input type="hidden" name="platform" value="${esc(q.platform)}">
    <label class="fl grow"><span>Search</span>
      <input type="search" name="q" value="${esc(q.search ?? '')}" maxlength="120"
             placeholder="words in the title or body"></label>
    ${select('state', q.state, 'Triage', pairs(REVIEW_STATES, REVIEW_STATE_LABEL))}
    ${select('reply', q.reply, 'Reply', pairs(REPLY_STATES, REPLY_STATE_LABEL))}
    ${select('handoff', q.handoff, 'Pipeline', pairs(HANDOFF_STATES, HANDOFF_STATE_LABEL))}
    ${select('eligibility', q.eligibility, 'Eligibility', pairs(ELIGIBILITY))}
    ${select('label', q.label, 'Label', pairs(LABELS))}
    ${select('rating', q.rating == null ? null : String(q.rating), 'Rating',
      [['1', '1 star'], ['2', '2 stars'], ['3', '3 stars'], ['4', '4 stars'], ['5', '5 stars']])}
    ${select('flagged', q.flagged === null ? null : q.flagged ? 'yes' : 'no', 'Redacted',
      [['yes', 'Redacted only'], ['no', 'Exclude redacted']])}
    ${select('sort', q.sort, 'Sort', Object.entries(SORTS).map(([k, v]) => [k, v.label] as const))}
    <div class="fl-actions">
      <button type="submit">Filter</button>
      ${hasFilters(q)
        ? `<a class="clear" href="/admin/store?platform=${esc(q.platform)}">Clear all</a>` : ''}
    </div>
  </form>`;
}

/** The filters currently narrowing the list, each removable on its own. */
function activeChips(q: StoreQuery): string {
  const active: Array<[string, string]> = [];
  const add = (key: string, value: string | null, shown: string) => {
    if (value) active.push([key, shown]);
  };
  add('q', q.search, `“${q.search}”`);
  add('state', q.state, REVIEW_STATE_LABEL[q.state ?? ''] ?? q.state ?? '');
  add('reply', q.reply, REPLY_STATE_LABEL[q.reply ?? ''] ?? q.reply ?? '');
  add('handoff', q.handoff, HANDOFF_STATE_LABEL[q.handoff ?? ''] ?? q.handoff ?? '');
  add('eligibility', q.eligibility, q.eligibility ?? '');
  add('label', q.label, q.label ?? '');
  if (q.rating != null) active.push(['rating', `${q.rating}★`]);
  if (q.flagged !== null) {
    active.push(['flagged', q.flagged ? 'redacted only' : 'no redacted']);
  }
  if (active.length === 0) return '';
  return `<div class="chips active-filters">${active.map(([key, shown]) =>
    `<a class="tag removable" href="${esc(withParam(q, key, null))}">${esc(shown)} ×</a>`
  ).join('')}</div>`;
}

function pager(q: StoreQuery, total: number): string {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return '';
  const prev = q.page > 1
    ? `<a href="${esc(withParam(q, 'page', String(q.page - 1)))}">&lsaquo; Newer</a>`
    : '<span>&lsaquo; Newer</span>';
  const next = q.page < pages
    ? `<a href="${esc(withParam(q, 'page', String(q.page + 1)))}">Older &rsaquo;</a>`
    : '<span>Older &rsaquo;</span>';
  return `<nav class="pager" aria-label="Pages">${prev}
    <span class="pos">Page ${q.page} of ${pages}</span>${next}</nav>`;
}

/**
 * "No reviews" and "not collecting" are opposite situations and must not share
 * a message: the first is good news, the second is an outage wearing its
 * clothes. A third case — filters matching nothing — is neither, and saying
 * "not collecting yet" to someone who has just typed a search would be a lie.
 */
function emptyState(q: StoreQuery, store: string, syncedAt: number | null): string {
  if (hasFilters(q)) {
    return `<div class="empty">
      <p class="big">&#8981;</p><h3>No review matches these filters</h3>
      <p>Nothing here matched. <a href="/admin/store?platform=${esc(q.platform)}">Clear the filters</a>
         to see everything from ${esc(store)}.</p></div>`;
  }
  if (syncedAt) {
    return `<div class="empty">
      <p class="big">&#10003;</p><h3>No reviews to show</h3>
      <p>Nothing new from ${esc(store)} since the last sync (${esc(when(syncedAt))} UTC).
         New reviews appear here automatically.</p></div>`;
  }
  return `<div class="empty">
    <p class="big">&#9676;</p><h3>Not collecting yet</h3>
    <p>No review has been synced from ${esc(store)}. Collection starts once the store
       credentials are configured; until then this page stays empty and nothing is
       being missed on our side.</p></div>`;
}

// ---------------------------------------------------------------------------
// One review
// ---------------------------------------------------------------------------

const EVENT_LABEL: Record<string, string> = {
  sync: 'Sync', classify: 'AI', human: 'Decision', reply: 'Reply', handoff: 'Pipeline',
};

async function renderDetail(env: StoreEnv, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT * FROM store_reviews WHERE store_review_id = ?'
  ).bind(id).first<any>();

  if (!row) {
    return page('Store Reviews',
      `<div class="refused"><h1>Not found</h1>
       <p>That review is not in the console.</p>
       <p><a href="/admin/store?platform=android">Back to Store Reviews</a></p></div>`, 404);
  }

  const { groups } = await buildNav(env.DB, `store:${row.platform}`);
  const flagged = row.secret_scan_status === 'flagged';

  const versions = await env.DB.prepare(
    `SELECT id, raw_hash, rating, observed_at FROM store_review_versions
      WHERE store_review_id = ? ORDER BY id`
  ).bind(id).all<any>();

  const events = await env.DB.prepare(
    `SELECT at, kind, from_state, to_state, detail, actor FROM store_review_events
      WHERE store_review_id = ? ORDER BY id DESC LIMIT 100`
  ).bind(id).all<any>();

  const meta: Array<[string, string]> = [
    ['Store', row.source === 'app_store' ? 'Apple App Store' : 'Google Play'],
    ['Store review id', row.platform_review_id],
    ['App', row.app_id],
    ['Posted', `${when(row.review_created_at)} UTC`],
    ['Last edited upstream', row.review_updated_at ? `${when(row.review_updated_at)} UTC` : '—'],
    ['Last synced', `${when(row.last_synced_at)} UTC`],
    ['Reviewer', row.reviewer_name ?? '—'],
    ['App version', row.app_version ?? '—'],
    ['Device', row.device_product ?? row.device ?? '—'],
    // `androidOsVersion` is an API LEVEL, not a version number: "33" on its own
    // reads as a version and is not one. Labelled rather than mapped — an
    // API-level-to-Android-version table needs updating every year and is
    // wrong in between.
    [row.platform === 'android' ? 'Android API level' : 'OS',
      row.os_version ?? '—'],
    ['Territory', row.territory ?? '—'],
    ['Language', row.language ?? '—'],
    ['Eligibility', row.eligibility],
    ['Decided by', row.human_decided_by ?? 'nobody yet'],
  ];

  const versionRows = versions.results ?? [];
  const eventRows = events.results ?? [];

  const body = `<p class="crumb"><a href="/admin/store?platform=${esc(row.platform)}">&lsaquo; ${
      esc(PLATFORMS[row.platform]?.label ?? 'Store Reviews')}</a></p>
    <div class="head">
      <h2>${flagged || !row.review_title ? 'Review' : esc(row.review_title)}</h2>
      <p>${badges(row)} ${stars(row.rating)}</p>
    </div>

    <article class="card"><div class="card-body">
      ${labelChips(row)}
      ${metaLine(row) ? `<p class="meta">${metaLine(row)}</p>` : ''}
      ${bodyOf(row)}
      ${flagged ? `<p class="note">The secret scanner flagged this review, so its text is
        never rendered here. The original is stored and is shown on no page.</p>` : ''}
    </div></article>

    <h3 class="sect">Details</h3>
    <table class="kv"><tbody>${meta.map(([k, v]) =>
      `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>

    <h3 class="sect">Edit history</h3>
    ${versionRows.length <= 1
      ? '<p class="none">Never edited since we first saw it.</p>'
      : `<table class="kv"><tbody>${versionRows.map((v: any, i: number) =>
           `<tr><th scope="row">${esc(when(v.observed_at))} UTC${
              i === 0 ? ' <span class="tag">original</span>' : ''}</th>
            <td>${v.rating == null ? '—' : esc(String(v.rating))}&#9733;
            <code>${esc(String(v.raw_hash).slice(0, 12))}</code></td></tr>`).join('')}
         </tbody></table>
         <p class="note">The original is kept exactly as first received and is never rewritten.</p>`}

    <h3 class="sect">Processing history</h3>
    ${eventRows.length === 0
      ? '<p class="none">Nothing recorded yet.</p>'
      : `<ol class="timeline">${eventRows.map((e: any) =>
          `<li><span class="t-when">${esc(when(e.at))} UTC</span>
             <span class="tag">${esc(EVENT_LABEL[e.kind] ?? e.kind)}</span>
             <span class="t-detail">${esc(e.detail ?? '')}</span>
             ${e.actor ? `<span class="t-actor">${esc(e.actor)}</span>` : ''}</li>`).join('')}
        </ol>`}`;

  return page(`Store review — ${row.platform_review_id}`, body, 200, {}, sidebar(groups));
}

// ---------------------------------------------------------------------------

const notFound = () => page('Store Reviews',
  `<div class="refused"><h1>Not found</h1>
   <p><a href="/admin/store?platform=android">Back to Store Reviews</a></p></div>`, 404);

export async function handleStore(req: Request, env: StoreEnv, url: URL): Promise<Response | null> {
  if (url.pathname !== '/admin/store' && !url.pathname.startsWith('/admin/store/')) return null;

  // A DELIBERATE CLOSED DOOR, not an unfinished router. Phase 3 is read-only,
  // so every non-GET method is refused here. Phases 5 and 6 add POST endpoints
  // for reply approval and the handoff: those belong in front of this check
  // WITH their own credential, never by relaxing it.
  if (req.method !== 'GET') return notFound();

  const detail = url.pathname.match(/^\/admin\/store\/([^/]+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    // Validated before it is bound, so a malformed id is a 404 rather than a
    // query. Same rule the attachment proxy follows.
    if (!isUuidV4(id)) return notFound();
    return renderDetail(env, id);
  }

  if (url.pathname !== '/admin/store') return notFound();

  /**
   * An unknown PLATFORM redirects; an unknown filter value is simply dropped.
   *
   * The difference is what the URL claims. Platform decides the whole page —
   * its heading, its nav highlight, which store's reviews these are — so
   * rendering Android at a URL that says something else is a page quietly
   * disagreeing with its own address. The other filters announce what actually
   * applied in the chip row above the results, so dropping an unrecognised one
   * is visible rather than silent.
   */
  const rawPlatform = url.searchParams.get('platform');
  if (rawPlatform !== null && !PLATFORMS[rawPlatform]) {
    return new Response(null, {
      status: 303, headers: { location: '/admin/store?platform=android' },
    });
  }

  const q = parseQuery(url.searchParams);
  const meta = PLATFORMS[q.platform];
  const { groups } = await buildNav(env.DB, `store:${q.platform}`);

  // Reads are defensive for the same reason the nav's counts are: if migration
  // 0007 has not been applied to this database these throw `no such table`, and
  // an unhandled throw would take the page down rather than degrade it.
  let rows: any[] = [];
  let total = 0;
  let syncedAt: number | null = null;
  let unavailable = false;
  try {
    const built = buildQuery(q);
    const listed = await env.DB.prepare(
      `SELECT ${LIST_COLUMNS} FROM store_reviews
        WHERE ${built.where} ORDER BY ${built.orderBy} LIMIT ? OFFSET ?`
    ).bind(...built.binds, built.limit, built.offset).all<any>();
    rows = listed.results ?? [];

    const counted = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM store_reviews WHERE ${built.where}`
    ).bind(...built.binds).first<{ n: number }>();
    total = counted?.n ?? 0;

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
      <p>Reviews collected from ${esc(meta.store)}. The original is stored exactly as it was
         posted; everything shown here is derived from it.</p>
    </div>
    ${unavailable ? '' : filterBar(q)}
    ${unavailable ? '' : activeChips(q)}
    ${unavailable
      ? `<div class="empty"><p class="big">&#9888;</p><h3>Store reviews are unavailable</h3>
         <p>The store review tables could not be read. This usually means the database
            migration has not been applied to this environment yet. The feedback form
            and its queues are unaffected.</p></div>`
      : rows.length === 0
        ? emptyState(q, meta.store, syncedAt)
        : `<p class="count">${total} review${total === 1 ? '' : 's'}${
             hasFilters(q) ? ' matching' : ''}</p>
           ${rows.map(renderRow).join('')}
           ${pager(q, total)}`}`;

  return page(`Store Reviews — ${meta.label}`, body, 200, {}, sidebar(groups));
}
