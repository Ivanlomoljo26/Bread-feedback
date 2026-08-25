/**
 * Reviewer sessions for /admin/review.
 *
 * This is the highest-privilege surface in the service. Release is a WRITE
 * AUTHORITY: it puts a report back into the pipeline, and the pipeline ends in
 * a public issue on 0xMiden/wallet. Everything else under /admin is read-only
 * or operational, which is why this does not reuse BACKFILL_TOKEN — the same
 * reasoning that already keeps BACKFILL_TOKEN separate from INGEST_HMAC_KEY.
 *
 * A shared secret has no identity, and that limit is stated rather than hidden:
 * the audit trail records that A reviewer acted and which login session did it,
 * not which person. Tying actions to a named human is a different auth model
 * and a separate decision.
 */

import { timingSafeEqual } from './validate';

export const COOKIE_NAME = 'mfv2_review';
/** Eight hours. Long enough for a review session, short enough that a leaked
 *  cookie is not a permanent credential. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

async function hmacHex(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Session {
  /** Random per-login id. Correlates a sequence of actions to one login. */
  id: string;
  expiresAt: number;
}

/** `<expiry>.<id>.<hmac>` — the signature covers the other two. */
export async function issueSession(reviewToken: string, now = Date.now()): Promise<{
  session: Session; cookie: string;
}> {
  const session: Session = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    expiresAt: now + SESSION_TTL_MS,
  };
  const payload = `${session.expiresAt}.${session.id}`;
  const value = `${payload}.${await hmacHex(payload, reviewToken)}`;
  // HttpOnly: script cannot read it. Secure: never sent over plaintext.
  // SameSite=Strict: a cross-site POST carries no cookie at all, which is the
  // first of two independent CSRF defences.
  // Path is scoped so the cookie is not attached to /submit or /status.
  const cookie = `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/admin/review; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return { session, cookie };
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/admin/review; Max-Age=0`;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/**
 * Verify a request's session cookie. Returns null for ANY failure — missing,
 * malformed, expired, or wrongly signed — with no distinction between them.
 */
export async function verifySession(req: Request, reviewToken: string, now = Date.now()): Promise<Session | null> {
  if (!reviewToken) return null;   // unconfigured means closed, never open
  const raw = readCookie(req.headers.get('cookie'), COOKIE_NAME);
  if (!raw) return null;

  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [expiryStr, id, sig] = parts;

  const expected = await hmacHex(`${expiryStr}.${id}`, reviewToken);
  if (!timingSafeEqual(sig, expected)) return null;

  // Expiry is checked AFTER the signature, so an unsigned cookie can never
  // reach this branch and learn anything from how it behaves.
  const expiresAt = Number(expiryStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  return { id, expiresAt };
}

/**
 * CSRF token, derived from the session rather than stored.
 *
 * SameSite=Strict already means a cross-site POST arrives with no cookie, so
 * this is the second of two independent defences — it holds even if a browser
 * ignores SameSite or the cookie policy is ever loosened. Deriving it needs no
 * storage and cannot be computed by anyone without REVIEW_TOKEN.
 */
export function csrfToken(session: Session, reviewToken: string): Promise<string> {
  return hmacHex(`csrf.${session.id}.${session.expiresAt}`, reviewToken);
}

export async function csrfValid(session: Session, reviewToken: string, supplied: unknown): Promise<boolean> {
  if (typeof supplied !== 'string' || !supplied) return false;
  return timingSafeEqual(supplied, await csrfToken(session, reviewToken));
}

/**
 * Is this a plausible reviewer token at all?
 *
 * Length is compared before the constant-time compare because timingSafeEqual
 * returns early on a length mismatch anyway; this keeps the intent explicit.
 * An empty configured token must never authenticate an empty submission.
 */
export function tokenMatches(supplied: unknown, reviewToken: string): boolean {
  if (!reviewToken || typeof supplied !== 'string' || !supplied) return false;
  return timingSafeEqual(supplied, reviewToken);
}
