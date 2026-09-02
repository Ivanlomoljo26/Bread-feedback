/**
 * The shell every admin page is rendered into — stylesheet, security headers,
 * escaping, the page frame and the navigation rail.
 *
 * It was extracted from review.ts when Store Reviews arrived, because the
 * console stopped being one page. The rail must look the same and carry the
 * same three groups whichever page you are on, and two copies of a rail is
 * two rails that drift.
 *
 * WHAT LIVES HERE: markup and CSS with no opinion about what is being listed.
 * WHAT DOES NOT: which queues exist, what they count, who may act on them.
 * A page passes in its own groups and its own counts; this file renders them.
 *
 * The two rules review.ts was built on are properties of this file now, and
 * every page that uses it inherits them:
 *
 *   1. ZERO JAVASCRIPT. Plain server-rendered HTML with <form method=POST>.
 *      A page with no script cannot be driven by injected content even if the
 *      escaping had a bug. It is also why the CSP can be `default-src 'none'`.
 *   2. Every value that came from outside is escaped, and bodies render inside
 *      <pre> — never as markup, never as a URL the page will fetch.
 */

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/**
 * `default-src 'none'` is possible only because these pages have no script, no
 * fonts and no third-party anything. `img-src 'self'` lets a screenshot render
 * through the attachment proxy and nothing else — in particular a body full of
 * image URLs cannot beacon out to an attacker's host.
 */
export function secureHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    // An admin page must never be cached anywhere: it is full of unpublished
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
   --g-store:#92400e; --g-store-bg:#fdf3e7; --g-store-line:#f0dcc0;
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
     --g-store:#f0b160; --g-store-bg:#241a0e; --g-store-line:#43331c;
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
 .g-store{--g:var(--g-store);--g-bg:var(--g-store-bg);--g-line:var(--g-store-line)}
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
   min-width:0;overflow-wrap:anywhere;
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
 .b-actionable{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
 .b-deferred{background:var(--warn-bg);color:var(--warn-ink);border-color:var(--warn-line)}

 /* Reason codes stay chips. Everything else is a quiet meta line — a row of
    identical pills makes a score look like a verdict, which it is not. */
 .chips{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;margin:0 0 .7rem}
 /* WHO said so, set apart from WHAT they said. As a chip among chips,
    "suggested" read as another label — the one thing it must not look like. */
 .chips-by{
   font-size:.66rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
   color:var(--muted);margin-right:.1rem;
 }
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

 /* ---- store reviews ---- */
 /* A rating is read at a glance or not at all, so it gets the tabular width
    of five glyphs whatever the score — a 2-star and a 5-star row must line up
    down the column, or scanning for the bad ones stops working. */
 .rating{font-size:.82rem;letter-spacing:.08em;color:var(--muted);white-space:nowrap}
 .r-low{color:var(--danger)}
 .rv-title{margin:0 0 .45rem;font-size:.95rem;font-weight:650;letter-spacing:-.01em}
 /* A redacted body must not look like an ordinary one. Same treatment the
    quarantine placeholder gets in the spam queue. */
 .redacted{color:var(--muted);font-style:italic}

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

/**
 * One brand for the whole console. It says Command Center rather than
 * "Feedback review" because the rail now reaches three places, only one of
 * which is the spam queue.
 */
export function brand(): string {
  return `<div class="brand">
    <span class="mark" aria-hidden="true">MF</span>
    <span class="brand-t">
      <strong>Feedback Command Center</strong>
      <small>Bread Wallet</small>
    </span>
  </div>`;
}

export function page(
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

/** One entry in the rail. `count` is rendered dimmed when it is zero. */
export interface NavItem {
  href: string;
  label: string;
  count: number;
  active: boolean;
}

/** One section of the rail. Each carries its own hue and mark. */
export interface NavGroup {
  id: string;
  label: string;
  cls: string;
  icon: string;
  items: NavItem[];
}

/**
 * Inline SVG, not emoji and not a webfont: the CSP is `default-src 'none'`
 * and a glyph that renders differently per platform is not an icon.
 */
const ICON = (path: string) =>
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"'
  + ' fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"'
  + ` stroke-linejoin="round">${path}</svg>`;

export const ICONS = {
  /** A star: what a store rating is. */
  store: ICON('<path d="M8 2.4l1.7 3.5 3.8.55-2.75 2.7.65 3.8L8 11.15l-3.4 1.8.65-3.8L2.5 6.45l3.8-.55z"/>'),
  /** An arrow moving through: something on its way somewhere. */
  delivery: ICON('<path d="M2.3 8h9.1"/><path d="M8.4 4.6 11.8 8l-3.4 3.4"/>'),
  /** A funnel: something being filtered out. */
  spam: ICON('<path d="M2.4 3.3h11.2l-4.3 5.1v4.3l-2.6-1.3V8.4z"/>'),
} as const;

/**
 * The rail.
 *
 * <details>, not a script: the toggle is native, keyboard-operable and
 * announced. Every group renders `open` — there is no script to remember a
 * collapse across a navigation, and a rail that reopened SOME groups and not
 * others would be a rail whose state you cannot predict.
 */
export function sidebar(groups: NavGroup[]): string {
  const rendered = groups.map(({ label, cls, icon, items }) => {
    if (items.length === 0) return '';
    return `<details class="grp ${esc(cls)}" open>
      <summary class="grp-l">
        <span class="grp-i">${icon}</span>${esc(label)}
        <span class="chev" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"
               stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>
        </span>
      </summary>
      <nav aria-label="${esc(label)}">
        ${items.map((it) =>
          `<a class="q" href="${esc(it.href)}"${it.active ? ' aria-current="page"' : ''}>${
            esc(it.label)}<span class="n${it.count === 0 ? ' zero' : ''}">${esc(String(it.count))}</span></a>`
        ).join('')}
      </nav>
    </details>`;
  }).join('');
  return `<aside class="side">${brand()}${rendered}</aside>`;
}
