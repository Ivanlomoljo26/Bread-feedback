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
import { tokenIdentity } from './lib/github';
import { verifyTurnstile, verifyHmac, sha256Hex, isUuidV4, timingSafeEqual } from './lib/validate';
import { scanForSecrets } from './lib/secret-scan';
import { sanitize } from './lib/sanitize';
import { inferErrorCode, fingerprint } from './lib/fingerprint';
import { storeAttachment, validateFile, admitBytes } from './lib/attachments';
import { floodHash, reporterKind, floodConfig, spamGateEnabled, checkFlood } from './lib/spam-signals';
import { handleReview } from './lib/review';

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
  /** New issues one reporter may create per hour / per 24h. Fairness between
   *  honest reporters; the global caps above are the actual abuse wall. */
  REPORTER_CAP_PER_HOUR: string;
  REPORTER_CAP_PER_DAY: string;
  /** Below this a match is not mentioned at all. */
  REVIEW_THRESHOLD: string;
  /**
   * AUTHORISATION, not classification. At or above this a match may be acted
   * on: a comment written onto an issue this service does not own, or a real
   * cross-reference spent on one. Deliberately its own name — the threshold it
   * replaced also meant "this is a duplicate", and reusing a classification
   * number as write permission is how a 0.61 guess earned a public comment.
   */
  AUTO_ACTION_THRESHOLD: string;
  MARKER_PREFIX: string;
  /** Submissions claimed per drain tick. Bounded by the free plan's 50
   *  subrequests per invocation — one submission can spend six or seven. */
  DRAIN_BATCH_SIZE: string;
  /** Error retries before a submission is parked in state `failed`. */
  MAX_ATTEMPTS: string;
  /** Accepted submissions per hour per install id (else per IP). */
  RATE_LIMIT_PER_HOUR: string;

  /**
   * Spam layer kill switch. Anything but the literal "true" means OFF, so the
   * safe state is the default and a typo cannot arm a filter that parks real
   * user reports. Stays "false" in production until the review page exists —
   * flagging with nowhere to read or release from is a black hole, which is
   * the thing this layer exists to prevent.
   *
   * While it is off the check still RUNS and logs what it would have done.
   * That shadow data is what justifies flipping it, and it costs one indexed
   * read. The same discipline was applied to duplicate-merging before it went
   * live, and it is the reason that switch was defensible.
   */
  /**
   * Authorises the review queue. A SEPARATE secret from BACKFILL_TOKEN,
   * deliberately: every other /admin route is read-only or operational, while
   * release is a write authority that ends in a public issue on the target
   * repo. Unset means the review queue cannot be signed into at all — closed,
   * never open.
   */
  REVIEW_TOKEN?: string;
  SPAM_GATE_ENABLED?: string;
  /** Nth identical submission that trips the flood check. Floored at 2. */
  FLOOD_THRESHOLD?: string;
  /** Window the count is taken over. Clamped to [1 minute, 24 hours]. */
  FLOOD_WINDOW_MS?: string;
}

/** Must match the mirror entry in wrangler.jsonc `triggers.crons` exactly. */
const MIRROR_CRON = '*/15 * * * *';

