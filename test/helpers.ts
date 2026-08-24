/** Shared fixtures for the Phase 0 regression suite. */
import {
  env, createExecutionContext, waitOnExecutionContext, createScheduledController,
} from 'cloudflare:test';
import worker from '../src/index';

/**
 * Outbound HTTP is stubbed at globalThis.fetch rather than through the pool's
 * undici mock agent. Two reasons: the `fetchMock` export was removed in pool
 * v0.22 / vitest 4, and a plain stub can assert that a call did NOT happen —
 * which is the entire point of the kill-switch test.
 */
export interface RecordedCall { url: string; method: string; body: string | null }

type Route = { match: (url: URL, method: string) => boolean; respond: (body: string | null) => Response };

let routes: Route[] = [];
let calls: RecordedCall[] = [];
let realFetch: typeof globalThis.fetch | null = null;

export function installFetchStub(): void {
  if (realFetch === null) realFetch = globalThis.fetch;
  routes = [];
  calls = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    // Only JSON bodies are captured. Turnstile posts multipart/form-data and
    // reading that as text makes workerd log a corruption warning for nothing.
    const ct = req.headers.get('content-type') ?? '';
    const body = ['POST', 'PATCH', 'PUT'].includes(method) && ct.includes('json')
      ? await req.clone().text()
      : null;
    calls.push({ url: req.url, method, body });
    for (const r of routes) if (r.match(url, method)) return r.respond(body);
    throw new Error(`unmocked outbound fetch: ${method} ${req.url}`);
  }) as typeof globalThis.fetch;
}

export function restoreFetch(): void {
  if (realFetch) globalThis.fetch = realFetch;
  routes = [];
  calls = [];
}

export function recordedCalls(): RecordedCall[] { return calls; }

export function callsTo(host: string): RecordedCall[] {
  return calls.filter((c) => new URL(c.url).host === host);
}

function route(r: Route) { routes.push(r); }

export const REPO = '0xMiden/wallet';

/**
 * Unit-style invocation rather than SELF.fetch: the worker then runs in the
 * test isolate, which is where fetchMock intercepts outbound calls.
 */
