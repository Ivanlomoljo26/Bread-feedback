/**
 * Ingest Worker. Validate → scan → sanitize → persist → enqueue → 202.
 *
 * Holds no GitHub write credential. Cannot create an issue.
 */

import { verifyTurnstile, verifyHmac, sha256Hex, isUuidV4 } from './lib/validate';
import { scanForSecrets } from './lib/secret-scan';
import { sanitize } from './lib/sanitize';
import { inferErrorCode, fingerprint } from './lib/fingerprint';
import { storeAttachment, validateFile } from './lib/attachments';

export interface Env {
  DB: D1Database;
  TRIAGE_QUEUE: Queue;
  ATTACHMENTS: R2Bucket;
  RATE_LIMITER: DurableObjectNamespace;
  PUBLISH_GATE: DurableObjectNamespace;
  TURNSTILE_SECRET: string;
  INGEST_HMAC_KEY: string;
  /** Classic token, scope `public_repo` ONLY. Never one reaching private repos. */
  GITHUB_WRITE_TOKEN: string;
  R2_PUBLIC_BASE?: string;
  LLM_API_KEY_PRIMARY: string;
  LLM_API_KEY_FALLBACK: string;
  TARGET_REPO: string;
  OPERATOR_HANDLE: string;
  PUBLISH_ENABLED: string;
  CAP_PER_HOUR: string;
  CAP_PER_DAY: string;
  DUP_THRESHOLD: string;
  REVIEW_THRESHOLD: string;
  COMMENT_THRESHOLD: string;
  MARKER_PREFIX: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      // Exposes cap consumption so the kill switch and volume budget are
      // observable without opening the dashboard.
      const gate = env.PUBLISH_GATE.get(env.PUBLISH_GATE.idFromName('global'));
      const status = await (await gate.fetch('https://gate/status')).json();
      return json({ ok: true, publish: status });
    }
    // Lets the form's "Your reports" list resolve submission ids to issue
    // numbers. Returns nothing but the issue number and state — no bodies,
    // no other submitters' data.
    if (url.pathname === '/status' && req.method === 'GET') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(isUuidV4).slice(0, 25);
      if (!ids.length) return json({ results: {}, repo: env.TARGET_REPO });
      const rows = await env.DB.prepare(
        `SELECT submission_id, state, published_issue, matched_issue
           FROM submissions WHERE submission_id IN (${ids.map(() => '?').join(',')})`
      ).bind(...ids).all();
      const results: Record<string, { state: string; issue: number | null }> = {};
      for (const r of rows.results ?? []) {
        results[(r as any).submission_id] = {
          state: (r as any).state,
          issue: (r as any).published_issue ?? (r as any).matched_issue ?? null,
        };
      }
      // The repo travels with the results so the form never hardcodes it —
      // wrangler.jsonc stays the single source of truth across cutover.
      return json({ results, repo: env.TARGET_REPO });
    }

    if (url.pathname !== '/submit' || req.method !== 'POST') return json({ error: 'not found' }, 404);

    // multipart/form-data: text fields plus at most one attachment
    let form: FormData;
    try { form = await req.formData(); } catch { return json({ error: 'bad form data' }, 400); }

    const submission_id = form.get('submission_id');
    const body = form.get('body');
    const platform = form.get('platform');
    const turnstile_token = form.get('turnstile_token');
    let meta: any = {};
    try { meta = JSON.parse((form.get('meta') as string) ?? '{}'); } catch { /* optional */ }
    meta.platform = typeof platform === 'string' ? platform : null;

    if (!isUuidV4(submission_id)) return json({ error: 'bad submission_id' }, 400);
    if (typeof body !== 'string' || body.trim().length < 10) return json({ error: 'body too short' }, 400);
    if (!['android', 'mobile', 'extension'].includes(meta.platform)) {
      return json({ error: 'bad platform' }, 400);
    }

    const attachment = form.get('attachment');
    if (attachment instanceof File && attachment.size > 0) {
      const bad = validateFile(attachment);
      if (bad) return json({ error: bad }, 413);
    }

    const ip = req.headers.get('cf-connecting-ip') ?? undefined;
    if (!turnstile_token || !(await verifyTurnstile(turnstile_token, env.TURNSTILE_SECRET, ip))) {
      return json({ error: 'challenge failed' }, 403);
    }

    // 2. Rate limit (per install if provided, else per IP)
    const rlKey = typeof meta.install_id === 'string' ? `i:${meta.install_id}` : `ip:${ip ?? 'unknown'}`;
    const rl = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(rlKey));
    const rlRes = await rl.fetch('https://rl/check');
    if (rlRes.status === 429) return json({ error: 'rate limited' }, 429);

    // 3. Secret scan BEFORE storing. Quarantine, never log the value.
    const hits = scanForSecrets(body);
    const now = Date.now();

    if (hits.length > 0) {
      await env.DB.prepare(
        `INSERT INTO submissions (submission_id, received_at, state, body_sanitized, body_hash, quarantine_reason)
         VALUES (?, ?, 'quarantined', '[redacted — secret material detected]', ?, ?)
         ON CONFLICT(submission_id) DO NOTHING`
      ).bind(submission_id, now, await sha256Hex(body), hits.map((h) => h.kind).join(',')).run();

      // Deliberately a 202: do not tell a potential attacker what tripped it,
      // and do not alarm a legitimate user who pasted a phrase by accident.
      return json({ ok: true, submission_id, status: 'received' }, 202);
    }

    // 4. Sanitize + classify structurally
    const clean = sanitize(body);
    const errorCode = inferErrorCode(clean);
    const fp = fingerprint({
      errorCode,
      walletVersion: meta.wallet_version,
      platform: meta.platform,
      route: meta.route,
    });

    // 5. Attachment — only after the text passed the secret scan.
    //    The user was warned twice in the form; we still keep a durable copy
    //    in R2 so a leaked file can be revoked even after it reaches GitHub.
    let attachmentKeys: string[] = [];
    if (attachment instanceof File && attachment.size > 0) {
      const stored = await storeAttachment(attachment, submission_id, env as any);
      attachmentKeys = [JSON.stringify(stored)];
    }

    // 6. Idempotency layer 1
    const res = await env.DB.prepare(
      `INSERT INTO submissions
         (submission_id, received_at, state, body_sanitized, body_hash,
          wallet_version, platform, network, route, error_code, fingerprint, attachment_keys)
       VALUES (?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id) DO NOTHING`
    ).bind(
      submission_id, now, clean, await sha256Hex(body),
      meta.wallet_version ?? null, meta.platform ?? null, meta.network ?? null,
      meta.route ?? null, errorCode, fp, JSON.stringify(attachmentKeys)
    ).run();

    // Already seen — a retry, not a new report. Do not re-enqueue.
    if (res.meta.changes === 0) return json({ ok: true, submission_id, status: 'duplicate_submission' }, 200);

    await env.DB.prepare(
      `INSERT INTO state_log (submission_id, at, from_state, to_state, detail) VALUES (?, ?, NULL, 'received', ?)`
    ).bind(submission_id, now, fp).run();

    await env.TRIAGE_QUEUE.send({ submission_id });

    return json({ ok: true, submission_id, status: 'received' }, 202);
  },
};

/** Sliding-window limiter: 5 per hour per key. */
export class RateLimiter {
  constructor(private state: DurableObjectState) {}
  async fetch(): Promise<Response> {
    const now = Date.now();
    const windowMs = 3_600_000;
    const limit = 5;
    const hits = ((await this.state.storage.get<number[]>('hits')) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) return new Response('rate limited', { status: 429 });
    hits.push(now);
    await this.state.storage.put('hits', hits);
    return new Response('ok');
  }
}

export { PublishGate } from './lib/gate';
export { scheduled } from './cron';
export { default as consumerHandlers } from './consumer';
