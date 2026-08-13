/**
 * Ingest Worker. Validate → scan → sanitize → persist → 202.
 *
 * Persisting IS the handoff: a row in state `received` is picked up by the
 * drain cron within a minute. There is no queue to enqueue to — see
 * docs/ARCHITECTURE.md for why, and tag `queue-design` for the version that
 * used one.
 *
 * The fetch handler holds no GitHub write credential path of its own; only
 * the scheduled handler publishes.
 */

import { drain } from './drain';
import { syncMirror, EMBED_BATCH } from './cron';
import { embedMissing } from './lib/embed';
import { verifyTurnstile, verifyHmac, sha256Hex, isUuidV4, timingSafeEqual } from './lib/validate';
import { scanForSecrets } from './lib/secret-scan';
import { sanitize } from './lib/sanitize';
import { inferErrorCode, fingerprint } from './lib/fingerprint';
import { storeAttachment, validateFile } from './lib/attachments';

export interface Env {
  DB: D1Database;
  /** Workers AI — embeddings for paraphrase-aware dedup. Free tier. */
  AI: Ai;
  ATTACHMENTS: R2Bucket;
  RATE_LIMITER: DurableObjectNamespace;
  PUBLISH_GATE: DurableObjectNamespace;
  TURNSTILE_SECRET: string;
  INGEST_HMAC_KEY: string;
  /**
   * Guards /admin/backfill. A SEPARATE secret, deliberately — INGEST_HMAC_KEY
   * ships inside the client bundle, so gating an operator route on it would
   * let anyone who opened devtools drive the mirror sync.
   */
  BACKFILL_TOKEN: string;
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
  /** Submissions claimed per drain tick. Bounded by the free plan's 50
   *  subrequests per invocation — one submission can spend six or seven. */
  DRAIN_BATCH_SIZE: string;
  /** Error retries before a submission is parked in state `failed`. */
  MAX_ATTEMPTS: string;
}

/** Must match the mirror entry in wrangler.jsonc `triggers.crons` exactly. */
const MIRROR_CRON = '*/15 * * * *';

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

    /**
     * One-shot mirror backfill. Pulls EVERY issue, open and closed, then
     * embeds a bounded batch.
     *
     * Call it repeatedly until `remaining` is 0. It is not a single long run
     * on purpose: the free plan allows 10 ms CPU and 50 subrequests per
     * invocation, so a few hundred issues cannot be embedded in one pass.
     * Idempotent — the upsert and the embedding fill are both safe to repeat.
     *
     *   curl -X POST https://<worker>/admin/backfill \
     *        -H "authorization: Bearer $BACKFILL_TOKEN"
     */
    if (url.pathname === '/admin/backfill' && req.method === 'POST') {
      const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      // Constant-time: a length-leaking === on a bearer token is a free oracle.
      if (!env.BACKFILL_TOKEN || !timingSafeEqual(auth, env.BACKFILL_TOKEN)) {
        return json({ error: 'unauthorized' }, 401);
      }
      // syncMirror runs its own embedding pass, so this request embeds in two
      // passes and must report their SUM. Reporting only the second one made a
      // successful backfill look like it had done nothing.
      const sync = await syncMirror(env, true);
      const second = await embedMissing(env, EMBED_BATCH);
      return json({
        ok: true,
        // Issues fetched from GitHub. A full sync refetches all of them, so
        // this does not shrink on repeat calls and is not a change count.
        synced: sync.issues,
        embedded: sync.embedded + second.embedded,
        // Fresh COUNT taken after both passes. `remaining > 0` means call
        // again — it is not an error.
        remaining: second.remaining,
      });
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

    // 1. OPTIONAL signature. NOT an ingress control — Turnstile below is.
    //
    //    The key ships inside the client bundle, which the wallet distributes
    //    as an extension and a mobile app, so anyone can extract it and sign
    //    anything. Requiring it would stop no attacker and would falsely read
    //    like authentication in review. It is verified only when supplied, to
    //    catch a broken or forked client sending malformed requests — a wrong
    //    signature is a bug signal, an absent one is normal.
    //
    //    Do not promote this back to a requirement. If ingest ever needs real
    //    authentication, it needs a credential the client does not hold.
    const bodyHash = await sha256Hex(body);
    const signature = req.headers.get('x-mfv2-signature');
    if (signature) {
      const canonical = `mfv2.v1\n${submission_id}\n${bodyHash}\n${meta.platform}`;
      if (!(await verifyHmac(canonical, signature, env.INGEST_HMAC_KEY))) {
        return json({ error: 'bad signature' }, 401);
      }
    }

    const attachment = form.get('attachment');
    if (attachment instanceof File && attachment.size > 0) {
      const bad = validateFile(attachment);
      if (bad) return json({ error: bad }, 413);
    }

    const ip = req.headers.get('cf-connecting-ip') ?? undefined;
    // form.get() yields File | string | null — only a non-empty string can be a
    // token, and anything else is rejected without a round trip to Cloudflare.
    if (typeof turnstile_token !== 'string' || !turnstile_token) {
      return json({ error: 'challenge failed', codes: ['missing-input-response'] }, 403);
    }
    const ts = await verifyTurnstile(turnstile_token, env.TURNSTILE_SECRET, ip);
    if (!ts.ok) {
      // Return Cloudflare's own codes. They are diagnostic, not sensitive, and
      // "challenge failed" with no reason is unactionable — it cannot tell a
      // mismatched secret from a token that was simply used twice.
      console.warn('turnstile rejected', ts.codes);
      return json({ error: 'challenge failed', codes: ts.codes }, 403);
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
      ).bind(submission_id, now, bodyHash, hits.map((h) => h.kind).join(',')).run();

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
      submission_id, now, clean, bodyHash,
      meta.wallet_version ?? null, meta.platform ?? null, meta.network ?? null,
      meta.route ?? null, errorCode, fp, JSON.stringify(attachmentKeys)
    ).run();

    // Already seen — a retry, not a new report. Do not re-enqueue.
    if (res.meta.changes === 0) return json({ ok: true, submission_id, status: 'duplicate_submission' }, 200);

    await env.DB.prepare(
      `INSERT INTO state_log (submission_id, at, from_state, to_state, detail) VALUES (?, ?, NULL, 'received', ?)`
    ).bind(submission_id, now, fp).run();

    // No enqueue. The row in state `received` IS the work item; the drain
    // cron claims it on the next tick.
    return json({ ok: true, submission_id, status: 'received' }, 202);
  },

  /**
   * Both jobs run here. Handlers must be properties of the default export —
   * a named `export function scheduled` is never registered, which is how the
   * previous wiring managed to look correct and never run.
   */
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === MIRROR_CRON) {
      await syncMirror(env);
      return;
    }
    await drain(env);
  },
} satisfies ExportedHandler<Env>;

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

// Durable Object classes are the one thing that IS a named export — the
// runtime resolves them by class name from the migrations entry.
export { PublishGate } from './lib/gate';
