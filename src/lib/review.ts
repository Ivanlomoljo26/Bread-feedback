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

/**
 * Queues a reviewer can page through, and the state each maps to.
 *
 * `empty` is per queue on purpose. "Nothing here" is the same four words
 * whether the filter caught nothing all week or every report has been dealt
 * with, and those are opposite situations to be looking at.
 */
/**
 * The tab bar is TWO groups, not six tabs. They answer different questions and
 * a flat row invites reading them as one list — a reviewer scanning for
 * "anything waiting on me" should never have to notice that half the row is
 * not about them.
 *
 *   spam     — a person decides. Every tab here is work for a human.
 *   delivery — the pipeline reports on itself. Nothing here needs a decision;
 *              a non-zero count is information, and sometimes a warning.
 */
const GROUPS: Array<{ id: string; label: string; cls: string; icon: string }> = [
  {
    id: 'spam', label: 'Spam filter', cls: 'g-spam',
    // Inline SVG, not an emoji or a webfont: the CSP is `default-src 'none'`
    // and a glyph that renders differently per platform is not an icon.
    icon: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"'
        + ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"'
        + ' stroke-linejoin="round"><path d="M2.4 3.3h11.2l-4.3 5.1v4.3l-2.6-1.3V8.4z"/></svg>',
  },
  {
    id: 'delivery', label: 'Delivery', cls: 'g-delivery',
    icon: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"'
        + ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"'
        + ' stroke-linejoin="round"><path d="M2.3 8h9.1"/><path d="M8.4 4.6 11.8 8l-3.4 3.4"/></svg>',
  },
];

const QUEUES: Record<string, {
  group: string; state: string; label: string; badge: string; desc: string;
  empty: { icon: string; head: string; note: string };
}> = {
  suspected: {
    group: 'spam', desc: 'Held by the filter. Each one needs a decision before it can go anywhere.', state: 'suspected_spam', label: 'Suspected', badge: 'b-suspected',
    empty: { icon: '\u2713', head: 'Nothing waiting on you',
             note: 'No report has been flagged. Anything the filter holds back shows up here for a decision.' },
  },
  spam: {
    group: 'spam', desc: 'Confirmed spam. Kept rather than deleted, and restorable if a call was wrong.', state: 'spam', label: 'Confirmed spam', badge: 'b-spam',
    empty: { icon: '\u2205', head: 'No confirmed spam',
             note: 'Reports you mark as spam are kept here, and can still be restored for another look.' },
  },
  quarantined: {
    group: 'spam', desc: 'Appeared to contain a key or seed phrase, so the body was redacted. These can never be published.', state: 'quarantined', label: 'Quarantined', badge: 'b-quarantined',
    empty: { icon: '\u26bf', head: 'No quarantined reports',
             note: 'A report that appeared to contain a key or seed phrase is redacted and held here. It can never be published.' },
  },
  capped: {
    group: 'delivery', desc: 'Accepted and waiting on a publish cap. These file themselves as slots free \u2014 nothing here needs you.', state: 'capped', label: 'Queued', badge: 'b-queued',
    empty: { icon: '\u2713', head: 'Nothing queued',
             note: 'Reports wait here when a publish cap is full. They file themselves as slots free \u2014 nothing is lost and no retry budget is spent.' },
  },
  deferred: {
    group: 'delivery', desc: 'Waiting on GitHub or the classifier. A count that stays above zero means something upstream is broken.', state: 'deferred', label: 'Deferred', badge: 'b-deferred',
    empty: { icon: '\u2713', head: 'Nothing deferred',
             note: 'Reports wait here when GitHub or the classifier is unavailable. A count that stays above zero means something upstream needs looking at.' },
  },
  failed: {
    group: 'delivery', desc: 'Every retry to file these on GitHub was spent. They are parked, not deleted.', state: 'failed', label: 'Failed', badge: 'b-failed',
    empty: { icon: '\u2713', head: 'Nothing failed',
             note: 'Reports land here only after every retry to file them on GitHub was exhausted.' },
  },
};

