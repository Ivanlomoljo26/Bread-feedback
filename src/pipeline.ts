/**
 * Triage AND publish for a single submission. Fully automated, no human in
 * the loop.
 *
 * fingerprint → retrieve candidates → classify → gate → write to GitHub.
 *
 * Ordering of the guards matters. Idempotency is checked before the cap so a
 * retry of an already-published submission never consumes cap budget.
 *
 * This module owns the terminal SUCCESS transitions (published / folded).
 * Everything that needs to be tried again later is returned as an Outcome and
 * the caller decides the retry bookkeeping — see drain.ts. That split keeps
 * the publish path identical no matter what drives it, which is what made the
 * move off Queues a rewiring rather than a rewrite.
 */

import type { Env } from './index';
import { classify, validateVerdict, PROMPT_VERSION, type Candidate } from './lib/classify';
import {
  createIssue, createComment, updateComment,
  markerAlreadyPublished, RateLimited,
} from './lib/publish';
import { renderAttachment, type StoredAttachment } from './lib/attachments';
import { similarIssues } from './lib/embed';
import { sanitize } from './lib/sanitize';

/** The submissions columns this pipeline reads. */
export interface SubmissionRow {
  submission_id: string;
  state: string;
  received_at: number;
  body_sanitized: string;
  wallet_version: string | null;
  platform: string | null;
  network: string | null;
  route: string | null;
  error_code: string | null;
  fingerprint: string | null;
  attachment_keys: string | null;
  attempts: number;
}

/**
 * `done`  — terminal, already transitioned here.
 * `defer` — try again later; NOT the submission's fault, so the caller must
 *           not spend an attempt on it (backpressure or an upstream outage).
 * `fail`  — an error we cannot classify; the caller spends an attempt and
 *           parks the row once the budget is gone.
 */
export type Outcome =
  | { kind: 'done'; detail: string }
  | { kind: 'defer'; state: 'capped' | 'deferred'; delayMs: number; detail: string }
  | { kind: 'fail'; error: string };

/**
 * Exactly one label, by decision (2026-08-13): its whole job is to say "a user
 * filed this through the Bread feedback form". Four labels per issue was noise
 * on someone else's tracker, and none of them were load-bearing — idempotency
 * uses the <!-- mfv2:{id} --> marker in the body, and the mirror sync pulls
 * every issue rather than filtering by label.
 *
 * Same name as the v1 relay uses, so one filter finds every form-sourced issue
 * regardless of which pipeline filed it.
 *
 * Still an allowlist: the model may suggest labels, and anything not in here is
 * dropped before it reaches GitHub.
 */
const ALLOWED_LABELS = new Set(['feedback-form']);

/** How long a cap defers a submission. Was the queue's retry delaySeconds. */
export const CAP_DEFER_MS = 900_000;
/** How long an unavailable classifier defers a submission. */
export const CLASSIFY_DEFER_MS = 300_000;

export async function transition(env: Env, id: string, from: string, to: string, detail?: string) {
  await env.DB.batch([
    env.DB.prepare('UPDATE submissions SET state = ? WHERE submission_id = ?').bind(to, id),
    env.DB.prepare('INSERT INTO state_log (submission_id, at, from_state, to_state, detail) VALUES (?,?,?,?,?)')
      .bind(id, Date.now(), from, to, detail ?? null),
  ]);
}

/** Candidates handed to the model. Bounded because every one costs prompt tokens. */
const MAX_CANDIDATES = 8;

