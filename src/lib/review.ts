/**
 * The review queue — where a flagged report is read by a human.
 *
 * This page exists so the spam layer is not a black hole. Nothing is ever
 * auto-released; a suspected report waits here until someone decides.
 *
 * ACCESS: OPEN. No token, no session, no cookie. Ivan decided on 2026-08-25
 * that the queue must be readable at any time without a credential, and that
 * decision is recorded here rather than argued with. What follows from it:
 * anyone who has the URL can read every held report and its attachments, and
 * can press Release or Confirm spam. There is no CSRF token because there is
 * no session to bind one to, and none would add anything -- a request that
 * needs no credential can be made directly.
 *
 * It still renders attacker-controlled text, so two rules hold throughout:
 *
 *   1. ZERO JAVASCRIPT. Plain server-rendered HTML with <form method=POST>.
 *      A page with no script cannot be driven by injected content even if the
 *      escaping had a bug. It is also why the CSP can be `default-src 'none'`.
 *   2. Every submitter-controlled value is escaped, and the report body renders
 *      inside <pre> — never as markup, never as a URL the page will fetch.
 *
 * Served by the WORKER, not from ./public: static assets are matched before
 * the Worker runs, so a file there would be world-readable with no auth at all.
 */

import { applyReviewDecision, type ReviewAction } from './publish-guard';
import { isUuidV4 } from './validate';

const ACTIONS: ReadonlyArray<ReviewAction> = ['release', 'confirm', 'restore'];

/** Queues a reviewer can page through, and the state each maps to. */
const QUEUES: Record<string, { state: string; label: string }> = {
  suspected: { state: 'suspected_spam', label: 'Suspected' },
  spam: { state: 'spam', label: 'Confirmed spam' },
  quarantined: { state: 'quarantined', label: 'Quarantined (secrets)' },
  failed: { state: 'failed', label: 'Failed' },
};

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/**
 * `default-src 'none'` is possible only because the page has no script, no
 * fonts and no third-party anything. `img-src 'self'` lets a screenshot render
 * through the attachment proxy and nothing else — in particular a body full of
 * image URLs cannot beacon out to an attacker's host.
 */
function secureHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    // A review page must never be cached anywhere: it is full of unpublished
    // user reports, some of which will turn out to be real.
    'cache-control': 'no-store, private',
    // Not a control -- it stops nobody. It only keeps an uncredentialed page
    // holding unpublished reports out of search results.
    'x-robots-tag': 'noindex, nofollow, noarchive',
    ...extra,
  };
}

const STYLE = `<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:1.5rem;background:#fff;color:#111}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}pre{background:#1c1c1c}
  .card{border-color:#333}a{color:#8ab4f8}}
 pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;padding:.75rem;border-radius:4px;max-height:22rem;overflow:auto}
 .card{border:1px solid #ddd;border-radius:6px;padding:1rem;margin:0 0 1rem}
 .meta{font-size:12px;opacity:.75;margin:.25rem 0 .5rem}
 .tag{display:inline-block;border:1px solid currentColor;border-radius:3px;padding:0 .35rem;margin-right:.3rem;font-size:11px}
 nav a{margin-right:1rem}
 form.inline{display:inline}
 button{font:inherit;padding:.35rem .8rem;margin-right:.5rem;cursor:pointer}
 .empty{opacity:.7;padding:2rem 0}
</style>`;