function brand(): string {
  return `<div class="brand">
    <span class="mark" aria-hidden="true">MF</span>
    <span class="brand-t">
      <strong>Feedback review</strong>
      <small>Held before GitHub</small>
    </span>
  </div>`;
}

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
 :root{
   --bg:#f4f5f7; --panel:#fff; --sunk:#fafbfc; --ink:#14161a; --muted:#5c6270;
   --line:#e3e5ea; --line-soft:#eef0f3;
   --accent:#5b5bd6; --accent-ink:#fff; --accent-soft:#eeeefb; --code:#f2f3f6;
   --g-spam:#5b5bd6; --g-spam-bg:#f1f1fc; --g-spam-line:#ddddf6;
   --g-del:#0f766e;  --g-del-bg:#ecf6f4;  --g-del-line:#cfe6e1;
   --ok:#177245; --ok-line:#177245; --danger:#a11b2b; --danger-line:#a11b2b;
   --warn-bg:#fff4e0; --warn-ink:#8a5300; --warn-line:#e6c68a;
   --spam-bg:#fdeaec; --spam-ink:#a11b2b; --spam-line:#eec1c6;
   --quar-bg:#eceaf9; --quar-ink:#443a99; --quar-line:#cdc7ee;
   --fail-bg:#eef0f3; --fail-ink:#4b5160; --fail-line:#d6dae1;
 }
 @media(prefers-color-scheme:dark){
   :root{
     --bg:#0c0e11; --panel:#15181d; --sunk:#111419; --ink:#e8eaee; --muted:#98a0ae;
     --line:#242932; --line-soft:#1d222a;
     --accent:#8b8bf0; --accent-ink:#11131a; --accent-soft:#1d1e33; --code:#0e1115;
     --g-spam:#9b9bf5; --g-spam-bg:#181a2b; --g-spam-line:#272a45;
     --g-del:#5eead4;  --g-del-bg:#111f1d;  --g-del-line:#1e3733;
     --ok:#4ade80; --ok-line:#2f6b46; --danger:#f87171; --danger-line:#7a3038;
     --warn-bg:#2c2213; --warn-ink:#f0c274; --warn-line:#4d3c1d;
     --spam-bg:#2c1619; --spam-ink:#f2a0a8; --spam-line:#5b2b32;
     --quar-bg:#1e1b33; --quar-ink:#b9b0f5; --quar-line:#372f5c;
     --fail-bg:#1a1e25; --fail-ink:#a6aebd; --fail-line:#333a45;
   }
 }
 *{box-sizing:border-box}
 body{
   margin:0;background:var(--bg);color:var(--ink);
   font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
   -webkit-font-smoothing:antialiased;
 }
 a{color:var(--accent)}

 /* ---- shell ---- */
 .app{display:grid;grid-template-columns:15.5rem minmax(0,1fr);min-height:100vh}
 .app.solo{grid-template-columns:minmax(0,1fr)}

 /* ---- sidebar ---- */
 .side{
   background:var(--panel);border-right:1px solid var(--line);
   padding:1.15rem .8rem;display:flex;flex-direction:column;gap:1.4rem;
   position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto;
 }
 .brand{display:flex;align-items:center;gap:.6rem;padding:0 .4rem}
 .mark{
   flex:none;width:2rem;height:2rem;border-radius:.55rem;
   background:var(--accent);color:var(--accent-ink);
   display:inline-flex;align-items:center;justify-content:center;
   font-size:.72rem;font-weight:700;letter-spacing:.03em;
 }
 .brand-t{display:flex;flex-direction:column;min-width:0}
 .brand-t strong{font-size:.92rem;font-weight:650;letter-spacing:-.01em}
 .brand-t small{font-size:.72rem;color:var(--muted)}

 /* Each group carries its own hue and mark. Two labels set in identical type
    read as one list with a word dropped into the middle of it. */
 .grp{
   border:1px solid var(--g-line);border-radius:.55rem;
   background:var(--g-bg);padding:.3rem;
 }
 .g-spam{--g:var(--g-spam);--g-bg:var(--g-spam-bg);--g-line:var(--g-spam-line)}
 .g-delivery{--g:var(--g-del);--g-bg:var(--g-del-bg);--g-line:var(--g-del-line)}
 .grp + .grp{margin-top:.6rem}
 .grp-l{
   display:flex;align-items:center;gap:.4rem;cursor:pointer;
   padding:.35rem .45rem;border-radius:.4rem;
   font-size:.67rem;font-weight:700;letter-spacing:.11em;
   text-transform:uppercase;color:var(--g);
   list-style:none;user-select:none;
 }
 .grp-l::-webkit-details-marker{display:none}
 .grp-l:hover{background:var(--panel)}
 .grp-l:focus-visible{outline:2px solid var(--g);outline-offset:1px}
 .grp-i{display:inline-flex;opacity:.9}
 .chev{margin-left:auto;display:inline-flex;opacity:.55;transition:transform .12s ease}
 .grp[open] .chev{transform:rotate(90deg)}
 @media(prefers-reduced-motion:reduce){.chev{transition:none}}
 .grp nav{display:flex;flex-direction:column;gap:.1rem;padding-top:.2rem}
 .q{
   display:flex;align-items:center;gap:.5rem;
   padding:.48rem .55rem;border-radius:.45rem;
   border-left:2px solid transparent;
   color:var(--muted);text-decoration:none;font-size:.87rem;font-weight:550;
 }
 .q:hover{background:var(--panel);color:var(--ink)}
 .q[aria-current="page"]{
   background:var(--panel);color:var(--ink);font-weight:650;
   border-left-color:var(--g);box-shadow:0 1px 2px rgba(0,0,0,.06);
 }
 .q:focus-visible{outline:2px solid var(--g);outline-offset:1px}
 .q .n{
   margin-left:auto;min-width:1.3rem;text-align:right;
   font-size:.78rem;font-weight:650;font-variant-numeric:tabular-nums;color:var(--muted);
 }
 .q .n.zero{opacity:.35;font-weight:550}
 .q[aria-current="page"] .n{color:var(--g)}

 /* ---- main ---- */
 main{padding:1.6rem 1.8rem 4rem;min-width:0}
 main.narrow{max-width:34rem;margin:0 auto;padding-top:3rem;display:flex;flex-direction:column;gap:1.5rem}
 .head{margin:0 0 1.15rem}
 .head h2{margin:0;font-size:1.2rem;font-weight:650;letter-spacing:-.02em}
 .head p{margin:.3rem 0 0;font-size:.86rem;color:var(--muted);max-width:64ch}

 /* ---- cards ---- */
 .card{
   background:var(--panel);border:1px solid var(--line);border-radius:.65rem;
   margin:0 0 .8rem;overflow:hidden;
 }
 .card-head{
   display:flex;flex-wrap:wrap;align-items:center;gap:.55rem;
   padding:.65rem .9rem;background:var(--sunk);border-bottom:1px solid var(--line-soft);
 }
 .when{font-size:.78rem;color:var(--muted);font-variant-numeric:tabular-nums}
 .id{
   font:.71rem/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
   color:var(--muted);margin-left:auto;word-break:break-all;opacity:.75;
 }
 .card-body{padding:.9rem}
 .badge{
   display:inline-flex;align-items:center;
   padding:.2rem .5rem;border-radius:.35rem;
   font-size:.72rem;font-weight:650;border:1px solid;
 }
 .b-suspected{background:var(--warn-bg);color:var(--warn-ink);border-color:var(--warn-line)}
 .b-spam{background:var(--spam-bg);color:var(--spam-ink);border-color:var(--spam-line)}
 .b-quarantined{background:var(--quar-bg);color:var(--quar-ink);border-color:var(--quar-line)}
 .b-failed{background:var(--fail-bg);color:var(--fail-ink);border-color:var(--fail-line)}
 .b-queued{background:var(--code);color:var(--muted);border-color:var(--line)}
 .b-deferred{background:var(--warn-bg);color:var(--warn-ink);border-color:var(--warn-line)}

 /* Reason codes stay chips. Everything else is a quiet meta line — a row of
    identical pills makes a score look like a verdict, which it is not. */
 .chips{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;margin:0 0 .7rem}
 .tag{
   display:inline-block;padding:.15rem .45rem;border-radius:.3rem;
   border:1px solid var(--line);background:var(--code);
   font:.71rem/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);
 }
 .meta{
   display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;
   margin:0 0 .7rem;font-size:.77rem;color:var(--muted);
 }
 .meta b{color:var(--ink);font-weight:600}
 .sep{opacity:.35}
 .note{font-size:.77rem;color:var(--muted);margin:.6rem 0 0}

 pre{
   margin:0;white-space:pre-wrap;word-break:break-word;
   background:var(--code);border:1px solid var(--line-soft);
   padding:.8rem;border-radius:.5rem;max-height:24rem;overflow:auto;
   font:.82rem/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
 }
 .shot{margin:.7rem 0 0}
 .shot img{max-width:100%;max-height:22rem;border-radius:.5rem;border:1px solid var(--line);display:block}

 /* ---- actions ---- */
 .actions{
   display:flex;flex-wrap:wrap;gap:.45rem;
   margin-top:.9rem;padding-top:.8rem;border-top:1px solid var(--line-soft);
 }
 form.inline{display:inline;margin:0}
 button{
   font:inherit;font-size:.85rem;font-weight:600;
   min-height:2.3rem;padding:.45rem .9rem;
   border-radius:.45rem;border:1px solid var(--line);
   background:var(--panel);color:var(--ink);cursor:pointer;
 }
 button:hover{border-color:var(--muted)}
 button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
 .btn-ok{border-color:var(--ok-line);color:var(--ok)}
 .btn-ok:hover{border-color:var(--ok)}
 .btn-danger{border-color:var(--danger-line);color:var(--danger)}
 .btn-danger:hover{border-color:var(--danger)}
 .none{font-size:.77rem;color:var(--muted);margin:.9rem 0 0;padding-top:.8rem;border-top:1px solid var(--line-soft)}

 /* ---- empty + misc ---- */
 .empty{
   background:var(--panel);border:1px dashed var(--line);border-radius:.65rem;
   padding:3.5rem 1.5rem;text-align:center;
 }
 .empty .big{font-size:1.5rem;margin:0 0 .5rem;color:var(--muted)}
 .empty h3{margin:0 0 .35rem;font-size:.97rem;font-weight:650}
 .empty p{margin:0 auto;color:var(--muted);font-size:.86rem;max-width:44ch}
 .refused{background:var(--panel);border:1px solid var(--line);border-radius:.65rem;padding:1.4rem}
 .refused h1{margin:0 0 .5rem;font-size:1.05rem}
 .refused code{background:var(--code);padding:.15rem .4rem;border-radius:.3rem;font-size:.85rem}

 @media(max-width:52rem){
   .app{grid-template-columns:minmax(0,1fr)}
   .side{
     position:static;max-height:none;overflow:visible;
     border-right:0;border-bottom:1px solid var(--line);
     flex-direction:row;flex-wrap:wrap;align-items:center;
     gap:.5rem 1.1rem;padding:.85rem .9rem;
   }
   .brand{flex:1 1 100%}
   .grp{flex:1 1 14rem;padding:.25rem}
   .grp + .grp{margin-top:0}
   .grp nav{flex-direction:row;flex-wrap:wrap;gap:.25rem}
   .q{border-left:0;border-bottom:2px solid transparent;border-radius:.4rem .4rem 0 0}
   .q[aria-current="page"]{border-bottom-color:var(--accent)}
   .q .n{margin-left:.2rem;min-width:0}
   main{padding:1.15rem .9rem 4rem}
   .id{margin-left:0;width:100%}
   .actions button{flex:1 1 auto}
 }
