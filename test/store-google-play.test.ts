/**
 * Phase 1 — Google Play sync: the key file, the token, the page request, and
 * the cron that runs them.
 *
 * Google is never called. Each test either passes its own fetch to the code
 * under test, or registers routes on the shared stub, and a real RSA key is
 * generated per run so signatures are checked rather than assumed.
 *
 * Three properties matter more than the rest, because each fails silently in
 * production and loudly nowhere else:
 *   GP8   a page larger than requested is a failure, never a partial write
 *   GP12  a full page of new reviews fits the free plan's 50-query limit
 *   GP14  every registered cron has a dispatch string, and the reverse
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import wranglerConfig from '../wrangler.jsonc?raw';
import { callsTo, installFetchStub, restoreFetch, route, runCron, seedSubmission, withEnv } from './helpers';
import { DRAIN_CRON, MIRROR_CRON, STORE_CRON } from '../src/crons';
import {
  ANDROID_PUBLISHER_SCOPE, GOOGLE_TOKEN_URL, GoogleAuthError,
  mintAccessToken, parseServiceAccount, signServiceAccountJwt,
} from '../src/store/auth/google';
import {
  D1_QUERIES_PER_INVOCATION, GOOGLE_PLAY_PAGE_SIZE, GooglePlayError,
  googlePlayFetcher, syncGooglePlay,
} from '../src/store/sync/google';
import { STORE_TICK_MS, phaseFor } from '../src/store/cron';
import { loadCheckpoint } from '../src/store/checkpoint';

const PKG = 'com.miden.wallet';
const NOW = 1_788_300_000_000;
const SA_EMAIL = 'reviews-sync@bread-test.iam.gserviceaccount.com';
/** Planted in key material and upstream prose; must never reach an error. */
const MARKER = 'KEY-MATERIAL-MARKER-7c1e';

let keyFile: string;
let pem: string;
let publicKey: CryptoKey;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64url(part: string): Uint8Array {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

beforeAll(async () => {
  installFetchStub();

  // A real key, wrapped the way Google Cloud's key file wraps it — including a
  // token_uri pointing somewhere it must never be sent.
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  ) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  pem = `-----BEGIN PRIVATE KEY-----\n${toBase64(der).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  keyFile = JSON.stringify({
    type: 'service_account', project_id: 'bread-test', private_key_id: 'k1',
    private_key: pem, client_email: SA_EMAIL,
    token_uri: 'https://attacker.example/token',
  }, null, 2);
});

async function clearStoreTables() {
  await env.DB.prepare('DELETE FROM store_review_events').run();
  await env.DB.prepare('DELETE FROM store_review_versions').run();
  await env.DB.prepare('DELETE FROM store_reviews').run();
  await env.DB.prepare('DELETE FROM store_sync_state').run();
}

beforeEach(clearStoreTables);
afterEach(async () => {
  restoreFetch();
  installFetchStub();
  // After, too: the console's empty state reads store_sync_state, and CI runs
  // the suite shuffled.
  await clearStoreTables();
});

/** A review in the shape `reviews.list` documents. */
function review(id: string, text = 'Private send fails since the update.') {
  return {
    reviewId: id,
    authorName: 'A. Tester',
    comments: [{
      userComment: {
        text,
        lastModified: { seconds: '1788190000', nanos: 0 },
        starRating: 3,
        reviewerLanguage: 'en',
        appVersionCode: 11519,
        appVersionName: '1.15.19',
      },
    }],
  };
}

const page = (reviews: unknown[], next?: string) =>
  Response.json({ reviews, ...(next ? { tokenPagination: { nextPageToken: next } } : {}) });

type Call = { url: URL; init?: RequestInit };

/** Stands in for Google: the token endpoint, and a list answered per page token. */
function fakeGoogle(list: (token: string | null) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.host === 'oauth2.googleapis.com') {
      return Response.json({ access_token: 'ya29.test-token', expires_in: 3599, token_type: 'Bearer' });
    }
    if (url.host === 'androidpublisher.googleapis.com') return list(url.searchParams.get('token'));
    throw new Error(`unexpected fetch: ${input}`);
  };
  return { fetchImpl, calls };
}

const syncEnv = (over: Record<string, string | undefined> = {}) => ({
  DB: env.DB,
  STORE_SYNC_ENABLED: 'true',
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: keyFile,
  GOOGLE_PLAY_PACKAGE_NAME: PKG,
  ...over,
});

/** Wraps D1 and counts every statement executed — the unit the free plan limits. */
function countingDb(db: D1Database) {
  let n = 0;
  const statement = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, {
    get(target, prop) {
      if (prop === 'bind') return (...args: unknown[]) => statement((target as any).bind(...args));
      if (prop === 'run' || prop === 'first' || prop === 'all' || prop === 'raw') {
        return (...args: unknown[]) => { n += 1; return (target as any)[prop](...args); };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => statement(target.prepare(sql));
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) => { n += stmts.length; return target.batch(stmts); };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, count: () => n };
}

describe('the key file', () => {
  it('GP1. reads the key file as downloaded, and as a form that flattened it', () => {
    const sa = parseServiceAccount(keyFile);
    expect(sa.clientEmail).toBe(SA_EMAIL);
    expect(sa.pkcs8.length).toBeGreaterThan(1000);

    // One line, with the key's line breaks surviving only as the characters "\n".
    const flattened = JSON.stringify({ ...JSON.parse(keyFile), private_key: pem.replace(/\n/g, '\\n') });
    expect(parseServiceAccount(flattened).pkcs8).toEqual(sa.pkcs8);
  });

  it('GP2. a malformed key never quotes itself into an error', () => {
    const cases = [
      `{"private_key": "${MARKER}`,
      JSON.stringify({ client_email: SA_EMAIL, private_key: `-----BEGIN PRIVATE KEY-----\n${MARKER}!!\n-----END PRIVATE KEY-----` }),
      JSON.stringify({ private_key: pem, note: MARKER }),
    ];
    for (const raw of cases) {
      let message = '';
      try {
        parseServiceAccount(raw);
      } catch (err) {
        expect(err).toBeInstanceOf(GoogleAuthError);
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(MARKER);
    }

    const pkcs1 = JSON.stringify({
      client_email: SA_EMAIL,
      private_key: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----',
    });
    expect(() => parseServiceAccount(pkcs1)).toThrow(/PKCS#1/);
    expect(() => parseServiceAccount('')).toThrow(/not set/);
  });
});

