/**
 * Sync checkpoints, retries and backoff — `store_sync_state`.
 *
 * One row per (source, app_id), holding where the last run got to and how it
 * went. It exists so a sync that is interrupted resumes instead of restarting,
 * and so a sync that is FAILING is visible as a countdown rather than as
 * silence.
 *
 * THE COUNTDOWN IS THE POINT, NOT THE HEALTH CHECK.
 * Google Play serves only reviews created or modified in the last 7 days. A
 * review that ages out of that window is unreachable through the API forever —
 * recoverable only from a Play Console CSV export, if anyone thinks to take
 * one. So the question worth alerting on is not "did the last sync fail" but
 * "how long has it been since one SUCCEEDED", measured against 168 hours.
 *
 * That is why `last_success_at` is a typed, indexed column rather than a value
 * inside a JSON blob: the alarm is a query against it.
 *
 * BACKOFF IS CAPPED FAR BELOW THE WINDOW, DELIBERATELY.
 * Unbounded exponential backoff is the right default almost everywhere and the
 * wrong one here. Doubling from minutes reaches days within a dozen failures,
 * and a day of backoff against a 7-day window is a day of reviews at risk. The
 * cap keeps a broken sync retrying often enough that fixing the cause within a
 * few days still recovers everything.
 */

/** Row shape in `store_sync_state`. */
export interface Checkpoint {
  key: string;
  cursor: string | null;
  last_success_at: number | null;
  last_attempt_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
  updated_at: number;
  /** Set while the store has asked us to wait. Null means nothing is pending. */
  defer_until: number | null;
  /** Set while a credential is refused. Null means the sync is running normally. */
  paused_at: number | null;
  paused_reason: string | null;
}

/** The window Google actually serves. Everything here is measured against it. */
export const GOOGLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const BASE_BACKOFF_MS = 60_000;      // one minute
/** One hour. 1/168th of the window, so even a sustained outage keeps trying. */
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * How often a PAUSED sync tries once anyway.
 *
 * Pausing exists so a refused credential stops costing a request every five
 * minutes. Making it terminal would swap one silent failure for another: the
 * sync would sit stopped until somebody read a status page, while the 7-day
 * window emptied behind it — the exact failure this file argues against for
 * backoff. So a pause is a much slower cadence, not an off switch, and a
 * rotated key brings the sync back by itself within this interval without
 * anyone touching the database.
 *
 * An hour is the same ceiling backoffMs already reaches, so a paused sync costs
 * no more requests than a sync that is merely failing — 24 a day against a
 * refused endpoint instead of 288 — and a key rotated at any point is picked up
 * within the hour rather than at the end of a shift.
 */
export const PARK_REPROBE_MS = 60 * 60 * 1000;

export function syncKey(source: string, appId: string): string {
  return `${source}:${appId}`;
}

export async function loadCheckpoint(db: D1Database, key: string): Promise<Checkpoint | null> {
  return db.prepare('SELECT * FROM store_sync_state WHERE key = ?').bind(key).first<Checkpoint>();
}

/**
 * How long to wait after `n` consecutive failures.
 *
 * Exponential, capped. `n = 0` means the last attempt succeeded, so there is
 * nothing to wait for.
 */
export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const raw = BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(raw, MAX_BACKOFF_MS);
}

/**
 * May this source be synced right now?
 *
 * A source that has never run is always due — the first run must not be
 * delayed by a backoff computed from no history at all.
 */
export function isDue(cp: Checkpoint | null, nowMs: number): boolean {
  if (!cp) return true;

  // A PAUSE OUTRANKS EVERYTHING BELOW IT, including a due backoff: while a
  // credential is refused, the answer to every request is already known.
  if (cp.paused_at) return nowMs >= cp.paused_at + PARK_REPROBE_MS;

  // A wait the STORE asked for. Honoured even when our own backoff has expired
  // — being due on our clock is not permission on theirs.
  if (cp.defer_until && nowMs < cp.defer_until) return false;

  if (cp.consecutive_failures <= 0) return true;
  const waitUntil = (cp.last_attempt_at ?? 0) + backoffMs(cp.consecutive_failures);
  return nowMs >= waitUntil;
}