async function retrieveCandidates(env: Env, sub: SubmissionRow): Promise<Candidate[]> {
  const byFingerprint = await env.DB.prepare(
    `SELECT m.number, m.title, m.body, m.state
       FROM dup_links d JOIN issue_mirror m ON m.number = d.issue_number
      WHERE d.submission_id IN (SELECT submission_id FROM submissions WHERE fingerprint = ?)
      GROUP BY m.number LIMIT 5`
  ).bind(sub.fingerprint).all<Candidate>();

  // Keyword pass — ONLY when there is a keyword. With a null error_code the
  // pattern collapsed to '%%', which matches every title and returned "the 5
  // most recently updated issues". Those are not candidates, and because they
  // were merged ahead of the semantic hits they consumed 5 of the 8 slots and
  // truncated the one pass that finds a paraphrase.
  const keywordTerm = (sub.error_code ?? '').replace(/_/g, ' ').toLowerCase().trim();
  const keyword = keywordTerm
    ? await env.DB.prepare(
        `SELECT number, title, body, state FROM issue_mirror
          WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 5`
      ).bind(`%${keywordTerm}%`).all<Candidate>()
    : { results: [] as Candidate[] };

  let semantic: Candidate[] = [];
  try {
    semantic = await similarIssues(env, sub.body_sanitized, MAX_CANDIDATES);
  } catch (err) {
    // Degrades retrieval rather than aborting the submission: a lexical-only
    // candidate set risks a duplicate issue, deferring risks never filing.
    console.warn('embedding retrieval unavailable, falling back to lexical', err);
  }

  // Priority order, because the cap truncates from the tail:
  //   1. fingerprint — an exact structural match, the strongest evidence
  //   2. semantic    — the only pass that catches a rephrasing
  //   3. keyword     — weakest, and only present when an error code was inferred
  const seen = new Set<number>();
  const merged = [...(byFingerprint.results ?? []), ...semantic, ...(keyword.results ?? [])]
    .filter((c) => !seen.has(c.number) && seen.add(c.number))
    .slice(0, MAX_CANDIDATES);

  // Record what was offered. Without this a "why was this not deduped?" has no
  // answer: retrieval miss and classifier miss look identical after the fact.
  console.log(JSON.stringify({
    job: 'retrieve', submission: sub.submission_id,
    fingerprint: (byFingerprint.results ?? []).map((c) => c.number),
    semantic: semantic.map((c) => c.number),
    keyword: (keyword.results ?? []).map((c) => c.number),
    offered: merged.map((c) => c.number),
  }));
  return merged;
}

/** Truncate on a word boundary. slice() alone produced titles ending "The bro". */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return kept.replace(/[\s,;:.!?\-–—]+$/, '') + '…';
}

/**
 * Prefer the classifier's summary — it reads the whole report and describes the
 * DEFECT. The fallback can only echo the reporter's opening words, which is how
 * #45 ended up titled with a mid-word truncation of its first sentence.
 */
function titleFor(sub: SubmissionRow, summary?: string): string {
  const prefix = sub.error_code ? `[${sub.error_code}] ` : '';
  const clean = (summary ?? '').trim();
  if (clean.length >= 12) return `${prefix}${clamp(clean, 80)}`;
  const first = sub.body_sanitized.split('\n').find((l) => l.trim()) ?? 'Feedback report';
  return `${prefix}${clamp(first.trim(), 80)}`;
}

/** Display names. The stored values are the wire values: android | ios | extension. */
const PLATFORM_LABEL: Record<string, string> = {
  android: 'Android', ios: 'iOS', extension: 'Extension',
};

/**
 * One environment fact, ready to render. Values reach here from the submitted
 * `meta` blob, which — unlike the report body — was never passed through
 * sanitize(). Anyone posting to /submit directly could put "@everyone" or
 * "#123" in wallet_version and have it act on the repo, so it is neutralised
 * here alongside the pipe and newline stripping the layout needs.
 */
function envRow(label: string, value: string | null): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const safe = sanitize(v).replace(/[|\r\n]+/g, ' ').trim().slice(0, 60);
  return safe ? `- **${label}:** ${safe}` : null;
}

