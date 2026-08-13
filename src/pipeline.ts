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
  createIssue, createComment, updateComment, addLabels,
  markerAlreadyPublished, RateLimited,
} from './lib/publish';
import { renderAttachment, type StoredAttachment } from './lib/attachments';

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

const ALLOWED_LABELS = new Set([
  'source:in-app-feedback', 'pipeline:v2', 'triage:auto-deduped', 'triage:needs-review',
  'recurring', 'platform:android', 'platform:mobile', 'platform:extension',
  'err:NTL_TIMEOUT', 'err:STUCK_NOTE', 'err:BALANCE_MISMATCH', 'err:MISSING_PRIVATE_NOTE',
  'err:CONSUME_STUCK', 'err:SYNC_CURSOR_RESET', 'err:NODE_UNREACHABLE', 'err:TX_SUBMIT_FAILED',
  'err:PROVE_TIMEOUT', 'err:IMPORT_EXPORT_FAILED', 'err:BIOMETRIC_AUTH_FAILED', 'err:UI_RENDER_DEFECT',
]);

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

async function retrieveCandidates(env: Env, sub: SubmissionRow): Promise<Candidate[]> {
  // TODO(required before production): embeddings over issue_mirror.embedding.
  // Fingerprint + keyword handles the frequent tail but NOT paraphrase, which
  // is the whole reason this system exists.
  const byFingerprint = await env.DB.prepare(
    `SELECT m.number, m.title, m.body, m.state
       FROM dup_links d JOIN issue_mirror m ON m.number = d.issue_number
      WHERE d.submission_id IN (SELECT submission_id FROM submissions WHERE fingerprint = ?)
      GROUP BY m.number LIMIT 5`
  ).bind(sub.fingerprint).all<Candidate>();

  const keyword = await env.DB.prepare(
    `SELECT number, title, body, state FROM issue_mirror
      WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 5`
  ).bind(`%${(sub.error_code ?? '').replace(/_/g, ' ').toLowerCase()}%`).all<Candidate>();

  // Both queries select exactly Candidate's columns, so the row type is
  // declared at the query rather than asserted after the fact.
  const seen = new Set<number>();
  return [...(byFingerprint.results ?? []), ...(keyword.results ?? [])]
    .filter((c) => !seen.has(c.number) && seen.add(c.number));
}

function titleFor(sub: SubmissionRow): string {
  const first = sub.body_sanitized.split('\n').find((l) => l.trim()) ?? 'Feedback report';
  const prefix = sub.error_code ? `[${sub.error_code}] ` : '';
  return `${prefix}${first.trim().slice(0, 90)}`;
}

function issueBody(sub: SubmissionRow, env: Env, attachments: StoredAttachment[]): string {
  const attach = attachments.length
    ? `\n## Attachments\n\n${attachments.map(renderAttachment).join('\n\n')}\n`
    : '';

  return `## Report

${sub.body_sanitized}

## Environment

| | |
|---|---|
| Wallet version | ${sub.wallet_version ?? 'not reported'} |
| Platform | ${sub.platform ?? 'not reported'} |
| Network | ${sub.network ?? 'not reported'} |
| Route | ${sub.route ?? 'not reported'} |
| Error code | ${sub.error_code ?? 'unclassified'} |
${attach}
---
*Filed automatically from the in-app feedback form by an anonymous reporter. Pipeline operated by @${env.OPERATOR_HANDLE}; reply here and the operator will see it.*

<!-- mfv2:${sub.submission_id} -->
`;
}

/** Rolling comment: one comment per issue, edited. Never N comments. */
function rollingComment(count: number, platforms: string[], versions: string[]): string {
  return `### Additional reports from the in-app feedback form

**${count}** further report(s) matching this issue.

- Platforms: ${platforms.join(', ') || 'unspecified'}
- Versions: ${versions.join(', ') || 'unspecified'}
- Last seen: ${new Date().toISOString().slice(0, 10)}

*This comment is edited in place rather than reposted, to avoid notification noise.*

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

  const agg = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            GROUP_CONCAT(DISTINCT s.platform)       AS platforms,
            GROUP_CONCAT(DISTINCT s.wallet_version) AS versions
       FROM dup_links d JOIN submissions s ON s.submission_id = d.submission_id
      WHERE d.issue_number = ?`
  ).bind(issueNumber).first<{ n: number; platforms: string | null; versions: string | null }>();

  const count = agg?.n ?? 1;
  const threshold = Number(env.COMMENT_THRESHOLD ?? 3);

  // Escalation ladder. Rung 1 — silent. Most duplicates stop here and cost
  // GitHub nothing at all.
  if (count < threshold) return;

  // Rung 2 — labels. Quieter than a comment for issue subscribers.
  await addLabels(repo, token, issueNumber, ['triage:auto-deduped', 'recurring']);

  // Rung 3 — one rolling comment, edited in place.
  const existing = await env.DB.prepare(
    "SELECT value FROM sync_state WHERE key = ?"
  ).bind(`rollup:${issueNumber}`).first<{ value: string }>();

  const body = rollingComment(
    count,
    (agg?.platforms ?? '').split(',').filter(Boolean),
    (agg?.versions ?? '').split(',').filter(Boolean)
  );

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
      `UPDATE submissions SET verdict=?, confidence=?, matched_issue=?, model_version=?, prompt_version=?
         WHERE submission_id=?`
    ).bind(verdict.verdict, verdict.confidence, verdict.issue_number,
           modelVersion, PROMPT_VERSION, id).run();

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
    const labels = [
      'source:in-app-feedback', 'pipeline:v2',
      ...verdict.suggested_labels,
      ...(sub.platform ? [`platform:${sub.platform}`] : []),
      ...(sub.error_code ? [`err:${sub.error_code}`] : []),
      ...(verdict.confidence < dupGate ? ['triage:needs-review'] : []),
    ].filter((l) => ALLOWED_LABELS.has(l));

    await transition(env, id, from, 'publishing');

    const number = await createIssue(env.TARGET_REPO, env.GITHUB_WRITE_TOKEN, {
      title: titleFor(sub),
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
