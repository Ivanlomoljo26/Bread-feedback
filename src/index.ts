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
import { embedMissing, embedTexts, similarIssues, unpackVector } from './lib/embed';
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
  /** Accepted submissions per hour per install id (else per IP). */
  RATE_LIMIT_PER_HOUR: string;
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

      // Counts per state. `quarantined` and `failed` are the two that cost a
      // report and say nothing: quarantine returns 202 to the reporter on
      // purpose, so a false positive is otherwise invisible to everyone. A
      // non-zero count here is the only signal that one happened.
      // Counts only — ids and reasons are submitter data and live behind the
      // token on /admin/quarantined.
      const rows = await env.DB.prepare(
        'SELECT state, COUNT(*) AS n FROM submissions GROUP BY state'
      ).all<{ state: string; n: number }>();
      const pipeline: Record<string, number> = {};
      for (const r of rows.results ?? []) pipeline[r.state] = r.n;

      return json({
        ok: true,
        publish: status,
        pipeline,
        needsAttention: {
          quarantined: pipeline.quarantined ?? 0,
          failed: pipeline.failed ?? 0,
        },
      });
    }

    /**
     * Clear the publish gate's rolling counters. Cutover only: the hourly and
     * daily windows otherwise carry testing writes into production, and the
     * day-one caps refuse real reports for the wrong reason.
     *
     *   curl -X POST https://<worker>/admin/gate-reset -H "authorization: Bearer $BACKFILL_TOKEN"
     */
    if (url.pathname === '/admin/gate-reset' && req.method === 'POST') {
      const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      if (!env.BACKFILL_TOKEN || !timingSafeEqual(auth, env.BACKFILL_TOKEN)) {
        return json({ error: 'unauthorized' }, 401);
      }
      const gate = env.PUBLISH_GATE.get(env.PUBLISH_GATE.idFromName('global'));
      const res = await (await gate.fetch('https://gate/reset', { method: 'POST' })).json();
      return json({ ok: true, gate: res });
    }

    /**
     * The quarantine and parked queues, with reasons. Token-gated because a
     * submission id plus a timestamp is submitter data, unlike the bare counts
     * on /health.
     *
     *   curl https://<worker>/admin/quarantined -H "authorization: Bearer $BACKFILL_TOKEN"
     */
    if (url.pathname === '/admin/quarantined' && req.method === 'GET') {
      const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      if (!env.BACKFILL_TOKEN || !timingSafeEqual(auth, env.BACKFILL_TOKEN)) {
        return json({ error: 'unauthorized' }, 401);
      }
      const rows = await env.DB.prepare(
        `SELECT submission_id, state, quarantine_reason, last_error, attempts, received_at
           FROM submissions
          WHERE state IN ('quarantined', 'failed')
          ORDER BY received_at DESC LIMIT 50`
      ).all<{
        submission_id: string; state: string; quarantine_reason: string | null;
        last_error: string | null; attempts: number; received_at: number;
      }>();

      // The body is already redacted in D1 for quarantined rows, so there is
      // nothing here to leak even to an authorised caller — the reason is the
      // only thing that identifies WHY, and it is what a false positive needs.
      return json({
        ok: true,
        rows: (rows.results ?? []).map((r) => ({
          submission_id: r.submission_id,
          state: r.state,
          reason: r.quarantine_reason ?? r.last_error,
          attempts: r.attempts,
          received_at: new Date(r.received_at).toISOString(),
        })),
      });
    }
    /**
     * Retrieval self-test. Semantic retrieval fails SILENTLY — similarIssues
     * skips any row whose stored vector it cannot unpack, so a type mismatch
     * between what D1 returns for a BLOB and what unpackVector accepts yields
     * an empty candidate list with no error anywhere. This reports the shapes
     * instead of guessing at them.
     *
     *   curl "https://<worker>/admin/retrieval-test?q=camera+preview+black" \
     *        -H "authorization: Bearer $BACKFILL_TOKEN"
     */
    if (url.pathname === '/admin/retrieval-test' && req.method === 'GET') {
      const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      if (!env.BACKFILL_TOKEN || !timingSafeEqual(auth, env.BACKFILL_TOKEN)) {
        return json({ error: 'unauthorized' }, 401);
      }
      const q = url.searchParams.get('q') ?? 'camera preview stays black when opening the QR scanner';
      const out: Record<string, unknown> = {};

      // 1. can we embed at all?
      try {
        const [v] = await embedTexts(env, [q]);
        out.queryVector = { ok: true, dims: v?.length ?? 0 };
      } catch (e) {
        out.queryVector = { ok: false, error: String(e) };
      }

      // 2. what does D1 actually hand back for a BLOB column?
      const row = await env.DB.prepare(
        'SELECT number, embedding FROM issue_mirror WHERE embedding IS NOT NULL LIMIT 1'
      ).first<{ number: number; embedding: unknown }>();
      const raw = row?.embedding;
      const unpacked = unpackVector(raw);
      out.storedVector = {
        issue: row?.number ?? null,
        jsType: typeof raw,
        ctor: raw === null || raw === undefined ? String(raw) : raw.constructor?.name ?? 'unknown',
        isArrayBuffer: raw instanceof ArrayBuffer,
        isView: ArrayBuffer.isView(raw),
        isArray: Array.isArray(raw),
        byteLength: raw instanceof ArrayBuffer ? raw.byteLength
          : ArrayBuffer.isView(raw) ? (raw as ArrayBufferView).byteLength
          : Array.isArray(raw) ? raw.length : null,
        unpackedDims: unpacked?.length ?? null,
      };

      // 3. end to end
      try {
        const hits = await similarIssues(env, q, 8);
        out.similarIssues = { ok: true, returned: hits.map((h) => h.number) };
      } catch (e) {
        out.similarIssues = { ok: false, error: String(e) };
      }
      return json({ ok: true, ...out });
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
      const results: Record<string, { state: string; issue: number | null; duplicate: boolean }> = {};
      for (const r of rows.results ?? []) {
        const published = (r as any).published_issue ?? null;
        const matched = (r as any).matched_issue ?? null;
        results[(r as any).submission_id] = {
          state: (r as any).state,
          issue: published ?? matched,
          // Collapsing these two into one number told the reporter "Filed #41"
          // for a report that folded into someone else's issue. They are
          // different outcomes and the form says so.
          duplicate: published === null && matched !== null,
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
    if (!['android', 'ios', 'extension'].includes(meta.platform)) {
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

/** Sliding-window limiter, RATE_LIMIT_PER_HOUR per key. */
export class RateLimiter {
  constructor(private state: DurableObjectState, private env: { RATE_LIMIT_PER_HOUR?: string }) {}
  async fetch(): Promise<Response> {
    const now = Date.now();
    const windowMs = 3_600_000;
    // Fallback is deliberately BELOW the configured value, same reasoning as
    // the PublishGate caps: if the var goes missing, an abuse control must
    // fail tight rather than open.
    const limit = Math.max(1, Number(this.env.RATE_LIMIT_PER_HOUR ?? 5));
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