</style>`;

function page(
  title: string, body: string, status = 200,
  extra: Record<string, string> = {}, aside = ''
): Response {
  // A standalone page (not found, refused) has no queue to be inside, so it
  // gets a centred column rather than an empty rail pretending there is one.
  const shell = aside
    ? `<div class="app">${aside}<main>${body}</main></div>`
    : `<div class="app solo"><main class="narrow">${brand()}${body}</main></div>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>${esc(title)}</title>${STYLE}</head><body>${shell}</body></html>`,
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
      ? `<div class="shot"><img src="${esc(href)}" alt="attachment"></div>`
      : `<p class="shot"><a href="${esc(href)}">${esc(a.name)}</a> <span class="tag">${esc(a.type)}</span></p>`;
  }).join('');
}

function actionsFor(state: string, id: string): string {
  // `spam` offers Restore and NOTHING else. There is no one-step path back to
  // a publishable state, by construction as well as by omission here.
  const buttons: Array<[ReviewAction, string, string]> =
    state === 'suspected_spam'
      ? [['release', 'Release', 'btn-ok'], ['confirm', 'Confirm spam', 'btn-danger']]
      : state === 'spam' ? [['restore', 'Restore for review', '']]
      : [];
  if (buttons.length === 0) {
    return '<p class="none">No actions available for this state.</p>';
  }
  return `<div class="actions">${buttons.map(([action, label, cls]) =>
    `<form class="inline" method="POST" action="/admin/review/${esc(id)}/${action}">
       <button type="submit" class="${cls}">${esc(label)}</button>
     </form>`).join('')}</div>`;
}

/** How long a row has been sitting, for the queues where that is the story. */
function waited(receivedAt: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - receivedAt) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function renderRow(row: any): string {
  const when = new Date(row.received_at).toISOString().replace('T', ' ').slice(0, 16);
  const badge = QUEUES[Object.keys(QUEUES).find((k) => QUEUES[k].state === row.state) ?? '']
    ?? { label: row.state, badge: 'b-failed' };
  const reviewed = row.spam_reviewed_at
    ? `<p class="note">Last decision ${esc(new Date(row.spam_reviewed_at).toISOString().replace('T', ' ').slice(0, 16))} UTC by ${esc(row.spam_reviewed_by ?? 'unknown')}</p>`
    : '';
  // Reason codes are the only thing that earns a chip. Reporter and score
  // used to be chips too, and a row of identical pills made a score read as a
  // verdict — it is telemetry, and it says so, quietly, in the meta line.
  const spammy = row.state === 'suspected_spam' || row.state === 'spam';
  const chips = spammy ? `<div class="chips">${renderReasons(row.spam_reasons)}</div>` : '';
  const meta = spammy
    ? `<p class="meta">reporter <b>${esc(row.reporter_kind ?? 'unknown')}</b>
       <span class="sep">\u00b7</span> score <b>${row.spam_score == null ? 'n/a' : esc(row.spam_score.toFixed(2))}</b>
       <span class="sep">\u00b7</span> telemetry, not the decision</p>`
    : `<p class="meta">reporter <b>${esc(row.reporter_kind ?? 'unknown')}</b>
       <span class="sep">\u00b7</span> waiting <b>${esc(waited(row.received_at))}</b>${
       row.attempts ? `\n       <span class="sep">\u00b7</span> attempt <b>${esc(String(row.attempts))}</b> of 5` : ''}</p>`;

  // WHY it is stuck, which is the only reason to open the deferred tab. The
  // page takes no credential, so this is truncated and never rendered as
  // markup — upstream error bodies are attacker-adjacent text like any other.
  const stuck = (row.state === 'deferred' || row.state === 'failed') && row.last_error
    ? `<p class="note">Last error: ${esc(String(row.last_error).slice(0, 160))}</p>`
    : '';

  // A quarantined row's body is already the redacted placeholder in the
  // database. Secret-material handling is untouched by the spam layer.
  return `<article class="card">
    <div class="card-head">
      <span class="badge ${esc(badge.badge)}">${esc(badge.label)}</span>
      <span class="when">${esc(when)} UTC</span>
      <code class="id">${esc(row.submission_id)}</code>
    </div>
    <div class="card-body">
      ${chips}
      ${meta}
      <pre>${esc(row.body_sanitized)}</pre>
      ${renderAttachments(row)}
      ${stuck}
      ${reviewed}
      ${actionsFor(row.state, row.submission_id)}
    </div>
  </article>`;
}

function sidebar(active: string, counts: Record<string, number>): string {
  // Groups are sections in a rail, each with its own colour and mark, because
  // two labels in identical type read as one list with a word in the middle.
  //
  // <details>, not a script: the toggle is native, keyboard-operable and
  // announced. Both render `open` every time — there is no script to remember
  // a collapse across a navigation, and a rail that reopened SOME groups and
  // not others would be a rail whose state you cannot predict.
  const groups = GROUPS.map(({ id, label, cls, icon }) => {
    const qs = Object.entries(QUEUES).filter(([, q]) => q.group === id);
    if (qs.length === 0) return '';
    return `<details class="grp ${cls}" open>
      <summary class="grp-l">
        <span class="grp-i">${icon}</span>${esc(label)}
        <span class="chev" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"
               stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>
        </span>
      </summary>
      <nav aria-label="${esc(label)}">
        ${qs.map(([q, { state, label: name }]) => {
          const n = counts[state] ?? 0;
          return `<a class="q" href="/admin/review?q=${q}"${q === active ? ' aria-current="page"' : ''}>${
            esc(name)}<span class="n${n === 0 ? ' zero' : ''}">${n}</span></a>`;
        }).join('')}
      </nav>
    </details>`;
  }).join('');
  return `<aside class="side">${brand()}${groups}</aside>`;
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
    if (!isUuidV4(id)) {
      return page('Review',
        `<div class="refused"><h1>Not found</h1>
         <p><a href="/admin/review?q=suspected">Back to the queue</a></p></div>`, 404);
    }

    const row = await env.DB.prepare('SELECT state FROM submissions WHERE submission_id = ?')
      .bind(id).first<{ state: string }>();
    if (!row) {
      return page('Review',
        `<div class="refused"><h1>Not found</h1>
         <p>That report is no longer in the queue.</p>
         <p><a href="/admin/review?q=suspected">Back to the queue</a></p></div>`, 404);
    }

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
        `<div class="refused">
           <h1>Action refused</h1>
           <p>The queue would not make that change: <code>${esc(result.reason)}</code></p>
           <p><a href="${esc(back)}">Back to the queue</a></p>
         </div>`, 409);
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
              spam_reasons, reporter_kind, spam_reviewed_at, spam_reviewed_by, attachment_keys,
              attempts, last_error
         FROM submissions WHERE state = ? ORDER BY received_at ASC LIMIT 100`
    ).bind(queue.state).all<any>();

    const rows = results ?? [];

    // One grouped read for every tab's count, not one query per tab. It is the
    // same index the queue list uses.
    const tally = await env.DB.prepare(
      'SELECT state, COUNT(*) AS n FROM submissions GROUP BY state'
    ).all<{ state: string; n: number }>();
    const counts: Record<string, number> = {};
    for (const r of tally.results ?? []) counts[r.state] = r.n;

    // Queues are listed SEPARATELY on purpose: a flood of correctly-caught
    // spam must never be able to bury one false positive in a mixed list.
    const shown = counts[queue.state] ?? 0;
    // Queues are listed SEPARATELY on purpose: a flood of correctly-caught
    // spam must never be able to bury one false positive in a mixed list.
    const body = `<div class="head">
        <h2>${esc(queue.label)}</h2>
        <p>${esc(queue.desc)}</p>
      </div>
      ${rows.length === 0
        ? `<div class="empty">
             <p class="big">${esc(queue.empty.icon)}</p>
             <h3>${esc(queue.empty.head)}</h3>
             <p>${esc(queue.empty.note)}</p>
           </div>`
        : rows.map((r) => renderRow(r)).join('')
          + (shown > rows.length
            ? `<p class="note">Showing the ${rows.length} that have waited longest, of ${shown}.</p>`
            : '')}`;
    return page(`Review \u2014 ${queue.label}`, body, 200, {}, sidebar(q, counts));
  }

  return page('Review',
    `<div class="refused"><h1>Not found</h1>
     <p><a href="/admin/review?q=suspected">Back to the queue</a></p></div>`, 404);
}
