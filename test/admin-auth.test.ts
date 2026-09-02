/**
 * Admin sign-in: Google, against an allowlist of email addresses.
 *
 * This file is mostly about what the gate REFUSES. A door is not described by
 * the people it lets through.
 *
 * The reversal it encodes: `/admin/review` took no credential at all between
 * 2026-08-25 and 2026-09-02 — a deliberate decision, correct while the
 * repository was private and one person used it. The repository is public and
 * the team is bigger, so the route is discoverable from source and its buttons
 * publish things nobody can take back.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  callWorker, installFetchStub, restoreFetch, route,
  seedAdmin, adminCookie, adminCsrf, adminHeaders, ADMIN_EMAIL,
} from './helpers';

const BASE = 'https://mfv2.test';
const CLIENT_ID = 'test-google-client';

beforeAll(() => installFetchStub());
afterEach(() => { restoreFetch(); installFetchStub(); });
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM admin_allowed').run();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  callWorker(new Request(`${BASE}${path}`, { method: 'GET', headers }));

/** base64url, no padding — what a JWT payload actually is. */
const b64url = (o: unknown) => btoa(JSON.stringify(o))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A Google ID token with whatever claims the test wants to try. */
function idToken(over: Record<string, unknown> = {}): string {
  const claims = {
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: ADMIN_EMAIL,
    email_verified: true,
    name: 'Ivan Lomoljo',
    ...over,
  };
  return `${b64url({ alg: 'RS256' })}.${b64url(claims)}.signature-not-checked`;
}

function mockGoogleToken(token: string | null, ok = true) {
  route({
    match: (u: URL, m: string) => u.host === 'oauth2.googleapis.com' && m === 'POST',
    respond: () => ok
      ? Response.json(token ? { id_token: token } : {})
      : new Response('nope', { status: 400 }),
  });
}