describe('signing in to Google', () => {
  it('GP3. the JWT is RS256, scoped to the Play API, and verifies against the key', async () => {
    const jwt = await signServiceAccountJwt(parseServiceAccount(keyFile), NOW);
    const [header, claims, signature] = jwt.split('.');
    const text = new TextDecoder();

    expect(JSON.parse(text.decode(fromBase64url(header)))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(text.decode(fromBase64url(claims)))).toEqual({
      iss: SA_EMAIL,
      scope: ANDROID_PUBLISHER_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 3600,
    });

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', publicKey, fromBase64url(signature), new TextEncoder().encode(`${header}.${claims}`)
    );
    expect(valid).toBe(true);
  });

  it("GP4. the token request goes to Google's pinned endpoint, never the key file's token_uri", async () => {
    const google = fakeGoogle(() => page([]));
    const token = await mintAccessToken(parseServiceAccount(keyFile), NOW, google.fetchImpl);

    expect(token).toBe('ya29.test-token');
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0].url.toString()).toBe(GOOGLE_TOKEN_URL);
    const form = new URLSearchParams(String(google.calls[0].init?.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')?.split('.')).toHaveLength(3);
  });

  it("GP5. a refused key reports the status and Google's code, never Google's prose", async () => {
    const refuse = async () => Response.json(
      { error: 'invalid_grant', error_description: `Invalid JWT Signature ${MARKER}` }, { status: 400 }
    );
    const err = await mintAccessToken(parseServiceAccount(keyFile), NOW, refuse).catch((e) => e);

    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.message).toBe('Google refused the Play key (HTTP 400, invalid_grant)');
    expect(err.message).not.toContain(MARKER);
  });
});