/** Why a sync is not due, for a status page. Null when it is due. */
export function holdReason(cp: Checkpoint | null, nowMs: number): 'paused' | 'deferred' | 'backoff' | null {
  if (isDue(cp, nowMs)) return null;
  if (cp?.paused_at) return 'paused';
  if (cp?.defer_until && nowMs < cp.defer_until) return 'deferred';
  return 'backoff';
}

/** Hours since the last SUCCESSFUL sync. `null` means one has never happened. */
export function hoursSinceSuccess(cp: Checkpoint | null, nowMs: number): number | null {
  if (!cp?.last_success_at) return null;
  return (nowMs - cp.last_success_at) / 3_600_000;
}

/**
 * How much of the 7-day window has been burned since the last success.
 *
 * 1.0 means reviews have begun ageing out and are now unrecoverable through
 * the API. Returns null when no sync has ever succeeded — that is a different
 * situation (nothing was ever collected) and must not be reported as data loss.
 */
export function windowConsumed(cp: Checkpoint | null, nowMs: number): number | null {
  if (!cp?.last_success_at) return null;
  return (nowMs - cp.last_success_at) / GOOGLE_WINDOW_MS;
}

/** Stamps the attempt before any work, so a crash mid-run is still recorded. */
export async function beginAttempt(db: D1Database, key: string, nowMs: number): Promise<void> {
  await db.prepare(
    `INSERT INTO store_sync_state (key, last_attempt_at, consecutive_failures, updated_at)
     VALUES (?,?,0,?)
     ON CONFLICT(key) DO UPDATE SET last_attempt_at = ?, updated_at = ?`
  ).bind(key, nowMs, nowMs, nowMs, nowMs).run();
}

/**
 * A run finished cleanly.
 *
 * `cursor` is stored as given, including null — a null cursor means "the next
 * run starts from the beginning", which after a complete pass is exactly right
 * and is not a loss of information.
 */
export async function recordSuccess(
  db: D1Database, key: string, cursor: string | null, nowMs: number
): Promise<void> {
  await db.prepare(
    `INSERT INTO store_sync_state
       (key, cursor, last_success_at, last_attempt_at, consecutive_failures, last_error, updated_at)
     VALUES (?,?,?,?,0,NULL,?)
     ON CONFLICT(key) DO UPDATE SET
       cursor = ?, last_success_at = ?, last_attempt_at = ?,
       consecutive_failures = 0, last_error = NULL, updated_at = ?,
       -- A SUCCESS IS THE ONLY THING THAT CLEARS A PAUSE. Not a deploy, not a
       -- deferral, not the probe interval elapsing: only a run that actually
       -- worked proves the credential is good again.
       defer_until = NULL, paused_at = NULL, paused_reason = NULL`
  ).bind(key, cursor, nowMs, nowMs, nowMs, cursor, nowMs, nowMs, nowMs).run();
}

/**
 * The store asked us to come back later — a 429, or one of Google's 403s that
 * is really a quota.
 *
 * NOT A FAILURE, AND DELIBERATELY NOT COUNTED AS ONE. `consecutive_failures`
 * drives our backoff and, through /health, the question "is this sync broken".
 * A store that is briefly busy is not a broken sync, and letting a rate limit
 * inflate that counter means an afternoon of load looks identical to a revoked
 * key. `last_error` is left alone for the same reason: the last thing that went
 * WRONG is still the last thing that went wrong.
 *
 * The wait itself is what stops the next tick, which is why `defer_until` had
 * to be a column: skipping the increment alone would leave the sync due
 * immediately and asking again — worse than counting it.
 */
export async function recordDeferral(
  db: D1Database, key: string, untilMs: number, nowMs: number, cursor?: string | null
): Promise<void> {
  const advance = cursor === undefined ? null : cursor;
  const keepOld = cursor === undefined ? 1 : 0;
  await db.prepare(
    `INSERT INTO store_sync_state
       (key, cursor, last_attempt_at, consecutive_failures, defer_until, updated_at)
     VALUES (?1, ?2, ?3, 0, ?4, ?3)
     ON CONFLICT(key) DO UPDATE SET
       cursor = CASE WHEN ?5 = 1 THEN store_sync_state.cursor ELSE ?2 END,
       last_attempt_at = ?3,
       defer_until = ?4,
       -- A rate limit during a pause PROVES NOTHING about the credential: the
       -- request never got far enough to be refused. So the pause stands, and
       -- its clock restarts rather than a probe firing again inside the wait.
       paused_at = CASE WHEN store_sync_state.paused_at IS NULL THEN NULL ELSE ?3 END,
       updated_at = ?3`
  ).bind(key, advance, nowMs, untilMs, keepOld).run();
}