function issueBody(sub: SubmissionRow, env: Env, attachments: StoredAttachment[]): string {
  // Only facts we actually have. The form collects platform; wallet version,
  // network and route arrive only when the wallet embeds the form, so on the
  // standalone page they are all null — and printing four rows of "not
  // reported" under an empty-header table said nothing, at length.
  const facts = [
    envRow('Platform', sub.platform ? PLATFORM_LABEL[sub.platform] ?? sub.platform : null),
    envRow('Wallet version', sub.wallet_version),
    envRow('Network', sub.network),
    envRow('Route', sub.route),
    envRow('Error code', sub.error_code),
  ].filter((r): r is string => r !== null);

  const environment = facts.length ? `\n## Environment\n\n${facts.join('\n')}\n` : '';
  const attach = attachments.length
    ? `\n## Attachments\n\n${attachments.map(renderAttachment).join('\n\n')}\n`
    : '';

  return `${sub.body_sanitized}
${environment}${attach}
---
*Filed automatically from the in-app feedback form by an anonymous reporter. Pipeline operated by @${env.OPERATOR_HANDLE}; reply here and the operator will see it.*

<!-- mfv2:${sub.submission_id} -->
`;
}

/** One folded report, as the comment needs it. */
interface FoldedReport {
  platform: string | null;
  body: string;
  confidence: number | null;
  linked_at: number;
}

/** Render as a blockquote so the reporter's words are unmistakably theirs. */
function quote(text: string): string {
  return text.split('\n').map((l) => `> ${l}`).join('\n');
}

/**
 * A GitHub comment body cannot exceed 65536 characters. Budget the WHOLE
 * comment rather than clipping each report: a report cut off mid-sentence is
 * worse than one that is absent and counted, because a maintainer cannot tell
 * whether the missing half changed the meaning.
 */
const COMMENT_CHAR_BUDGET = 55_000;

/**
 * Rolling comment: ONE comment per issue, edited in place. Never N comments —
 * GitHub notifies on a new comment but not on an edit, so twenty duplicates
 * cost exactly one notification no matter where COMMENT_THRESHOLD sits.
 *
 * It carries the REPORTS, not just a count. A maintainer cannot judge whether
 * a fold was correct from "one further report matches this issue" — the words
 * are the only evidence, and without them a wrong match is invisible and
 * unappealable. The match confidence is shown for the same reason.
 */
function rollingComment(total: number, reports: FoldedReport[]): string {
  const rendered: string[] = [];
  let used = 0;
  for (const [i, r] of reports.entries()) {
    const meta = [
      r.platform ? PLATFORM_LABEL[r.platform] ?? r.platform : null,
      new Date(r.linked_at).toISOString().slice(0, 10),
      r.confidence != null ? `matched at ${r.confidence.toFixed(2)}` : null,
    ].filter(Boolean).join(' · ');
    // Full text, never clipped mid-sentence.
    const entry = `**${i + 1}.** ${meta}\n\n${quote(r.body)}`;
    if (used + entry.length > COMMENT_CHAR_BUDGET) break;
    rendered.push(entry);
    used += entry.length;
  }

  const headline = total === 1
    ? 'One further report matches this issue:'
    : `**${total}** further reports match this issue:`;

  const omitted = total > rendered.length
    ? `\n\n_Showing ${rendered.length} of ${total}. The rest are recorded but omitted to keep this comment within GitHub's size limit._`
    : '';

  return `### Additional reports from the in-app feedback form

${headline}

${rendered.join('\n\n')}${omitted}

---

Matched automatically by similarity, not by a human. **If any of these is a
different defect, reply and it can be filed separately.**

*Edited in place as more arrive, rather than reposted.*

<!-- mfv2-rollup -->
`;
}