describe('reading a page of reviews', () => {
  it('GP6. maps reviews and the next token, asking Google for one page-size', async () => {
    const google = fakeGoogle((token) => (token === 't2' ? page([]) : page([review('a'), review('b')], 't2')));
    const fetchPage = googlePlayFetcher(PKG, async () => 'ya29.test-token', google.fetchImpl);

    const first = await fetchPage(null);
    expect(first.items).toHaveLength(2);
    expect(first.nextToken).toBe('t2');

    const req = google.calls[0];
    expect(req.url.pathname).toBe(`/androidpublisher/v3/applications/${PKG}/reviews`);
    expect(req.url.searchParams.get('maxResults')).toBe(String(GOOGLE_PLAY_PAGE_SIZE));
    expect(req.url.searchParams.has('token')).toBe(false);
    expect(new Headers(req.init?.headers).get('authorization')).toBe('Bearer ya29.test-token');

    expect(await fetchPage('t2')).toEqual({ items: [], nextToken: null });
    expect(google.calls[1].url.searchParams.get('token')).toBe('t2');

    // An app with no reviews at all answers with an empty object.
    const empty = googlePlayFetcher(PKG, async () => 't', async () => Response.json({}));
    expect(await empty(null)).toEqual({ items: [], nextToken: null });
  });

  it('GP7. a stale cursor restarts the pass instead of wedging the sync', async () => {
    const google = fakeGoogle((token) => (token
      ? Response.json({ error: { status: 'INVALID_ARGUMENT' } }, { status: 400 })
      : page([review('a')], 'fresh')));
    const fetchPage = googlePlayFetcher(PKG, async () => 't', google.fetchImpl);

    expect(await fetchPage('expired')).toEqual({ items: [review('a')], nextToken: 'fresh' });
    expect(google.calls.map((c) => c.url.searchParams.get('token'))).toEqual(['expired', null]);

    // If the first page is refused too, that is a real failure and it says so.
    const broken = googlePlayFetcher(PKG, async () => 't', async () =>
      Response.json({ error: { status: 'INVALID_ARGUMENT' } }, { status: 400 }));
    await expect(broken('expired')).rejects.toThrow('HTTP 400, INVALID_ARGUMENT');
  });

  it('GP8. more reviews than asked for fails loudly, and nothing moves', async () => {
    const tooMany = Array.from({ length: GOOGLE_PLAY_PAGE_SIZE + 1 }, (_, i) => review(`over-${i}`));
    const google = fakeGoogle(() => page(tooMany, 'next'));

    const result = await syncGooglePlay(syncEnv(), NOW, env.DB, google.fetchImpl);

    expect(result.report?.error).toContain('asking for at most');
    expect(result.report?.created).toBe(0);
    const cp = await loadCheckpoint(env.DB, `google_play:${PKG}`);
    expect(cp?.consecutive_failures).toBe(1);
    expect(cp?.cursor).toBeNull();
    const stored = await env.DB.prepare('SELECT COUNT(*) AS n FROM store_reviews').first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it("GP9. a refused page reports the status and code, never the token or Google's prose", async () => {
    const denied = googlePlayFetcher(PKG, async () => 'ya29.secret-token', async () => Response.json(
      { error: { code: 403, status: 'PERMISSION_DENIED', message: 'ya29.secret-token lacks access' } }, { status: 403 }
    ));
    const err = await denied(null).catch((e) => e);
    expect(err).toBeInstanceOf(GooglePlayError);
    expect(err.message).toBe('reviews.list failed (HTTP 403, PERMISSION_DENIED)');
    expect(err.message).not.toContain('ya29');

    const garbled = googlePlayFetcher(PKG, async () => 't', async () => new Response('<html>', { status: 200 }));
    await expect(garbled(null)).rejects.toThrow('not JSON');
  });
});

describe('a sync run', () => {
  it('GP10. switched off or unconfigured, a run calls nobody and writes nothing', async () => {
    const google = fakeGoogle(() => page([review('a')]));
    for (const over of [
      { STORE_SYNC_ENABLED: 'false' },
      { STORE_SYNC_ENABLED: 'TRUE' },
      { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: undefined },
      { GOOGLE_PLAY_PACKAGE_NAME: '' },
    ]) {
      const result = await syncGooglePlay(syncEnv(over), NOW, env.DB, google.fetchImpl);
      expect(result.report).toBeNull();
      expect(result.skipped).toBeTruthy();
    }
    expect(google.calls).toHaveLength(0);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM store_sync_state').first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('GP11. a run stores one page and checkpoints where Google left off', async () => {
    const google = fakeGoogle((token) => (token === 't2' ? page([review('c')]) : page([review('a'), review('b')], 't2')));

    const first = await syncGooglePlay(syncEnv(), NOW, env.DB, google.fetchImpl);
    expect(first.report).toMatchObject({ created: 2, rejected: 0, pages: 1, error: null });
    let cp = await loadCheckpoint(env.DB, `google_play:${PKG}`);
    expect(cp).toMatchObject({ cursor: 't2', last_success_at: NOW, consecutive_failures: 0 });

    const second = await syncGooglePlay(syncEnv(), NOW + STORE_TICK_MS, env.DB, google.fetchImpl);
    expect(second.report).toMatchObject({ created: 1, rejected: 0, exhausted: true });
    cp = await loadCheckpoint(env.DB, `google_play:${PKG}`);
    expect(cp?.cursor).toBeNull();

    // One token and one page per run.
    expect(google.calls.filter((c) => c.url.host === 'oauth2.googleapis.com')).toHaveLength(2);
    expect(google.calls.filter((c) => c.url.host === 'androidpublisher.googleapis.com')).toHaveLength(2);
  });

  it('GP11b. a key that will not parse is a failed run, recorded without the key', async () => {
    const google = fakeGoogle(() => page([review('a')]));
    const result = await syncGooglePlay(
      syncEnv({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: `{"private_key":"${MARKER}` }), NOW, env.DB, google.fetchImpl
    );

    expect(result.report?.error).toContain('not valid JSON');
    expect(google.calls).toHaveLength(0);
    const cp = await loadCheckpoint(env.DB, `google_play:${PKG}`);
    expect(cp?.consecutive_failures).toBe(1);
    expect(cp?.last_error).not.toContain(MARKER);
  });

  it("GP12. SYNC-BUDGET: a full page of brand-new reviews stays inside the free plan's query limit", async () => {
    // All-new is the worst case: a new review costs the most statements.
    const fresh = Array.from({ length: GOOGLE_PLAY_PAGE_SIZE }, (_, i) => review(`new-${i}`, `Review number ${i}`));
    const google = fakeGoogle(() => page(fresh, 'more'));
    const counted = countingDb(env.DB);

    const result = await syncGooglePlay(syncEnv(), NOW, counted.db, google.fetchImpl);

    expect(result.report?.created).toBe(GOOGLE_PLAY_PAGE_SIZE);
    // Positive control: the counter really sees the writes.
    expect(counted.count()).toBeGreaterThan(GOOGLE_PLAY_PAGE_SIZE);
    expect(counted.count()).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
    // Outbound: one token, one page.
    expect(google.calls).toHaveLength(2);
  });
});

describe('the store cron', () => {
  it('GP13. the store trigger reaches the Google Play sync, and does not run the drain', async () => {
    const id = await seedSubmission({ state: 'received' });
    route({
      match: (u, m) => u.host === 'oauth2.googleapis.com' && m === 'POST',
      respond: () => Response.json({ access_token: 'ya29.test-token', expires_in: 3599 }),
    });
    route({
      match: (u, m) => u.host === 'androidpublisher.googleapis.com' && m === 'GET',
      respond: () => page([review('cron-1')]),
    });

    try {
      await withEnv(
        { STORE_SYNC_ENABLED: 'true', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: keyFile },
        () => runCron(STORE_CRON)
      );

      expect(callsTo('oauth2.googleapis.com')).toHaveLength(1);
      expect(callsTo('androidpublisher.googleapis.com')).toHaveLength(1);
      const stored = await env.DB.prepare('SELECT source, app_id FROM store_reviews WHERE platform_review_id = ?')
        .bind('cron-1').first<{ source: string; app_id: string }>();
      expect(stored).toEqual({ source: 'google_play', app_id: PKG });

      const sub = await env.DB.prepare('SELECT state FROM submissions WHERE submission_id = ?')
        .bind(id).first<{ state: string }>();
      expect(sub?.state).toBe('received');
    } finally {
      await env.DB.prepare('DELETE FROM submissions WHERE submission_id = ?').bind(id).run();
    }
  });

  it('GP14. SYNC-WIRING: every registered cron has a dispatch string, and every string a trigger', () => {
    // Read exactly the way scripts/deploy.sh reads it: whole-line comments
    // stripped, then JSON.parse. An inline comment or a trailing comma fails
    // here instead of failing the deploy.
    const config = JSON.parse(wranglerConfig.replace(/^\s*\/\/.*$/gm, ''));

    expect([...config.triggers.crons].sort()).toEqual([DRAIN_CRON, MIRROR_CRON, STORE_CRON].sort());
    expect(config.secrets.required).toContain('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    // Sync is the one stage that ships ON (SAFETY-CONTROLS.md §12).
    expect(config.vars.STORE_SYNC_ENABLED).toBe('true');
    expect(config.vars.GOOGLE_PLAY_PACKAGE_NAME).toBe(PKG);
  });

  it('GP15. phases rotate by the clock, one per five-minute slot', () => {
    const a = { name: 'a', run: async () => ({ skipped: 'a', report: null }) };
    const b = { name: 'b', run: async () => ({ skipped: 'b', report: null }) };
    const slot = (n: number) => n * STORE_TICK_MS;

    expect([0, 1, 2, 3].map((n) => phaseFor(slot(n), [a, b]).name)).toEqual(['a', 'b', 'a', 'b']);
    // A tick that fires late, inside the same slot, runs the same phase.
    expect(phaseFor(slot(1) + 59_000, [a, b]).name).toBe('b');
    expect(phaseFor(slot(7)).name).toBe('sync:google_play');
  });
});
