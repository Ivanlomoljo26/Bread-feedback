/**
 * Plan §10 tests 30-42 — the review queue (Phase 6).
 *
 * This is the highest-privilege surface in the service and it renders
 * attacker-controlled text, so the tests are weighted towards what must NOT
 * happen: no unauthenticated read of a report body or an attachment, no
 * one-step path from confirmed spam back to publishable, and no submitter
 * text reaching the page as markup.
 */
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  callWorker, runDrain, installFetchStub, restoreFetch, mockClassifier, mockCreateIssue,
  seedSubmission, getSubmission, getStateLog, resetGlobalGate, withEnv,
} from './helpers';
import { COOKIE_NAME } from '../src/lib/review-auth';

beforeAll(() => installFetchStub());
afterEach(() => { restoreFetch(); installFetchStub(); });
beforeEach(async () => { await resetGlobalGate(); });

const BASE = 'https://mfv2.test';

let ipCounter = 0;
/**
 * Each login presents a UNIQUE client IP.
 *
 * Sign-in is rate limited through the shared RateLimiter durable object keyed
 * on IP, and DO storage does not roll back between tests — so without this the
 * suite exhausts the hourly allowance partway through and later tests silently
 * receive a login page instead of the queue.
 */
async function login(token = 'test-review-token') {
  const form = new FormData();
  form.set('token', token);
  const res = await callWorker(new Request(`${BASE}/admin/review/login`, {
    method: 'POST', body: form,
    headers: { 'cf-connecting-ip': `10.0.0.${++ipCounter}` },
  }));
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { res, cookie: setCookie.split(';')[0] };
}

function get(path: string, cookie?: string) {
  return callWorker(new Request(`${BASE}${path}`, {
    method: 'GET', headers: cookie ? { cookie } : {},
  }));
}

async function post(path: string, cookie: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return callWorker(new Request(`${BASE}${path}`, { method: 'POST', headers: { cookie }, body: form }));
}

/** The CSRF token as the page itself renders it. */
async function csrfFrom(cookie: string, q = 'suspected'): Promise<string> {
  const html = await (await get(`/admin/review?q=${q}`, cookie)).text();
  return html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1] ?? '';
}

describe('review — authorization', () => {
  it('38. refuses every route without a session', async () => {
    const id = await seedSubmission({ state: 'suspected_spam', spam_status: 'suspected' });

    // The queue itself answers with a login form, not the reports.
    const queue = await get('/admin/review?q=suspected');
    const html = await queue.text();
    expect(html).not.toContain(id);
    expect(html).toContain('Reviewer token');

    for (const [path, method] of [
      [`/admin/review/${id}/release`, 'POST'],
      [`/admin/review/${id}/confirm`, 'POST'],
      [`/admin/review/${id}/restore`, 'POST'],
      [`/admin/review/attachment/${id}/shot.png`, 'GET'],
    ] as Array<[string, string]>) {
      const res = await callWorker(new Request(`${BASE}${path}`, { method }));
      expect(res.status, path).toBe(401);
    }
    // Nothing moved.
    expect((await getSubmission(id)).state).toBe('suspected_spam');
  });

  it('39. refuses a forged, tampered or expired cookie', async () => {
    const { cookie } = await login();
    const value = cookie.split('=').slice(1).join('=');
    const [expiry, sid, sig] = value.split('.');

    const bad = [
      `${COOKIE_NAME}=garbage`,
      `${COOKIE_NAME}=${expiry}.${sid}.${'0'.repeat(sig.length)}`,   // wrong signature
      `${COOKIE_NAME}=${Date.now() + 999999}.${sid}.${sig}`,         // expiry tampered
      `${COOKIE_NAME}=${Date.now() - 1000}.${sid}.${sig}`,           // expired AND resigned-looking
    ];
    for (const c of bad) {
      const res = await get('/admin/review?q=suspected', c);
      expect(await res.text(), c).toContain('Reviewer token');
    }
  });

  it('41. BACKFILL_TOKEN does not authorize anything here', async () => {
    // Every other /admin route is read-only or operational. Release is a write
    // authority that ends in a public issue, so it gets its own secret.
    const { res } = await login(env.BACKFILL_TOKEN as string);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBe(null);
  });

  it('41b. an unset REVIEW_TOKEN closes the queue rather than opening it', async () => {
    await withEnv({ REVIEW_TOKEN: '' }, async () => {
      const { res } = await login('');
      expect(res.status).toBe(401);
      const withEmpty = await get('/admin/review?q=suspected', `${COOKIE_NAME}=..`);
      expect(await withEmpty.text()).toContain('Reviewer token');
    });
  });

  it('42. the attachment proxy needs the session, and no public URL is ever rendered', async () => {
    const stored = JSON.stringify({
      key: 'attachments/x/shot.png', name: 'shot.png', type: 'image/png',
      size: 4, githubUrl: 'https://github.example/leaked.png',
      r2Url: 'https://r2.example/leaked.png', video: false,
    });
    const id = await seedSubmission({
      state: 'suspected_spam', spam_status: 'suspected', attachment_keys: JSON.stringify([stored]),
    });

    expect((await get(`/admin/review/attachment/${id}/shot.png`)).status).toBe(401);

    const { cookie } = await login();
    const html = await (await get('/admin/review?q=suspected', cookie)).text();
    // Rendered through the proxy only. A guessable public link to an
    // unreviewed report's screenshot would defeat the whole page.
    expect(html).toContain(`/admin/review/attachment/${id}/shot.png`);
    expect(html).not.toContain('r2.example');
    expect(html).not.toContain('github.example');
  });

  it('42b. the proxy will not serve an attachment belonging to another submission', async () => {
    const { cookie } = await login();
    const other = JSON.stringify({ key: 'attachments/secret/other.png', name: 'other.png', type: 'image/png', size: 1, githubUrl: null, r2Url: null, video: false });
    await seedSubmission({ state: 'suspected_spam', attachment_keys: JSON.stringify([other]) });
    const mine = await seedSubmission({ state: 'suspected_spam', attachment_keys: '[]' });

    // The R2 key comes from the ROW, never the URL, so naming someone else's
    // file selects nothing rather than reaching it.
    for (const name of ['other.png', '../secret/other.png', '..%2Fsecret%2Fother.png']) {
      const res = await get(`/admin/review/attachment/${mine}/${encodeURIComponent(name)}`, cookie);
      expect(res.status, name).toBe(404);
    }
  });
});