/** Drives the full redirect round trip and returns the callback's response. */
async function signInWith(token: string | null, ok = true) {
  mockGoogleToken(token, ok);
  const start = await get('/admin/auth/start');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  return callWorker(new Request(
    `${BASE}/admin/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    { headers: { cookie } }
  ));
}

describe('the session cannot be faked', () => {
  it('A20. the page names the account to use, and never says "welcome back"', async () => {
    // Access is invite-only, so the FIRST visit is the common case: everyone
    // who reaches this page reaches it for the first time once, usually just
    // after being added and told to go and sign in. Greeting them as a
    // returning user is wrong exactly when it matters most.
    const html = await (await get('/admin/review?q=suspected')).text();
    expect(html.toLowerCase()).not.toContain('welcome back');
    // And it says WHICH account — people have several Google accounts, and
    // picking the personal one fails with no hint about why.
    expect(html).toContain('@miden.team account');
  });

  it('A1. a cookie with a wrong signature is not a session', async () => {
    await seedAdmin();
    const real = await adminCookie();
    // Flip the last character of the signature. Everything else is valid.
    const forged = real.slice(0, -1) + (real.endsWith('a') ? 'b' : 'a');

    const res = await get('/admin/review?q=suspected', { cookie: forged });
    expect(await res.text()).toContain('Continue with Google');
  });

  it('A2. a well-signed session that has expired is not a session', async () => {
    await seedAdmin();
    // The expiry lives INSIDE the signed payload, not only in the cookie's
    // Max-Age: a Max-Age is a request to the browser, and a replayed cookie
    // never sees one.
    const stale = await adminCookie(ADMIN_EMAIL, -1000);
    const res = await get('/admin/review?q=suspected', { cookie: stale });
    expect(await res.text()).toContain('Continue with Google');
  });

  it('A3. a session for an address nobody added is not a session', async () => {
    // Correctly signed, unexpired, and for an address that is not on the list.
    const res = await get('/admin/review?q=suspected', {
      cookie: await adminCookie('stranger@miden.team'),
    });
    expect(await res.text()).toContain('Continue with Google');
  });

  it('A4. the cookie carries every flag it needs', async () => {
    await seedAdmin();
    const res = await signInWith(idToken());
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-');       // no sibling subdomain can set it
    expect(cookie).toContain('HttpOnly');      // script cannot read it
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
  });
});

describe('what Google says is checked, not assumed', () => {
  it('A5. an unverified address is refused', async () => {
    await seedAdmin();
    // Anyone can put any address on an account until Google confirms it.
    const res = await signInWith(idToken({ email_verified: false }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('has not verified');
  });

  it('A6. a token minted for another application is refused', async () => {
    await seedAdmin();
    // A perfectly valid Google token for somebody else's app.
    const res = await signInWith(idToken({ aud: 'some-other-app.apps.googleusercontent.com' }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('audience');
  });

  it('A7. an expired token is refused', async () => {
    await seedAdmin();
    const res = await signInWith(idToken({ exp: Math.floor(Date.now() / 1000) - 60 }));
    expect(res.status).toBe(403);
  });

  it('A8. a mismatched state is refused', async () => {
    await seedAdmin();
    mockGoogleToken(idToken());
    // No state cookie: the shape of somebody completing a sign-in flow in
    // another person's browser.
    const res = await callWorker(new Request(
      `${BASE}/admin/auth/callback?code=abc&state=made-up`));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('did not match this browser');
  });

  it('A9. an address off the allowlist is refused, and told exactly why', async () => {
    const res = await signInWith(idToken({ email: 'outsider@miden.team' }));
    expect(res.status).toBe(403);
    const html = await res.text();
    // This is an internal console, not a public sign-up. Hiding whether an
    // address is listed protects nobody and leaves the person guessing at
    // something an admin fixes in one click.
    expect(html).toContain('does not have access yet');
    expect(html).toContain('outsider@miden.team');
  });

  it('A10. the domain fence holds even if the allowlist is wrong', async () => {
    // Belt and braces: the allowlist grants access, and this stops a typo in it
    // from ever admitting an outside address.
    await seedAdmin('someone@gmail.com');
    const res = await signInWith(idToken({ email: 'someone@gmail.com' }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('allowed domain');
  });

  it('A11. addresses are matched case-insensitively', async () => {
    await seedAdmin(ADMIN_EMAIL);
    const res = await signInWith(idToken({ email: 'Ivan.L@Miden.Team' }));
    // One human, not two rows, and removing one must not leave the other working.
    expect(res.status).toBe(303);
  });

  it('A12. a signed-in reviewer lands in the queue', async () => {
    await seedAdmin();
    const res = await signInWith(idToken());
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/review?q=suspected');
  });
});

describe('granting and removing access', () => {
  const postTeam = async (path: string, fields: Record<string, string>, csrf = true) => {
    const form = new FormData();
    if (csrf) form.set('csrf', await adminCsrf());
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return callWorker(new Request(`${BASE}${path}`, {
      method: 'POST', body: form, headers: { cookie: (await adminHeaders()).cookie },
    }));
  };

  it('A13. adding an address is the whole of the invitation', async () => {
    await seedAdmin();
    const res = await postTeam('/admin/team/add', { email: 'teammate@miden.team' });
    expect(res.status).toBe(303);

    const row = await env.DB.prepare('SELECT * FROM admin_allowed WHERE email = ?')
      .bind('teammate@miden.team').first<any>();
    expect(row).toBeTruthy();
    expect(row.added_by).toBe(ADMIN_EMAIL);
    // They can sign in immediately. Nothing was sent, nothing to accept.
    expect((await signInWith(idToken({ email: 'teammate@miden.team' }))).status).toBe(303);
  });

  it('A14. removing keeps the row, so who HAD access is still answerable', async () => {
    await seedAdmin();
    await postTeam('/admin/team/add', { email: 'teammate@miden.team' });
    await postTeam('/admin/team/remove', { email: 'teammate@miden.team' });

    const row = await env.DB.prepare('SELECT disabled_at FROM admin_allowed WHERE email = ?')
      .bind('teammate@miden.team').first<any>();
    expect(row.disabled_at).toBeTruthy();   // disabled, not deleted
    expect((await signInWith(idToken({ email: 'teammate@miden.team' }))).status).toBe(403);
  });

  it('A15. re-adding a removed person restores them rather than duplicating them', async () => {
    await seedAdmin();
    await postTeam('/admin/team/add', { email: 'teammate@miden.team' });
    await postTeam('/admin/team/remove', { email: 'teammate@miden.team' });
    await postTeam('/admin/team/add', { email: 'teammate@miden.team' });

    const { results } = await env.DB.prepare(
      'SELECT disabled_at FROM admin_allowed WHERE email = ?').bind('teammate@miden.team').all<any>();
    expect(results).toHaveLength(1);
    expect(results[0].disabled_at).toBeNull();
  });

  it('A16. you cannot remove your own access', async () => {
    await seedAdmin();
    // This is the page that grants access. The last person out would lock the
    // door behind them with the key inside.
    const res = await postTeam('/admin/team/remove', { email: ADMIN_EMAIL });
    expect(res.status).toBe(400);
    const row = await env.DB.prepare('SELECT disabled_at FROM admin_allowed WHERE email = ?')
      .bind(ADMIN_EMAIL).first<any>();
    expect(row.disabled_at).toBeNull();
  });

  it('A17. granting access without the CSRF token is refused', async () => {
    await seedAdmin();
    const res = await postTeam('/admin/team/add', { email: 'attacker@miden.team' }, false);
    expect(res.status).toBe(403);
    expect(await env.DB.prepare('SELECT email FROM admin_allowed WHERE email = ?')
      .bind('attacker@miden.team').first()).toBeNull();
  });
});

describe('the gate does not break what it does not cover', () => {
  it('A18. script endpoints still use their token, not a browser session', async () => {
    // /admin/backfill and friends are called by scripts, which have no browser
    // to sign in with. Putting them behind the session would break them.
    const res = await callWorker(new Request(`${BASE}/admin/quarantined`, {
      headers: { authorization: 'Bearer test-backfill-token' },
    }));
    expect(res.status).toBe(200);
  });

  it('A19. /submit is untouched — reporters never sign in', async () => {
    // The whole point of the boundary: this gate is for the console, and the
    // feedback form must not have acquired a login.
    const res = await callWorker(new Request(`${BASE}/submit`, { method: 'POST', body: new FormData() }));
    expect([400, 403]).toContain(res.status);   // rejected on its own terms
    expect(await res.text()).not.toContain('Continue with Google');
  });
});