async function foldIntoIssue(env: Env, sub: SubmissionRow, issueNumber: number, confidence: number) {
  const token = env.GITHUB_WRITE_TOKEN;
  const repo = env.TARGET_REPO;

  await env.DB.prepare(
    `INSERT INTO dup_links (submission_id, issue_number, confidence, linked_at)
     VALUES (?,?,?,?) ON CONFLICT DO NOTHING`
  ).bind(sub.submission_id, issueNumber, confidence, Date.now()).run();

  const totals = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM dup_links WHERE issue_number = ?'
  ).bind(issueNumber).first<{ n: number }>();

  // The reports themselves, newest first. Bounded: a comment has a size limit
  // and nobody reads the fiftieth excerpt.
  const folded = await env.DB.prepare(
    `SELECT s.platform, s.body_sanitized AS body, d.confidence, d.linked_at
       FROM dup_links d JOIN submissions s ON s.submission_id = d.submission_id
      WHERE d.issue_number = ?
      ORDER BY d.linked_at DESC LIMIT 10`
  ).bind(issueNumber).all<FoldedReport>();

  const count = totals?.n ?? 1;
  const threshold = Number(env.COMMENT_THRESHOLD ?? 3);

  // KILL SWITCH. The gate below only guards new-issue creation, and folds
  // never reach it — so with PUBLISH_ENABLED=false this path would still have
  // labelled and commented on someone else's issue. The fold itself is already
  // recorded in D1 above; suppressing the write loses nothing, and the comment
  // appears on the next fold once writes are re-enabled.
  // Checked as an env var rather than through the gate so it consumes no cap
  // budget: folding a duplicate must stay free.
  if (env.PUBLISH_ENABLED !== 'true') {
    console.warn(JSON.stringify({ job: 'fold', issue: issueNumber, suppressed: 'killswitch', folds: count }));
    return;
  }

  // Escalation ladder. Rung 1 — silent. Most duplicates stop here and cost
  // GitHub nothing at all.
  if (count < threshold) return;

  // Rung 2 removed with the label reduction: there is only one label now, and
  // the issue already carries it. The ladder is therefore silent until the
  // threshold, then one rolling comment.

  // Rung 3 — one rolling comment, edited in place.
  const existing = await env.DB.prepare(
    "SELECT value FROM sync_state WHERE key = ?"
  ).bind(`rollup:${issueNumber}`).first<{ value: string }>();

  const body = rollingComment(count, folded.results ?? []);

  if (existing?.value) {
    await updateComment(repo, token, Number(existing.value), body);
  } else {
    const commentId = await createComment(repo, token, issueNumber, body);
    await env.DB.prepare(
      `INSERT INTO sync_state (key, value, at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=excluded.at`
    ).bind(`rollup:${issueNumber}`, String(commentId), Date.now()).run();
  }
}

/**
 * Run one submission all the way through. `from` is the state the row held
 * before it was claimed, so the audit trail records the real transition.
 */