function page(title: string, body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>${esc(title)}</title>${STYLE}</head><body>${body}</body></html>`,
    { status, headers: secureHeaders(extra) }
  );
}

function renderReasons(raw: string | null): string {
  let codes: unknown = [];
  try { codes = JSON.parse(raw ?? '[]'); } catch { codes = []; }
  if (!Array.isArray(codes) || codes.length === 0) return '<span class="tag">no reason codes</span>';
  // Reason CODES only ever reach here — the model's are filtered against an
  // allowlist and the rest are code-assigned. Escaped anyway: this page must
  // not depend on a guarantee made in another module.
  return codes.map((c) => `<span class="tag">${esc(c)}</span>`).join('');
}

function renderAttachments(row: any): string {
  let keys: string[] = [];
  try { keys = JSON.parse(row.attachment_keys ?? '[]'); } catch { keys = []; }
  const items = keys.map((j) => { try { return JSON.parse(j); } catch { return null; } }).filter(Boolean);
  if (items.length === 0) return '';
  return items.map((a: any) => {
    const href = `/admin/review/attachment/${encodeURIComponent(row.submission_id)}/${encodeURIComponent(a.name)}`;
    // Proxied, never a public R2 or GitHub URL: an unreviewed report's
    // screenshot must not be reachable by anyone holding a guessable link.
    return a.type?.startsWith('image/')
      ? `<p><img src="${esc(href)}" alt="attachment" style="max-width:100%;max-height:20rem"></p>`
      : `<p><a href="${esc(href)}">${esc(a.name)}</a> (${esc(a.type)})</p>`;
  }).join('');
}

function actionsFor(state: string, id: string): string {
  // `spam` offers Restore and NOTHING else. There is no one-step path back to
  // a publishable state, by construction as well as by omission here.
  const buttons: Array<[ReviewAction, string]> =
    state === 'suspected_spam' ? [['release', 'Release'], ['confirm', 'Confirm spam']]
    : state === 'spam' ? [['restore', 'Restore for review']]
    : [];
  if (buttons.length === 0) return '<p class="meta">No actions available for this state.</p>';
  return buttons.map(([action, label]) =>
    `<form class="inline" method="POST" action="/admin/review/${esc(id)}/${action}">
       <button type="submit">${esc(label)}</button>
     </form>`).join('');
}

function renderRow(row: any): string {
  const when = new Date(row.received_at).toISOString().replace('T', ' ').slice(0, 16);
  // A quarantined row's body is already the redacted placeholder in the
  // database. Secret-material handling is untouched by the spam layer.
  return `<div class="card">
    <div class="meta">
      <code>${esc(row.submission_id)}</code> · ${esc(when)} UTC ·
      state <strong>${esc(row.state)}</strong> ·
      status ${esc(row.spam_status ?? 'null (clean)')} ·
      reporter ${esc(row.reporter_kind ?? 'unknown')}
      ${row.spam_reviewed_at ? ` · reviewed ${esc(new Date(row.spam_reviewed_at).toISOString().slice(0, 16))} by ${esc(row.spam_reviewed_by)}` : ''}
    </div>
    <div class="meta">
      ${renderReasons(row.spam_reasons)}
      <span class="tag">score ${row.spam_score == null ? 'n/a' : esc(row.spam_score.toFixed(2))} — telemetry, not the decision</span>
    </div>
    <pre>${esc(row.body_sanitized)}</pre>
    ${renderAttachments(row)}
    ${actionsFor(row.state, row.submission_id)}
  </div>`;
}

function nav(active: string): string {
  return `<nav>${Object.entries(QUEUES).map(([q, { label }]) =>
    q === active ? `<strong>${esc(label)}</strong>` : `<a href="/admin/review?q=${q}">${esc(label)}</a>`
  ).join('')}</nav>`;
}

interface ReviewEnv {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
}

/**
 * Handles every /admin/review* route. Returns null when the path is not ours,
 * so index.ts can fall through to its other routes.
 */
export async function handleReview(req: Request, env: ReviewEnv, url: URL): Promise<Response | null> {
  if (url.pathname !== '/admin/review' && !url.pathname.startsWith('/admin/review/')) return null;

  // --- attachment proxy ---------------------------------------------------
  const att = url.pathname.match(/^\/admin\/review\/attachment\/([^/]+)\/(.+)$/);
  if (att && req.method === 'GET') {
    const [, rawId, rawName] = att;
    const id = decodeURIComponent(rawId);
    if (!isUuidV4(id)) return new Response('not found', { status: 404 });

    const row = await env.DB.prepare('SELECT attachment_keys FROM submissions WHERE submission_id = ?')
      .bind(id).first<{ attachment_keys: string | null }>();
    if (!row) return new Response('not found', { status: 404 });

    let stored: any = null;
    try {
      stored = (JSON.parse(row.attachment_keys ?? '[]') as string[])
        .map((j) => { try { return JSON.parse(j); } catch { return null; } })
        .find((a: any) => a && a.name === decodeURIComponent(rawName)) ?? null;
    } catch { stored = null; }
    // The key comes from the ROW, never from the URL — the name in the path is
    // only ever used to pick between this submission's own attachments, so a
    // traversal attempt selects nothing rather than reaching another object.
    if (!stored) return new Response('not found', { status: 404 });

    const obj = await env.ATTACHMENTS.get(stored.key);
    if (!obj) return new Response('not found', { status: 404 });

    return new Response(obj.body, {
      headers: {
        // The SNIFFED type, verified at admission. nosniff so a browser cannot
        // decide it knows better.
        'content-type': stored.type ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'no-store, private',
        // Video is downloaded, not played inline: a player is a parser, and
        // this is the one page where an unreviewed file is opened.
        ...(stored.type?.startsWith('video/')
          ? { 'content-disposition': `attachment; filename="${encodeURIComponent(stored.name)}"` }
          : {}),
      },
    });
  }

  // --- actions ------------------------------------------------------------
  const act = url.pathname.match(/^\/admin\/review\/([^/]+)\/(release|confirm|restore)$/);
  if (act && req.method === 'POST') {
    const [, rawId, action] = act;
    const id = decodeURIComponent(rawId);
    if (!isUuidV4(id)) return page('Review', '<h1>404</h1>', 404);

    const row = await env.DB.prepare('SELECT state FROM submissions WHERE submission_id = ?')
      .bind(id).first<{ state: string }>();
    if (!row) return page('Review', '<h1>404</h1>', 404);

    // The decision itself lives in publish-guard: allowed edges are data there,
    // `spam -> received` is absent by construction, and it refuses outright on
    // any row the drain currently owns.
    // There is no session, so there is no actor to name. Recording the
    // request IP is the only thing left that tells one decision from another
    // in state_log, and an audit row that says exactly how much is known beats
    // one that invents an identity.
    const actor = `open:${req.headers.get('cf-connecting-ip') ?? 'unknown'}`;
    const result = await applyReviewDecision(
      env.DB, id, row.state, action as ReviewAction, actor
    );

    const back = `/admin/review?q=${row.state === 'spam' ? 'spam' : 'suspected'}`;
    if (!result.ok) {
      return page('Review',
        `<h1>Action refused</h1><p>${esc(result.reason)}</p><p><a href="${back}">Back to the queue</a></p>`,
        409);
    }
    // 303 so a refresh cannot repeat the action.
    return new Response(null, { status: 303, headers: { location: back, ...secureHeaders() } });
  }

  // --- the queue ----------------------------------------------------------
  if (url.pathname === '/admin/review' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? 'suspected';
    const queue = QUEUES[q];
    // Unknown filter falls back rather than erroring, and never interpolates
    // the caller's string into SQL or the page.
    if (!queue) return new Response(null, { status: 303, headers: { location: '/admin/review?q=suspected' } });

    const { results } = await env.DB.prepare(
      `SELECT submission_id, received_at, state, body_sanitized, spam_status, spam_score,
              spam_reasons, reporter_kind, spam_reviewed_at, spam_reviewed_by, attachment_keys
         FROM submissions WHERE state = ? ORDER BY received_at ASC LIMIT 100`
    ).bind(queue.state).all<any>();

    const rows = results ?? [];
    // Queues are listed SEPARATELY on purpose: a flood of correctly-caught
    // spam must never be able to bury one false positive in a mixed list.
    const body = `<h1>${esc(queue.label)} <span class="meta">(${rows.length})</span></h1>
      ${nav(q)}
      ${rows.length === 0
        ? '<p class="empty">Nothing here.</p>'
        : rows.map((r) => renderRow(r)).join('')}`;
    return page(`Review — ${queue.label}`, body);
  }

  return page('Review', '<h1>404</h1>', 404);
}