describe('review — actions', () => {
  it('40. records the acting session on a release, and writes its own audit row', async () => {
    const { cookie } = await login();
    const id = await seedSubmission({ state: 'suspected_spam', spam_status: 'suspected' });
    const csrf = await csrfFrom(cookie);

    const res = await post(`/admin/review/${id}/release`, cookie, { csrf });
    expect(res.status).toBe(303);

    const row = await getSubmission(id);
    expect(row.state).toBe('received');
    expect(row.spam_status).toBe('clean');
    expect(row.spam_reviewed_by).toMatch(/^session:[0-9a-f]{16}$/);
    expect(row.spam_reviewed_at).toBeGreaterThan(0);

    // 36 — every review action writes its own state_log row.
    const log = await getStateLog(id);
    expect(log[log.length - 1]).toMatchObject({ from_state: 'suspected_spam', to_state: 'received' });
    expect(log[log.length - 1].detail).toContain('review:release');
  });

  it('30. a released report re-enters the pipeline and publishes', async () => {
    const { cookie } = await login();
    const id = await seedSubmission({ state: 'suspected_spam', spam_status: 'suspected' });
    await post(`/admin/review/${id}/release`, cookie, { csrf: await csrfFrom(cookie) });

    mockClassifier();
    mockCreateIssue(4400);
    await runDrain();

    const row = await getSubmission(id);
    expect(row.state).toBe('published');
    expect(row.published_issue).toBe(4400);
  });

  it('33/34. confirmed spam needs TWO separate actions to become publishable', async () => {
    const { cookie } = await login();
    const id = await seedSubmission({ state: 'spam', spam_status: 'spam' });

    // No route offers a one-step path, and asking for one directly is refused.
    const direct = await post(`/admin/review/${id}/release`, cookie, { csrf: await csrfFrom(cookie, 'spam') });
    expect(direct.status).toBe(409);
    expect((await getSubmission(id)).state).toBe('spam');

    // The page offers Restore and nothing else.
    const spamHtml = await (await get('/admin/review?q=spam', cookie)).text();
    expect(spamHtml).toContain('Restore for review');
    expect(spamHtml).not.toContain('>Release<');

    // Step one: restore. Still gated -- 'suspected', not 'clean'.
    await post(`/admin/review/${id}/restore`, cookie, { csrf: await csrfFrom(cookie, 'spam') });
    let row = await getSubmission(id);
    expect(row.state).toBe('suspected_spam');
    expect(row.spam_status).toBe('suspected');

    // 32 — still not drain-eligible after a restore.
    mockClassifier();
    mockCreateIssue(4401);
    await runDrain();
    expect((await getSubmission(id)).state).toBe('suspected_spam');

    // Step two, a separate action, before it can publish.
    await post(`/admin/review/${id}/release`, cookie, { csrf: await csrfFrom(cookie) });
    row = await getSubmission(id);
    expect(row.state).toBe('received');
    expect(row.spam_status).toBe('clean');
  });

  it('36b. confirm writes its own audit row too', async () => {
    const { cookie } = await login();
    const id = await seedSubmission({ state: 'suspected_spam', spam_status: 'suspected' });

    await post(`/admin/review/${id}/confirm`, cookie, { csrf: await csrfFrom(cookie) });

    const row = await getSubmission(id);
    expect(row.state).toBe('spam');
    expect(row.spam_status).toBe('spam');
    expect((await getStateLog(id)).pop().detail).toContain('review:confirm');
  });

  it('36c. an action without a valid CSRF token is refused', async () => {
    const { cookie } = await login();
    const id = await seedSubmission({ state: 'suspected_spam', spam_status: 'suspected' });

    for (const csrf of ['', 'nope', '0'.repeat(64)]) {
      const res = await post(`/admin/review/${id}/release`, cookie, { csrf });
      expect(res.status, csrf).toBe(403);
    }
    expect((await getSubmission(id)).state).toBe('suspected_spam');
  });

  it('37. a quarantined row shows the redaction and offers no action', async () => {
    const { cookie } = await login();
    const id = await seedSubmission({
      state: 'quarantined', body_sanitized: '[redacted — secret material detected]',
    });

    const html = await (await get('/admin/review?q=quarantined', cookie)).text();
    expect(html).toContain('[redacted');
    expect(html).toContain('No actions available');
    expect(html).not.toContain('>Release<');
    expect(html).not.toContain('>Restore for review<');
  });
});

