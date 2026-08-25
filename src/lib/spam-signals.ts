/**
 * Flood detection: the same person sending substantially the same report over
 * and over inside a window.
 *
 * This is a JUNK FILTER, not an abuse control. `reporter_key` is derived from
 * an install_id the client supplies, or from an IP when it does not — neither
 * is a credential, and a determined flooder can reset both. What this stops is
 * the common case: a stuck retry loop, a frustrated person hitting submit
 * eleven times, a script with no imagination. Anything that adapts is out of
 * scope by construction, and calling it an abuse control would be a lie that
 * shapes later decisions badly.
 *
 * Everything here fails OPEN. That is the opposite of the publish caps in
 * gate.ts, and the difference matters: a missing cap must fail tight because
 * failing tight withholds a WRITE. A missing flood threshold failing tight
 * would flag every report as suspected, which destroys signal rather than
 * withholding action — and buries real user reports behind a review queue.
 */

import { sha256Hex } from './validate';

/** Zero-width and BOM characters. Invisible, so they must not change a hash. */
const ZERO_WIDTH = /[​-‍﻿]/g;
/** Three or more of the SAME punctuation mark collapse to one: "!!!!" → "!". */
const PUNCT_RUN = /([^\w\s])\1{2,}/g;

/**
 * Normalize a body down to what a human would call "the same message".
 *
 * Applied to the RAW body, never the sanitized one. sanitize() injects its own
 * zero-width joiners into @mentions and #refs, so hashing its output would let
 * a flooder perturb the hash simply by mentioning a different username — and
 * would make the hash depend on sanitize()'s implementation, which is free to
 * change for reasons that have nothing to do with spam.
 *
 * Deliberately conservative. It collapses noise a person adds without meaning
 * to (case, spacing, "!!!!!"), and nothing else. Aggressive normalization —
 * stemming, stopword removal, punctuation stripping — would collapse genuinely
 * different reports onto one hash, and a false flood match parks a real report.
 */
export function normalizeForFlood(raw: string): string {
  return raw
    .replace(ZERO_WIDTH, '')
    .toLowerCase()
    .replace(PUNCT_RUN, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The flood key stored on every row as `normalized_hash`. */
export function floodHash(raw: string): Promise<string> {
  return sha256Hex(normalizeForFlood(raw));
}

/**
 * Which identity `reporter_key` was derived from.
 *
 * reporter_key is a sha256 of "i:<install_id>" or "ip:<addr>" and the two are
 * INDISTINGUISHABLE once hashed (migration 0004). Two rules depend on telling
 * them apart: repeated submissions count as spam evidence only from the same
 * install_id, and an IP-only match must never be sufficient to CONFIRM spam —
 * one NAT egress is not one person.
 */
export function reporterKind(installId: unknown): 'install' | 'ip' {
  return typeof installId === 'string' && installId ? 'install' : 'ip';
}

export interface FloodConfig {
  threshold: number;
  windowMs: number;
}

const DEFAULT_THRESHOLD = 4;
const DEFAULT_WINDOW_MS = 3_600_000; // 1 hour
const MIN_WINDOW_MS = 60_000;        // 1 minute
const MAX_WINDOW_MS = 86_400_000;    // 24 hours

function intOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read the flood config, clamped so no configuration mistake can make it
 * harsher than intended.
 *
 * - The threshold floors at 2, so it can never be set to flag a FIRST
 *   submission. A threshold of 1 or 0 would flag every report ever sent.
 * - The window is clamped at both ends. The ceiling is the one that matters:
 *   an accidental extra zero turns "one hour" into "eleven days", and every
 *   honest resubmit inside that span becomes a flood. Both clamps push
 *   towards flagging LESS, which is the fail-open direction for this check.
 */
export function floodConfig(env: { FLOOD_THRESHOLD?: string; FLOOD_WINDOW_MS?: string }): FloodConfig {
  return {
    threshold: Math.max(2, intOr(env.FLOOD_THRESHOLD, DEFAULT_THRESHOLD)),
    windowMs: Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, intOr(env.FLOOD_WINDOW_MS, DEFAULT_WINDOW_MS))),
  };
}

/**
 * The spam layer's kill switch.
 *
 * Anything other than the literal "true" — including unset, including a typo —
 * means OFF, so the safe state is the default and a missing var cannot silently
 * arm a filter that parks user reports. Mirrors the SHADOW convention this
 * project already uses.
 */
export function spamGateEnabled(env: { SPAM_GATE_ENABLED?: string }): boolean {
  return env.SPAM_GATE_ENABLED === 'true';
}

export interface FloodResult {
  /** Prior submissions from this reporter with this hash, inside the window. */
  priorCount: number;
  /** True when THIS submission is the Nth identical one, N >= threshold. */
  flagged: boolean;
}

/**
 * One indexed D1 read, covered by idx_sub_flood.
 *
 * Counts PRIOR rows only — this submission is not inserted yet — so with a
 * threshold of 4 we flag when three already exist and this is the fourth.
 *
 * On a D1 error this returns `flagged: false` rather than throwing. A database
 * hiccup must not decide that a report is spam, and it must not fail the whole
 * submission either: the report is the thing worth protecting.
 */
export async function checkFlood(
  db: D1Database,
  reporterKey: string,
  normalizedHash: string,
  now: number,
  cfg: FloodConfig
): Promise<FloodResult> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM submissions
          WHERE reporter_key = ? AND normalized_hash = ? AND received_at > ?`
      )
      .bind(reporterKey, normalizedHash, now - cfg.windowMs)
      .first<{ n: number }>();

    const priorCount = row?.n ?? 0;
    return { priorCount, flagged: priorCount >= cfg.threshold - 1 };
  } catch (err) {
    console.warn('flood check failed, treating as clean', (err as Error)?.message);
    return { priorCount: 0, flagged: false };
  }
}