/**
 * Internal pipeline state -> what the reporter is told.
 *
 * Deliberately lossy. `capped` and `deferred` are different problems for an
 * operator and the same fact for a reporter — it is processed and waiting on
 * publishing capacity — and which limiter closed is not theirs to reason
 * about. The exact reason stays in D1 and the logs.
 *
 *   received  — accepted, not yet picked up
 *   reviewing — in the pipeline right now
 *   queued    — classified, waiting on publish budget
 *   attached  — its text is on an existing issue (dup_links proves it)
 *   filed     — it has an issue of its own
 *
 * quarantined and failed both map to `received` ON PURPOSE. Quarantine
 * answers 202 by design so a false positive tells an attacker nothing, and a
 * parked row is an operator's problem the reporter cannot act on. Neither
 * looks different on the page than it does today; changing that is a product
 * decision, not a rename.
 *
 * `suspected_spam` and `spam` map to `received` for the same reason, and they
 * do it by falling through to the default branch rather than by a case of
 * their own. That is intentional on both counts:
 *
 *   - Telling a reporter their report was flagged as spam tells a spammer
 *     their probe worked, and tells a false-positive victim something they
 *     cannot act on. Neutral is the only answer that is safe in both
 *     directions.
 *   - Fall-through means any state added later is neutral by DEFAULT. A new
 *     internal state cannot leak to the public API by someone forgetting to
 *     add it here — the failure mode is a state that reads as `received`,
 *     never one that reveals pipeline internals.
 *
 * test/status.test.ts case 16e pins this. Changing it is a product decision.
 */