export async function callWorker(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Drives the drain. Any cron string EXCEPT the mirror's runs drain(). */
export async function runDrain(): Promise<void> {
  const ctx = createExecutionContext();
  const controller = createScheduledController({ cron: '* * * * *' });
  await worker.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

/**
 * Clears the global publish gate's rolling write log.
 *
 * REQUIRED in beforeEach for any suite that publishes. Durable Object storage
 * does NOT roll back between tests in this pool — verified with
 * `vitest run --sequence.shuffle`, where an unreset gate made tests 7/10/11
 * fail whenever they ran after the cap test. The DO's own /reset endpoint
 * exists for exactly this (it was written for production cutover).
 */
export async function resetGlobalGate(): Promise<void> {
  const gate = env.PUBLISH_GATE.get(env.PUBLISH_GATE.idFromName('global'));
  await gate.fetch('https://gate/reset', { method: 'POST' });
}

/**
 * Spends global publish-gate slots until it refuses. Independent of whatever
 * CAP_PER_HOUR is configured to, which matters because the Durable Object
 * reads its own env from miniflare and a test cannot mutate it.
 */
export async function exhaustGlobalGate(limit = 500): Promise<number> {
  const gate = env.PUBLISH_GATE.get(env.PUBLISH_GATE.idFromName('global'));
  for (let i = 0; i < limit; i++) {
    const d = await (await gate.fetch('https://gate/check?scope=global')).json<any>();
    if (!d.allowed) return i;
  }
  throw new Error(`global gate still open after ${limit} writes`);
}

export interface SubmitOverrides {
  submission_id?: string;
  body?: string;
  platform?: string | null;
  turnstile_token?: string | null;
  install_id?: string | null;
  meta?: Record<string, unknown>;
  attachment?: File;
}

export function submitRequest(over: SubmitOverrides = {}): Request {
  const form = new FormData();
  if (over.submission_id !== undefined) form.set('submission_id', over.submission_id);
  else form.set('submission_id', crypto.randomUUID());

  form.set('body', over.body ?? 'The wallet balance is wrong after I send a private note.');
  if (over.platform !== null) form.set('platform', over.platform ?? 'android');
  if (over.turnstile_token !== null) form.set('turnstile_token', over.turnstile_token ?? 'tok');

  const meta: Record<string, unknown> = { ...(over.meta ?? {}) };
  if (over.install_id !== null) meta.install_id = over.install_id ?? crypto.randomUUID();
  form.set('meta', JSON.stringify(meta));

  if (over.attachment) form.set('attachment', over.attachment);

  return new Request('https://mfv2.test/submit', { method: 'POST', body: form });
}

/** Turnstile siteverify. Persistent — the limiter tests submit repeatedly. */
export function mockTurnstile(opts: { ok?: boolean; codes?: string[] } = {}) {
  const { ok = true, codes = [] } = opts;
  route({
    match: (u, m) => u.host === 'challenges.cloudflare.com' && m === 'POST',
    respond: () => Response.json({ success: ok, 'error-codes': codes }),
  });
}

export interface VerdictOverrides {
  verdict?: 'new' | 'duplicate' | 'uncertain';
  issue_number?: number | null;
  confidence?: number;
  title?: string;
  rationale?: string;
  suggested_labels?: string[];
}

/** One Anthropic response shaped like the real Messages API. */
export function mockClassifier(v: VerdictOverrides = {}) {
  const payload = {
    verdict: v.verdict ?? 'new',
    issue_number: v.issue_number ?? null,
    confidence: v.confidence ?? 0.9,
    rationale: v.rationale ?? 'test verdict',
    suggested_labels: v.suggested_labels ?? [],
    title: v.title ?? 'Balance is wrong after sending a private note',
  };
  route({
    match: (u, m) => u.host === 'api.anthropic.com' && m === 'POST',
    respond: () => Response.json({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      stop_reason: 'end_turn',
      model: 'claude-haiku-4-5-20251001',
    }),
  });
}

/** Both keys fail — classify() throws and the drain must defer. */
export function mockClassifierDown() {
  route({
    match: (u, m) => u.host === 'api.anthropic.com' && m === 'POST',
    respond: () => new Response('upstream boom', { status: 500 }),
  });
}

export function mockCreateIssue(number: number) {
  route({
    match: (u, m) => u.host === 'api.github.com' && m === 'POST'
      && u.pathname === `/repos/${REPO}/issues`,
    respond: () => Response.json({ number }, { status: 201 }),
  });
}

export function mockCreateComment(issue: number, id: number) {
  route({
    match: (u, m) => u.host === 'api.github.com' && m === 'POST'
      && u.pathname === `/repos/${REPO}/issues/${issue}/comments`,
    respond: () => Response.json({ id }, { status: 201 }),
  });
}

export function mockUpdateComment(commentId: number) {
  route({
    match: (u, m) => u.host === 'api.github.com' && m === 'PATCH'
      && u.pathname === `/repos/${REPO}/issues/comments/${commentId}`,
    respond: () => Response.json({ id: commentId }),
  });
}

/** The JSON body of the single POST that created an issue. */
export function issueCreateBody(): any {
  const c = calls.find((x) => x.method === 'POST' && x.url.endsWith(`/repos/${REPO}/issues`));
  return c?.body ? JSON.parse(c.body) : null;
}

/** The JSON body of the comment POST on a given issue. */
export function commentBody(issue: number): any {
  const c = calls.find((x) => x.method === 'POST' && x.url.endsWith(`/issues/${issue}/comments`));
  return c?.body ? JSON.parse(c.body) : null;
}

// ---- D1 read helpers -------------------------------------------------------

export async function getSubmission(id: string) {
  return env.DB.prepare('SELECT * FROM submissions WHERE submission_id = ?').bind(id).first<any>();
}

export async function countSubmissions(): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getDupLinks(id: string) {
  const r = await env.DB.prepare('SELECT * FROM dup_links WHERE submission_id = ?').bind(id).all<any>();
  return r.results ?? [];
}

export async function getStateLog(id: string) {
  const r = await env.DB.prepare(
    'SELECT from_state, to_state, detail FROM state_log WHERE submission_id = ? ORDER BY id'
  ).bind(id).all<any>();
  return r.results ?? [];
}

/** Seeds an issue into the mirror so retrieval has something to offer. */
export async function seedMirrorIssue(opts: {
  number: number; title: string; body?: string; state?: string; marker?: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO issue_mirror (number, title, body, state, labels, author, created_at, updated_at, marker, synced_at)
     VALUES (?,?,?,?,'[]','tester',?,?,?,?)`
  ).bind(
    opts.number, opts.title, opts.body ?? 'seeded issue body', opts.state ?? 'open',
    Date.now(), Date.now(), opts.marker ?? null, Date.now()
  ).run();
}

/** Puts a row straight into `received`, skipping ingest. */
export async function seedSubmission(over: Record<string, unknown> = {}): Promise<string> {
  const id = (over.submission_id as string) ?? crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO submissions
       (submission_id, received_at, state, body_sanitized, body_hash, wallet_version,
        platform, network, route, error_code, fingerprint, reporter_key, attachment_keys, attempts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
  ).bind(
    id,
    (over.received_at as number) ?? Date.now(),
    (over.state as string) ?? 'received',
    (over.body_sanitized as string) ?? 'The wallet cannot reach the node after an update.',
    (over.body_hash as string) ?? 'hash-' + id,
    (over.wallet_version as string) ?? '1.15.19',
    (over.platform as string) ?? 'android',
    (over.network as string) ?? 'testnet',
    (over.route as string) ?? '/send',
    over.error_code === undefined ? 'NODE_UNREACHABLE' : (over.error_code as string),
    (over.fingerprint as string) ?? 'NODE_UNREACHABLE|1.15|android|/send',
    (over.reporter_key as string) ?? 'reporter-' + id,
    (over.attachment_keys as string) ?? '[]'
  ).run();
  return id;
}

/** Temporarily override an env var for one test. */
export async function withEnv<T>(patch: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = (env as any)[k];
    (env as any)[k] = v;
  }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(prev)) (env as any)[k] = v; }
}