export async function processSubmission(env: Env, sub: SubmissionRow, from: string): Promise<Outcome> {
  const id = sub.submission_id;
  try {
    // --- Idempotency layer 2: terminal states are never reprocessed. -------
    if (sub.state === 'published' || sub.state === 'quarantined') {
      return { kind: 'done', detail: `already ${sub.state}` };
    }

    // --- Idempotency layer 3: has GitHub already got this? -----------------
    const already = await markerAlreadyPublished(env.DB, id);
    if (already) {
      await transition(env, id, from, 'published', `recovered marker #${already}`);
      await env.DB.prepare('UPDATE submissions SET published_issue = ? WHERE submission_id = ?')
        .bind(already, id).run();
      return { kind: 'done', detail: `recovered marker #${already}` };
    }

    // --- Classify ----------------------------------------------------------
    const candidates = await retrieveCandidates(env, sub);
    const allowedIssues = new Set(candidates.map((c) => c.number));

    let verdict; let modelVersion = 'none';
    try {
      const r = await classify(sub.body_sanitized, candidates, env as any);
      verdict = validateVerdict(r.verdict, allowedIssues, ALLOWED_LABELS);
      modelVersion = r.modelVersion;
    } catch (e) {
      // Both providers down. Do NOT publish unclassified — that is how
      // duplicates are born. The row waits; nothing is dropped.
      console.warn('classification unavailable, deferring', id, e);
      return {
        kind: 'defer', state: 'deferred', delayMs: CLASSIFY_DEFER_MS,
        detail: 'classifier unavailable',
      };
    }

    await env.DB.prepare(
      `UPDATE submissions SET verdict=?, confidence=?, matched_issue=?, model_version=?,
              prompt_version=?, candidates=?
         WHERE submission_id=?`
    ).bind(verdict.verdict, verdict.confidence, verdict.issue_number,
           modelVersion, PROMPT_VERSION,
           JSON.stringify(candidates.map((c) => c.number)), id).run();

    const dupGate = Number(env.DUP_THRESHOLD ?? 0.85);
    const reviewGate = Number(env.REVIEW_THRESHOLD ?? 0.6);

    // --- Duplicate: fold in. No cap consumed, no new issue. ----------------
    if (verdict.verdict === 'duplicate' && verdict.issue_number && verdict.confidence >= dupGate) {
      await foldIntoIssue(env, sub, verdict.issue_number, verdict.confidence);
      await transition(env, id, from, 'published', `folded into #${verdict.issue_number}`);
      return { kind: 'done', detail: `folded into #${verdict.issue_number}` };
    }

    // --- Uncertain WITH a candidate: fold in rather than risk a dupe. ------
    // A misplaced comment is recoverable; a duplicate issue is maintainer
    // noise someone must triage and close.
    if (verdict.confidence >= reviewGate && verdict.confidence < dupGate && verdict.issue_number) {
      await foldIntoIssue(env, sub, verdict.issue_number, verdict.confidence);
      await transition(env, id, from, 'published', `low-confidence fold #${verdict.issue_number}`);
      return { kind: 'done', detail: `low-confidence fold #${verdict.issue_number}` };
    }

    // --- New issue. This is the only path that consumes cap budget. --------
    const gate = env.PUBLISH_GATE.get(env.PUBLISH_GATE.idFromName('global'));
    const decision = await (await gate.fetch('https://gate/check')).json<any>();

    if (!decision.allowed) {
      // Backpressure, not data loss. The row stays; the drain returns to it.
      console.warn(`capped (${decision.reason}), deferring`, id);
      return {
        kind: 'defer', state: 'capped', delayMs: CAP_DEFER_MS,
        detail: String(decision.reason),
      };
    }

    const attachments: StoredAttachment[] =
      (JSON.parse(sub.attachment_keys ?? '[]') as string[])
        .map((j) => { try { return JSON.parse(j) as StoredAttachment; } catch { return null; } })
        .filter((a): a is StoredAttachment => a !== null);
    // Platform, error code and confidence are all in the issue body's
    // Environment table, so dropping their labels loses no information — it
    // just stops restating it in the label row.
    const labels = ['feedback-form', ...verdict.suggested_labels]
      .filter((l) => ALLOWED_LABELS.has(l));

    await transition(env, id, from, 'publishing');

    const number = await createIssue(env.TARGET_REPO, env.GITHUB_WRITE_TOKEN, {
      title: titleFor(sub, verdict.title),
      body: issueBody(sub, env, attachments),
      labels: [...new Set(labels)],
    });

    await env.DB.prepare('UPDATE submissions SET published_issue = ? WHERE submission_id = ?')
      .bind(number, id).run();
    await transition(env, id, 'publishing', 'published', `#${number}`);
    return { kind: 'done', detail: `#${number}` };
  } catch (err) {
    if (err instanceof RateLimited) {
      // GitHub's problem, not the submission's. Wait it out without spending
      // an attempt.
      console.warn('github rate limited, backing off', err.retryAfterMs);
      return {
        kind: 'defer', state: 'deferred', delayMs: err.retryAfterMs,
        detail: 'github rate limited',
      };
    }
    console.error('publish failed', id, err);
    return { kind: 'fail', error: err instanceof Error ? err.message : String(err) };
  }
}
