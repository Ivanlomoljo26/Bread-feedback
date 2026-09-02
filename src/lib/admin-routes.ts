/**
 * The sign-in routes, and the page where access is granted.
 *
 * Four routes exist outside the gate, because a locked door needs a handle:
 * `/admin/login`, `/admin/auth/start`, `/admin/auth/callback`, `/admin/logout`.
 * Everything else under `/admin/` that a browser opens is behind it.
 *
 * `/admin/team` is inside the gate and is where the allowlist is edited: type
 * an address, press Grant. That is the whole of the invitation flow — there is
 * nothing to send, nothing to expire, and nothing for the person to set up.
 * They click "Continue with Google" and they are in.
 *
 * Same rules as every other page here: zero JavaScript, everything escaped,
 * CSP `default-src 'none'`.
 */
import { esc, page, secureHeaders } from './admin-chrome';
import {
  startSignIn, handleCallback, currentUser, isConfigured, normalizeEmail,
  csrfToken, csrfOk, signOutCookies, clearStateCookie, type AuthEnv, type AdminUser,
} from './admin-auth';

/** Paths that must work while signed OUT, or nobody can ever sign in. */
export const PUBLIC_ADMIN_PATHS = new Set([
  '/admin/login', '/admin/auth/start', '/admin/auth/callback', '/admin/logout',
]);

function shell(title: string, inner: string, status = 200, extra: Record<string, string> = {}): Response {
  return page(title, `<div class="refused">${inner}</div>`, status, extra);
}

/** The sign-in page. One button. */
function loginPage(message: string | null, status = 200, extra: Record<string, string> = {}): Response {
  // The brand block above the card already says Feedback Command Center;
  // repeating it as the heading just made the page say its own name twice.
  return shell('Sign in', `
    <h1>Sign in</h1>
    <p>This console holds unpublished user reports. Sign in with your Miden
       Google account to continue.</p>
    ${message ? `<p class="signin-error">${esc(message)}</p>` : ''}
    <p class="signin-actions"><a class="signin-btn" href="/admin/auth/start">Continue with Google</a></p>
    <p class="note">Access is granted per address. If you have not been added yet,
       ask whoever runs the console to add you — it takes one click and you do not
       need to do anything first.</p>`, status, extra);
}

/** Shown when the secrets are missing, so the failure names itself. */
function notConfigured(): Response {
  return shell('Sign in unavailable', `
    <h1>Sign-in is not configured</h1>
    <p>This deployment has no Google credentials, so nobody can sign in.
       Set <code>ADMIN_SESSION_SECRET</code>, <code>GOOGLE_OAUTH_CLIENT_ID</code>
       and <code>GOOGLE_OAUTH_CLIENT_SECRET</code>, then redeploy.</p>
    <p class="note">The console fails closed on purpose: with no credentials it
       admits nobody, rather than admitting everybody.</p>`, 503);
}

/**
 * The gate.
 *
 * Returns the signed-in user, or a Response to send instead. Called by index.ts
 * before any browser-facing admin route runs, so a new page is protected by
 * being under `/admin/` rather than by its author remembering to check.
 */
export async function requireAdmin(
  req: Request, env: AuthEnv, url: URL, nowMs: number
): Promise<{ user: AdminUser } | { response: Response }> {
  if (!isConfigured(env)) return { response: notConfigured() };

  const user = await currentUser(req, env, nowMs);
  if (user) return { user };

  // A signed-out GET goes to the sign-in page; anything else gets a plain 403.
  // Bouncing a POST to a login page would lose whatever it was submitting and
  // look, to the person, like the button silently did nothing.
  if (req.method !== 'GET') {
    return { response: shell('Signed out', `
      <h1>Signed out</h1>
      <p>Your session ended before that action was submitted. Sign in again and retry.</p>
      <p><a href="/admin/login">Sign in</a></p>`, 403) };
  }
  return { response: loginPage(null) };
}

/**
 * Handles the four unauthenticated routes. Returns null when the path is not
 * one of them.
 */
export async function handleAuthRoutes(
  req: Request, env: AuthEnv, url: URL, nowMs: number
): Promise<Response | null> {
  if (!PUBLIC_ADMIN_PATHS.has(url.pathname)) return null;

  if (url.pathname === '/admin/logout') {
    // POST only. A GET logout can be triggered by any image tag on any page,
    // which is not a security hole so much as a way to be signed out at random.
    if (req.method !== 'POST') return new Response(null, { status: 303, headers: { location: '/admin/login' } });
    const headers = new Headers(secureHeaders({ location: '/admin/login' }));
    for (const c of signOutCookies()) headers.append('set-cookie', c);
    return new Response(null, { status: 303, headers });
  }

  if (!isConfigured(env)) return notConfigured();

  if (url.pathname === '/admin/login') {
    // Already signed in? Do not show a sign-in page to somebody who is signed
    // in; send them where they were going.
    if (await currentUser(req, env, nowMs)) {
      return new Response(null, { status: 303, headers: { location: '/admin/review?q=suspected' } });
    }
    return loginPage(null);
  }

  if (url.pathname === '/admin/auth/start') {
    return startSignIn(env, url, nowMs);
  }

  // --- callback ------------------------------------------------------------
  const result = await handleCallback(req, env, url, nowMs);
  if (!result.ok) {
    // The one-time state cookie is cleared either way: it has been used, and a
    // failed attempt must not leave a reusable one behind.
    return loginPage(
      result.email ? `${result.reason} (${result.email})` : result.reason,
      403, { 'set-cookie': clearStateCookie() }
    );
  }

  const headers = new Headers(secureHeaders({ location: '/admin/review?q=suspected' }));
  headers.append('set-cookie', result.setCookie);
  headers.append('set-cookie', clearStateCookie());
  return new Response(null, { status: 303, headers });
}

