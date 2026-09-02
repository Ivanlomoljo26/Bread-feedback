/**
 * The half of the SameSite fix that a unit test cannot prove.
 *
 * WHY THIS EXISTS. `SameSite=Strict` on the OAuth state cookie shipped, passed
 * every unit test, and would have failed on the first real sign-in: Google
 * returns the browser by a TOP-LEVEL CROSS-SITE NAVIGATION, and a Strict cookie
 * is withheld on exactly that. The suite missed it because it sets the `Cookie`
 * header by hand — fabricating the thing under test. Only a real browser with a
 * real cookie jar, crossing a real site boundary, can tell the two apart.
 *
 * IT CHECKS ITSELF FOR VACUITY FIRST. If the two origins turn out NOT to be
 * cross-site as far as the browser is concerned, then a Strict cookie would be
 * sent too, and the Lax assertion would pass with the bug still in place. So
 * the CONTROL runs first: cross-site to a page that needs the Strict session
 * cookie. That page MUST show sign-in. If it shows the queue, the boundary is
 * not real and this script FAILS as inconclusive rather than reporting a pass
 * it did not earn.
 *
 *   Worker      http://localhost:<port>     (site A)
 *   Bounce page http://127.0.0.1:<port>     (site B — different host, so a
 *                                            different site for cookies)
 *
 * Usage:
 *   npx wrangler dev --port 8787 --local        # in another terminal
 *   node test/browser/oauth-samesite.mjs        # PORT=8787 by default
 *
 * Needs a signed-in session to run the control, so it seeds one the same way
 * the vitest helpers do: HMAC over `email.expiry` with ADMIN_SESSION_SECRET
 * from .dev.vars.
 */
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from '/home/jovan_lomoljo/wallet/node_modules/playwright/index.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const BOUNCE_PORT = Number(process.env.BOUNCE_PORT ?? 8899);
const WORKER = `http://localhost:${PORT}`;
const BOUNCE = `http://127.0.0.1:${BOUNCE_PORT}`;
const EMAIL = process.env.ADMIN_EMAIL ?? 'ivan.l@miden.team';

function devVar(name) {
  const raw = fs.readFileSync(new URL('../../.dev.vars', import.meta.url), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not in .dev.vars`);
  return line.slice(name.length + 1).trim();
}

const secret = devVar('ADMIN_SESSION_SECRET');
const payload = `${EMAIL}.${Date.now() + 3_600_000}`;
const sessionToken = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;

/** Site B: one page per link, so each click is a top-level navigation. */
const bounce = http.createServer((req, res) => {
  const target = new URL(req.url, BOUNCE).searchParams.get('to') ?? WORKER;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta charset=utf-8><a id=go href="${target}">go</a>`);
});

const fail = (msg) => { console.error(`\n  FAIL  ${msg}\n`); process.exitCode = 1; };
const pass = (msg) => console.log(`  ok    ${msg}`);

await new Promise((r) => bounce.listen(BOUNCE_PORT, '127.0.0.1', r));
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

// Google is never contacted. /admin/auth/start only has to SET the cookie;
// where it redirects afterwards is not what is being tested.
await ctx.route('**://accounts.google.com/**', (route) =>
  route.fulfill({ status: 200, body: 'google stub' }));

try {
  const page = await ctx.newPage();

  // --- arrange: a session cookie (Strict) and a state cookie (Lax) ---------
  await ctx.addCookies([{
    name: '__Host-mfv2_admin', value: sessionToken,
    // domain+path, NOT url. A `__Host-` cookie carries no Domain attribute, and
    // CDP rejects the url form for one ("Invalid cookie fields"); the explicit
    // pair is the shape it accepts. Secure over http is fine here because
    // browsers treat localhost as a trustworthy origin.
    domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Strict',
  }]);

  await page.goto(`${WORKER}/admin/auth/start`);
  const state = (await ctx.cookies()).find((c) => c.name === '__Host-mfv2_oauth')?.value;
  if (!state) {
    fail('no __Host-mfv2_oauth cookie was set by /admin/auth/start');
    throw new Error('cannot continue without a state cookie');
  }
  pass('/admin/auth/start set a state cookie');

  // --- control: is this boundary actually cross-site? ----------------------
  // The session cookie is Strict. Crossing from site B, the browser must
  // withhold it. If it does not, the two origins are the same site here and
  // nothing below would mean anything.
  await page.goto(`${BOUNCE}/?to=${encodeURIComponent(`${WORKER}/admin/review?q=suspected`)}`);
  await page.click('#go');
  const afterControl = await page.content();

  if (!afterControl.includes('Continue with Google')) {
    fail('INCONCLUSIVE: the Strict session cookie survived the hop, so '
       + `${BOUNCE} and ${WORKER} are the same site to this browser. `
       + 'This script cannot distinguish Strict from Lax here — run it against '
       + 'a preview deployment on two real hostnames instead.');
    throw new Error('control failed');
  }
  pass('control: Strict cookie IS withheld across the boundary (it is genuinely cross-site)');

  // --- the actual test: does the Lax state cookie survive the same hop? ----
  const callback = `${WORKER}/admin/auth/callback?state=${encodeURIComponent(state)}`;
  await page.goto(`${BOUNCE}/?to=${encodeURIComponent(callback)}`);
  await page.click('#go');
  const body = await page.content();

  if (body.includes('did not match this browser')) {
    fail('the state cookie was WITHHELD on the cross-site return — this is the '
       + 'SameSite=Strict bug, and no real Google sign-in would complete.');
  } else if (body.includes('did not return a sign-in code')) {
    // The state matched, so the cookie arrived; the flow then stopped for the
    // only remaining reason, which is that this test never supplies a code.
    pass('the Lax state cookie SURVIVED the cross-site return — sign-in can complete');
  } else {
    fail(`unexpected callback response; first 200 chars:\n${
      body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
} catch (err) {
  if (process.exitCode !== 1) fail(String(err?.message ?? err));
} finally {
  await browser.close();
  bounce.close();
}

console.log(process.exitCode === 1 ? '\nSameSite smoke test FAILED' : '\nSameSite smoke test passed');
