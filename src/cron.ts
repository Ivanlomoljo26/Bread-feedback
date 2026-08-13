/**
 * Scheduled mirror sync. Read-only.
 *
 * Pulls issues updated since the last cursor into issue_mirror. Includes
 * closed issues — regressions are the highest-value dedup target — and
 * includes v1-relay and human-filed issues.
 */

import type { Env } from './index';
import { listIssuesSince, RateLimited } from './lib/github';

export async function syncMirror(env: Env): Promise<void> {
  const cursorRow = await env.DB.prepare("SELECT value FROM sync_state WHERE key='issues_since'").first<{ value: string }>();
  const since = cursorRow?.value ?? null;

  let issues;
  try {
    // The write token reads public issues fine, so the mirror reuses it rather
    // than introducing a second secret to store, rotate and expire.
    issues = await listIssuesSince(env.TARGET_REPO, since, env.GITHUB_WRITE_TOKEN);
  } catch (err) {
    if (err instanceof RateLimited) { console.warn('rate limited, skipping cycle'); return; }
    throw err;
  }
  if (issues.length === 0) return;

  const now = Date.now();
  await env.DB.batch(
    issues.map((i) =>
      env.DB.prepare(
        `INSERT INTO issue_mirror (number,title,body,state,labels,author,created_at,updated_at,marker,synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(number) DO UPDATE SET
           title=excluded.title, body=excluded.body, state=excluded.state,
           labels=excluded.labels, updated_at=excluded.updated_at,
           marker=excluded.marker, synced_at=excluded.synced_at`
      ).bind(i.number, i.title, i.body, i.state, JSON.stringify(i.labels), i.author,
             i.created_at, i.updated_at, i.marker, now)
    )
  );

  const newest = new Date(Math.max(...issues.map((i) => i.updated_at))).toISOString();
  await env.DB.prepare(
    `INSERT INTO sync_state (key,value,at) VALUES ('issues_since',?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=excluded.at`
  ).bind(newest, now).run();

  // TODO: after upsert, compute embeddings for changed rows and store in
  // issue_mirror.embedding. Until then, retrieval is fingerprint + keyword only.
  console.log(`mirror synced: ${issues.length} issues, cursor → ${newest}`);
}