/**
 * A credential was refused. Stop the normal cadence.
 *
 * This is the one failure that retrying cannot fix, so it is the one failure
 * that stops asking. What it does NOT do is go quiet: the reason is stored, it
 * is what /health reports, and PARK_REPROBE_MS still lets one request through
 * every few hours so a rotated key resumes the sync on its own.
 *
 * The reason is the same text as `last_error`, and for the same reason it is
 * safe to store: fixed wording, an HTTP status, and a machine code that has
 * already been shape-checked. No key, no ID, no upstream prose.
 */
export async function recordPause(
  db: D1Database, key: string, error: unknown, nowMs: number, cursor?: string | null
): Promise<void> {
  const message = String((error as Error)?.message ?? error).slice(0, 300);
  const advance = cursor === undefined ? null : cursor;
  const keepOld = cursor === undefined ? 1 : 0;
  await db.prepare(
    `INSERT INTO store_sync_state
       (key, cursor, last_attempt_at, consecutive_failures, last_error, paused_at, paused_reason, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?3, ?4, ?3)
     ON CONFLICT(key) DO UPDATE SET
       cursor = CASE WHEN ?5 = 1 THEN store_sync_state.cursor ELSE ?2 END,
       last_attempt_at = ?3,
       -- Still counted. A pause is a failure that happens to be diagnosable,
       -- and the count is what shows a probe answering 401 every six hours.
       consecutive_failures = store_sync_state.consecutive_failures + 1,
       last_error = ?4,
       paused_at = ?3,
       paused_reason = ?4,
       updated_at = ?3`
  ).bind(key, advance, nowMs, message, keepOld).run();
}

/**
 * A run failed.
 *
 * THE CURSOR IS NOT CLEARED. Whatever the last successful pass reached stays
 * put, so a transient failure resumes rather than restarting. Even if the
 * cursor is stale by the time it is used, re-reading pages already seen costs
 * only time: `upsertReview` is idempotent, so a repeated page writes nothing.
 *
 * The error message is truncated. It reaches a page that renders it, and an
 * upstream error body is attacker-adjacent text like any other.
 */
export async function recordFailure(
  db: D1Database, key: string, error: unknown, nowMs: number,
  cursor?: string | null
): Promise<void> {
  const message = String((error as Error)?.message ?? error).slice(0, 300);
  // OMITTING `cursor` keeps whatever is stored; PASSING it (even as null)
  // advances the checkpoint to the page that actually failed, so the retry
  // resumes there instead of re-walking pages already stored.
  const advance = cursor === undefined ? null : cursor;
  const keepOld = cursor === undefined ? 1 : 0;
  // Every placeholder is NUMBERED. Mixing `?` and `?NNN` in one statement is
  // legal SQLite and reads as a trap: the bare `?` takes the next unused index,
  // so inserting a parameter silently renumbers the ones after it.
  await db.prepare(
    `INSERT INTO store_sync_state
       (key, cursor, last_attempt_at, consecutive_failures, last_error, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?3)
     ON CONFLICT(key) DO UPDATE SET
       cursor = CASE WHEN ?5 = 1 THEN store_sync_state.cursor ELSE ?2 END,
       last_attempt_at = ?3,
       consecutive_failures = store_sync_state.consecutive_failures + 1,
       last_error = ?4,
       -- A PAUSED SYNC THAT FAILS FOR SOME OTHER REASON IS STILL PAUSED, and
       -- its probe clock restarts. Leaving paused_at alone would leave it in
       -- the past, which isDue reads as "the probe is due" — every tick, five
       -- minutes apart, which is the hammering the pause exists to stop.
       paused_at = CASE WHEN store_sync_state.paused_at IS NULL THEN NULL ELSE ?3 END,
       updated_at = ?3`
  ).bind(key, advance, nowMs, message, keepOld).run();
}
