/**
 * GitHub WRITE path. The only module in this service permitted to mutate
 * anything on GitHub.
 *
 * Credential: classic token, scope `public_repo` ONLY. Never a token that
 * reaches private repositories — this code runs in the same service that
 * processes anonymous, attacker-controlled input.
 *
 * Every write here is gated by:
 *   1. the kill switch (PUBLISH_ENABLED)
 *   2. the global volume cap (PublishGate durable object)
 *   3. an idempotency check against D1 + the on-issue marker
 */

const UA = 'bread-feedback-form';
const API = 'https://api.github.com';

export class RateLimited extends Error {
  constructor(public retryAfterMs: number) { super(`rate limited ${retryAfterMs}ms`); }
}
export class CapExceeded extends Error {
  constructor(public resetAt: number) { super('volume cap reached'); }
}

function headers(token: string): Record<string, string> {
  return {
    'User-Agent': UA,
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function gh(path: string, token: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, { ...init, headers: headers(token) });

  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    const reset = res.headers.get('x-ratelimit-reset');
    const ms = retryAfter
      ? Number(retryAfter) * 1000
      : reset
        ? Math.max(0, Number(reset) * 1000 - Date.now())
        : 60_000;
    // Continuing to hammer while limited gets integrations banned.
    throw new RateLimited(ms);
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}: ${await res.text()}`);
  return res.json();
}

export interface IssueSpec {
  title: string;
  body: string;
  labels: string[];
}

export async function createIssue(repo: string, token: string, spec: IssueSpec): Promise<number> {
  const data = await gh(`/repos/${repo}/issues`, token, {
    method: 'POST',
    body: JSON.stringify(spec),
  });
  return data.number as number;
}

export async function createComment(repo: string, token: string, issue: number, body: string): Promise<number> {
  const data = await gh(`/repos/${repo}/issues/${issue}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return data.id as number;
}

export async function updateComment(repo: string, token: string, commentId: number, body: string): Promise<void> {
  await gh(`/repos/${repo}/issues/comments/${commentId}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

/** Additive only. Never replaces or removes labels the pipeline did not set. */
export async function addLabels(repo: string, token: string, issue: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;
  await gh(`/repos/${repo}/issues/${issue}/labels`, token, {
    method: 'POST',
    body: JSON.stringify({ labels }),
  });
}

/**
 * Upload a file to GitHub's user-attachments store.
 *
 * PORTED VERBATIM from the v1 relay (worker.js:477-528), which is the only
 * implementation known to return 201 with a PAT. The endpoint is UNDOCUMENTED,
 * so the details below are load-bearing and were each a bug once:
 *
 *   - Content-Type MUST be set. fetch does not set one for a Uint8Array body,
 *     and omitting it is a 400 "Invalid Content-Type" — this is why an earlier
 *     version silently never worked.
 *   - The media type comes from the file's MAGIC BYTES, not its declared type.
 *     Mislabelling is the same 400 as omitting the header.
 *   - The response field is `url`. Reading it as `href` yielded
 *     ![screenshot](undefined) on every success.
 *   - repository_id comes from GET /repos/{repo} — the endpoint takes the
 *     numeric id, not the owner/name string.
 *
 * It lives in this module because it is a GitHub write, and every GitHub write
 * lives in publish.ts. Callers get a URL or null; it never throws.
 */
export async function uploadAttachment(
  bytes: Uint8Array,
  repo: string,
  token: string
): Promise<{ url: string; video: boolean } | null> {
  try {
    const kind = attachmentType(bytes);
    if (!kind) return null;

    const repoMeta = await gh(`/repos/${repo}`, token, { method: 'GET' });
    const params = new URLSearchParams({
      name: kind.name,
      content_type: kind.mime,
      repository_id: String(repoMeta.id),
    });

    const res = await fetch(`https://uploads.github.com/user-attachments/assets?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': UA,
        'Content-Type': kind.mime,
      },
      body: bytes,
    });

    if (!res.ok) return null;
    const { url } = (await res.json().catch(() => ({}))) as { url?: string };
    return url ? { url, video: kind.video } : null;
  } catch {
    // An issue never fails to file because an attachment failed to upload.
    return null;
  }
}

/**
 * Read the media type from magic bytes rather than trusting the declared type.
 * Ported from v1 (worker.js:455-468).
 */
export function attachmentType(
  bytes: Uint8Array
): { mime: string; name: string; video: boolean } | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: 'image/png', name: 'screenshot.png', video: false };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', name: 'screenshot.jpg', video: false };
  }
  // MP4 and friends: an ISO base-media file has an "ftyp" box at offset 4.
  // The leading four bytes are the box length, so the marker is not at 0.
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return { mime: 'video/mp4', name: 'recording.mp4', video: true };
  }
  return null;
}

/**
 * Last-resort idempotency guard.
 *
 * D1 is the primary defence, but if D1 were restored from a stale snapshot
 * we could re-publish something already on GitHub. The marker is embedded in
 * every issue body, so the mirror can answer "does this already exist".
 */
export async function markerAlreadyPublished(db: D1Database, submissionId: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT number FROM issue_mirror WHERE marker = ? LIMIT 1')
    .bind(submissionId)
    .first<{ number: number }>();
  return row?.number ?? null;
}