describe('review — rendering safety', () => {
  it('35. renders a body containing markup as text, never as markup', async () => {
    const { cookie } = await login();
    const nasty = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
    const id = await seedSubmission({
      state: 'suspected_spam', spam_status: 'suspected', body_sanitized: nasty,
    });

    const html = await (await get('/admin/review?q=suspected', cookie)).text();

    // The danger is an unescaped TAG, not the attribute text -- the escaped
    // form legitimately contains the substring `onerror=alert(2)` as inert
    // characters inside a <pre>. Assert on what a browser would actually parse.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    // Quotes and ampersands escaped too, or an attribute could be broken out of.
    expect(html).toContain('&quot;&#39;&amp;');
    expect(html).toContain(id);
  });

  it('35b. sends headers that neutralise the page even if escaping failed', async () => {
    const { cookie } = await login();
    const res = await get('/admin/review?q=suspected', cookie);

    const csp = res.headers.get('content-security-policy') ?? '';
    // No script can run at all -- the page has none, so this costs nothing and
    // makes an escaping bug unexploitable rather than merely unlikely.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain('script-src');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    // Unpublished user reports must not sit in any cache.
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('35c. the session cookie is HttpOnly, Secure and SameSite=Strict', async () => {
    const res = (await login()).res;
    const c = res.headers.get('set-cookie') ?? '';
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Strict');
    // Scoped so it is never attached to /submit or /status.
    expect(c).toContain('Path=/admin/review');
  });

  it('35d. queues are listed separately so spam cannot bury a false positive', async () => {
    const { cookie } = await login();
    const suspected = await seedSubmission({ state: 'suspected_spam', spam_status: 'suspected' });
    const confirmed = await seedSubmission({ state: 'spam', spam_status: 'spam' });

    const sHtml = await (await get('/admin/review?q=suspected', cookie)).text();
    expect(sHtml).toContain(suspected);
    expect(sHtml).not.toContain(confirmed);

    const cHtml = await (await get('/admin/review?q=spam', cookie)).text();
    expect(cHtml).toContain(confirmed);
    expect(cHtml).not.toContain(suspected);
  });
});