function publicStatus(state: string, published: number | null, folded: number | null): string {
  if (published !== null) return 'filed';
  if (folded !== null) return 'attached';
  if (state === 'claimed' || state === 'publishing') return 'reviewing';
  if (state === 'capped' || state === 'deferred') return 'queued';
  return 'received';
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
    // The review queue owns every /admin/review* path and authenticates them
    // itself. Placed FIRST so no later route can accidentally shadow one and
    // serve it under a different (or no) credential.
    const review = await handleReview(req, env as any, url);
    if (review) return review;

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
     * Write-credential self-test. Reads GET /user with the write token and
     * reports identity, scopes and token kind — no repository is touched and
     * nothing is created.
     *
     * Needed because a healthy mirror is NOT evidence of write access: GitHub
     * serves public issues to a scopeless token, so "synced 180 issues" and
     * "cannot open an issue" look identical from outside. Without this, the
     * first genuine report is the test — and a 401 is not in the deferral
     * list, so it would burn all MAX_ATTEMPTS and park in `failed`.
     *
     * Expected: login Ivanlomoljo26, kind classic, scopes ["public_repo"].
     *
     *   curl "https://<worker>/admin/whoami" -H "authorization: Bearer $BACKFILL_TOKEN"
     */
    if (url.pathname === '/admin/whoami' && req.method === 'GET') {
      const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      if (!env.BACKFILL_TOKEN || !timingSafeEqual(auth, env.BACKFILL_TOKEN)) {
        return json({ error: 'unauthorized' }, 401);
      }
      const id = await tokenIdentity(env.GITHUB_WRITE_TOKEN);
      return json({
        ...id,
        repo: env.TARGET_REPO,
        // The invariant this route exists to check, evaluated here rather than
        // left to the reader.
        satisfiesInvariant:
          id.ok && id.kind === 'classic' &&
          (id.scopes ?? []).length === 1 && (id.scopes ?? [])[0] === 'public_repo',
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
      // The join is what actually repairs the form's history list. Folds never
      // reach the publish path, so a duplicate has no title of its own — the
      // mirror is the only place its title exists.
      //
      // Sourced from dup_links, NOT submissions.matched_issue. Those stopped
      // being the same question when closed matches became new issues:
      // matched_issue records what the CLASSIFIER matched, and a match against
      // a closed issue is deliberately not folded. Reading it here announced
      // "Duplicate of #454 — merged into an existing report" for a report that
      // was queued to get its own issue, and kept announcing it for as long as
      // the cap held the row in `capped` — hours, at CAP_PER_HOUR=1.
      // dup_links means "this report was commented onto that issue", which is
      // precisely the claim the form is making.
      const rows = await env.DB.prepare(
        `SELECT s.submission_id, s.state, s.published_issue, s.published_title,
                d.issue_number AS folded_issue, m.title AS mirror_title
           FROM submissions s
           LEFT JOIN dup_links d ON d.submission_id = s.submission_id
           LEFT JOIN issue_mirror m
             ON m.number = COALESCE(s.published_issue, d.issue_number)
          WHERE s.submission_id IN (${ids.map(() => '?').join(',')})`
      ).bind(...ids).all();
      const results: Record<string, {
        status: string; state: string; issue: number | null;
        duplicate: boolean; title: string | null;
      }> = {};
      for (const r of rows.results ?? []) {
        const published = (r as any).published_issue ?? null;
        const folded = (r as any).folded_issue ?? null;
        results[(r as any).submission_id] = {
          // PRESENTATION status, not the internal state. The form used to read
          // `capped` and other pipeline vocabulary straight off the wire,
          // which both leaked how the limiter works and meant an internal
          // rename would break the page. This is the contract; `state` below
          // is kept only so an operator reading /status by hand still sees it.
          status: publicStatus((r as any).state, published, folded),
          state: (r as any).state,
          // Null until one of the two actually happened. A report still
          // waiting on publish budget reads as queued, which is what it is.
          issue: published ?? folded,
          // Collapsing these two into one number told the reporter "Filed #41"
          // for a report that folded into someone else's issue. They are
          // different outcomes and the form says so.
          duplicate: published === null && folded !== null,
          // Mirror first, deliberately: it reflects GitHub as it is now, so a
          // maintainer renaming the issue reaches the reporter. published_title
          // is only the stand-in for the gap before the next sync.
          //
          // CALLER MUST CHECK THE REPO. issue_mirror is keyed by number alone
          // and only ever holds the current TARGET_REPO, so a pre-cutover
          // report can collide with a same-numbered issue here. The form
          // discards this unless the report was filed in the repo below.
          title: (r as any).mirror_title ?? (r as any).published_title ?? null,
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
    // The same identity, hashed, is stored on the row so the DRAIN can apply a
    // per-reporter publish cap an hour later. It has no other reader: nothing
    // displays it, and /status never returns it. Hashed rather than raw
    // because publishing does not need to know who someone is, only that two
    // reports came from the same someone. See migration 0004 on what that
    // does and does not buy for the IP fallback.
    const reporterKey = await sha256Hex(rlKey);
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

    // 4. Flood check — the same person sending the same thing repeatedly.
    //
    //    AFTER the secret scan on purpose: a body that is both secret material
    //    and a flood must be redacted, not preserved for review. Secret
    //    material is the more severe finding and has to win.
    //
    //    Both columns are computed HERE, before any branch, and written by
    //    every path below. That is the load-bearing half and the easy one to
    //    drop: if the ordinary `received` INSERT omits normalized_hash, the
    //    COUNT above it matches nothing and flood detection silently never
    //    fires — no error, no log, just a control that does not exist. It also
    //    means history accumulates while the gate is off, so the check has
    //    something to count the day it is switched on.
    const normalizedHash = await floodHash(body);
    const kind = reporterKind(meta.install_id);

    const flood = await checkFlood(env.DB, reporterKey, normalizedHash, now, floodConfig(env));
    const gateOn = spamGateEnabled(env);
    const flagged = gateOn && flood.flagged;

    if (flood.flagged) {
      // Never the body. A reason code, a count, and whether it was enforced —
      // enough to tune the threshold, nothing that echoes attacker-controlled
      // text into logs an operator reads.
      console.warn(JSON.stringify({
        job: 'flood',
        submission: submission_id,
        reporter_kind: kind,
        prior: flood.priorCount,
        enforced: gateOn,
      }));
    }

    // 5. Sanitize + classify structurally
    const clean = sanitize(body);
    const errorCode = inferErrorCode(clean);
    const fp = fingerprint({
      errorCode,
      walletVersion: meta.wallet_version,
      platform: meta.platform,
      route: meta.route,
    });

    // 6. Attachment — only after the text passed the secret scan.
    //    The user was warned twice in the form; we still keep a durable copy
    //    in R2 so a leaked file can be revoked even after it reaches GitHub.
    //
    //    Skipped for a flagged flood, and only there. Suspected reports keep
    //    their attachments (a reviewer needs to see what was sent) — but the
    //    Nth identical submission's attachment is redundant by definition,
    //    since the first N-1 already stored theirs. Evidence is preserved
    //    without handing a flooder unbounded R2. The skip is recorded in
    //    state_log so a reviewer sees why a file is missing rather than
    //    wondering whether one was ever sent.
    //
    //    THE BYTES ARE READ HERE, not at the top with the size check. Reading
    //    10 MB before Turnstile and the rate limiter would let an unverified
    //    request make this Worker buffer 10 MB, which is a cheaper attack than
    //    the one the sniff prevents. By this point the request has passed the
    //    challenge, the limiter and the secret scan.
    let attachmentKeys: string[] = [];
    let attachmentSkipped = false;
    if (attachment instanceof File && attachment.size > 0) {
      if (flagged) {
        attachmentSkipped = true;
      } else {
        const bytes = new Uint8Array(await attachment.arrayBuffer());
        const sniffed = admitBytes(bytes, attachment.type);
        if ('error' in sniffed) {
          // 415, and NOTHING is written: no row, no R2 object. The report is
          // refused whole rather than filed without the evidence it referred
          // to, which would leave a maintainer reading about a screenshot
          // that does not exist.
          return json({ error: sniffed.error }, 415);
        }
        const stored = await storeAttachment(attachment, bytes, sniffed, submission_id, env as any);
        attachmentKeys = [JSON.stringify(stored)];
      }
    }

    // 7. Idempotency layer 1
    // state and spam_status are written TOGETHER, always. Setting the state
    // without the status would leave spam_status NULL, which every later guard
    // reads as `clean` — so the defence-in-depth layer would be inert exactly
    // where it should fire, and the row would be held only by the drain's
    // state filter. One missing column, one silent single point of failure.
    const state = flagged ? 'suspected_spam' : 'received';
    const spamStatus = flagged ? 'suspected' : null;
    // Reason CODES only, never quoted content. Never 'spam' from a flood
    // alone: a flood is grounds for a human to look, not for a verdict.
    const spamReasons = flagged ? JSON.stringify(['flood_repeat']) : null;

    const res = await env.DB.prepare(
      `INSERT INTO submissions
         (submission_id, received_at, state, body_sanitized, body_hash,
          wallet_version, platform, network, route, error_code, fingerprint,
          reporter_key, attachment_keys,
          normalized_hash, reporter_kind, spam_status, spam_reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id) DO NOTHING`
    ).bind(
      submission_id, now, state, clean, bodyHash,
      meta.wallet_version ?? null, meta.platform ?? null, meta.network ?? null,
      meta.route ?? null, errorCode, fp, reporterKey, JSON.stringify(attachmentKeys),
      normalizedHash, kind, spamStatus, spamReasons
    ).run();

    // Already seen — a retry, not a new report. Do not re-enqueue.
    if (res.meta.changes === 0) return json({ ok: true, submission_id, status: 'duplicate_submission' }, 200);

    const detail = flagged
      ? `${fp} flood_repeat prior=${flood.priorCount}${attachmentSkipped ? ' attachment_skipped' : ''}`
      : fp;
    await env.DB.prepare(
      `INSERT INTO state_log (submission_id, at, from_state, to_state, detail) VALUES (?, ?, NULL, ?, ?)`
    ).bind(submission_id, now, state, detail).run();

    // No enqueue. A row in state `received` IS the work item; the drain cron
    // claims it on the next tick. A row in `suspected_spam` is excluded from
    // that claim by ABSENCE from its state filter, not by a check that could
    // be forgotten — see the drain's WHERE clause.
    //
    // The reporter is told exactly what a clean submission is told, with the
    // same 202. Telling someone they were flagged tells a spammer their probe
    // worked and tells a false positive something they cannot act on.
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