// ---------------------------------------------------------------------------
// /admin/team — the allowlist
// ---------------------------------------------------------------------------

function teamPage(
  rows: any[], me: AdminUser, csrf: string, notice: string | null, status = 200
): Response {
  const when = (ms: number | null) =>
    ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '—';

  const list = rows.map((r) => {
    const disabled = r.disabled_at != null;
    const isMe = r.email === me.email;
    return `<tr${disabled ? ' class="row-off"' : ''}>
      <th scope="row">${esc(r.email)}${isMe ? ' <span class="tag">you</span>' : ''}</th>
      <td>${esc(r.name ?? '—')}</td>
      <td>${esc(when(r.last_seen_at))}</td>
      <td>${disabled ? `<span class="tag">removed ${esc(when(r.disabled_at))}</span>` : ''}</td>
      <td>${isMe
        // Removing yourself locks you out of the page that grants access. If
        // you are the only one left, nobody can undo it without a database.
        ? '<span class="note">you cannot remove yourself</span>'
        : `<form class="inline" method="POST" action="/admin/team/${disabled ? 'restore' : 'remove'}">
             <input type="hidden" name="csrf" value="${esc(csrf)}">
             <input type="hidden" name="email" value="${esc(r.email)}">
             <button type="submit" class="${disabled ? '' : 'btn-danger'}">${
               disabled ? 'Restore' : 'Remove'}</button>
           </form>`}</td>
    </tr>`;
  }).join('');

  return page('Team access', `
    <div class="head">
      <h2>Team access</h2>
      <p>Anyone listed here can sign in with their Google account. Adding an address
         is the whole of the invitation — there is nothing to send and nothing for
         them to set up.</p>
    </div>
    ${notice ? `<p class="signin-error">${esc(notice)}</p>` : ''}
    <form class="filters" method="POST" action="/admin/team/add">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <label class="fl grow"><span>Email address</span>
        <input type="email" name="email" required placeholder="name@miden.team"
               autocomplete="off" maxlength="200"></label>
      <div class="fl-actions"><button type="submit">Grant access</button></div>
    </form>
    <table class="kv"><tbody>${
      list || '<tr><td>Nobody has been granted access yet.</td></tr>'}</tbody></table>
    <p class="note">Signed in as ${esc(me.email)}.</p>
    <form class="inline" method="POST" action="/admin/logout">
      <button type="submit">Sign out</button>
    </form>`, status);
}

export async function handleTeam(
  req: Request, env: AuthEnv, url: URL, user: AdminUser, nowMs: number
): Promise<Response | null> {
  if (!url.pathname.startsWith('/admin/team')) return null;

  const csrf = await csrfToken(env, user.email);

  const render = async (notice: string | null = null, status = 200) => {
    const { results } = await env.DB.prepare(
      `SELECT email, name, added_at, disabled_at, last_seen_at
         FROM admin_allowed ORDER BY added_at DESC LIMIT 200`
    ).all<any>();
    return teamPage(results ?? [], user, csrf, notice, status);
  };

  if (url.pathname === '/admin/team' && req.method === 'GET') return render();

  const action = url.pathname.match(/^\/admin\/team\/(add|remove|restore)$/);
  if (!action || req.method !== 'POST') {
    return new Response(null, { status: 303, headers: { location: '/admin/team' } });
  }

  const form = await req.formData();
  if (!(await csrfOk(env, user.email, form.get('csrf')))) {
    return render('That request could not be verified. Reload the page and try again.', 403);
  }

  const email = normalizeEmail(form.get('email'));
  // Deliberately minimal: an address either has an @ with something on both
  // sides or it does not. Google is what actually proves the address exists;
  // a stricter regex here would only reject valid addresses.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return render('That does not look like an email address.', 400);
  }

  if (action[1] === 'add') {
    // Re-granting a removed address clears disabled_at rather than inserting a
    // second row — the same person coming back, not a new one.
    await env.DB.prepare(
      `INSERT INTO admin_allowed (email, added_at, added_by) VALUES (?,?,?)
       ON CONFLICT(email) DO UPDATE SET disabled_at = NULL, added_by = ?, added_at = ?`
    ).bind(email, nowMs, user.email, user.email, nowMs).run();
    return new Response(null, { status: 303, headers: { location: '/admin/team' } });
  }

  // You cannot remove yourself: this is the page that grants access, and the
  // last person out would lock the door behind them with the key inside.
  if (email === user.email) {
    return render('You cannot remove your own access.', 400);
  }

  await env.DB.prepare(
    'UPDATE admin_allowed SET disabled_at = ? WHERE email = ?'
  ).bind(action[1] === 'remove' ? nowMs : null, email).run();

  return new Response(null, { status: 303, headers: { location: '/admin/team' } });
}
