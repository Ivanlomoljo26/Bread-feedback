/**
 * Attachment handling: GitHub upload with R2 fallback.
 *
 * Files are uploaded to GitHub so they render inline in the issue, per the
 * product requirement. R2 is the durable copy and the fallback path.
 *
 * IMPORTANT — the GitHub attachment endpoint is UNDOCUMENTED. It is not in
 * GitHub's REST reference, has no SLA, and no deprecation notice. It is known
 * to return 201 for personal access tokens. Because it can break without
 * warning, every upload writes to R2 first and falls back to an R2 link if
 * GitHub rejects the upload. An issue never fails to file because an
 * attachment failed to upload.
 */

import { uploadAttachment } from './publish';

export const MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'video/mp4'] as const;

export interface StoredAttachment {
  key: string;            // R2 object key — always present
  name: string;
  type: string;
  size: number;
  githubUrl: string | null;  // set when the GitHub upload succeeded
  r2Url: string | null;      // public R2 URL, when R2_PUBLIC_BASE is configured
  video: boolean;            // from magic bytes; decides bare-URL vs image markup
}

export function validateFile(file: File): string | null {
  if (file.size > MAX_BYTES) return `file exceeds ${MAX_BYTES / 1048576} MB`;
  if (!ALLOWED_TYPES.includes(file.type as any)) return `unsupported type ${file.type}`;
  return null;
}

/** Strip path traversal and anything that would break a markdown link. */
export function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').replace(/\.{2,}/g, '.').slice(0, 120) || 'attachment';
}

/**
 * Upload to GitHub's user-attachments store.
 *
 * The request itself lives in publish.ts — it is a GitHub write, and every
 * GitHub write lives in that module. This wrapper only turns a File into the
 * bytes that request needs and keeps the null-on-failure contract:
 *
 *   - resolves to a URL string on success
 *   - resolves to null on ANY failure (never throws)
 * The caller falls back to R2. A broken attachment must never block an issue.
 */
async function uploadToGitHub(
  file: File,
  repo: string,
  token: string
): Promise<{ url: string; video: boolean } | null> {
  try {
    if (file.size > MAX_BYTES) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return await uploadAttachment(bytes, repo, token);
  } catch (err) {
    console.warn('github attachment upload failed, falling back to R2', err);
    return null;
  }
}

export async function storeAttachment(
  file: File,
  submissionId: string,
  env: {
    ATTACHMENTS: R2Bucket;
    TARGET_REPO: string;
    GITHUB_WRITE_TOKEN: string;
    R2_PUBLIC_BASE?: string;
  }
): Promise<StoredAttachment> {
  const name = safeName(file.name);
  const key = `attachments/${submissionId}/${name}`;

  // Durable copy first. If GitHub's undocumented endpoint disappears
  // tomorrow, the file still exists and old links can be repointed.
  await env.ATTACHMENTS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { submissionId, originalName: file.name },
  });

  const uploaded = await uploadToGitHub(file, env.TARGET_REPO, env.GITHUB_WRITE_TOKEN);
  const r2Url = env.R2_PUBLIC_BASE ? `${env.R2_PUBLIC_BASE.replace(/\/$/, '')}/${key}` : null;

  return {
    key,
    name,
    type: file.type,
    size: file.size,
    githubUrl: uploaded?.url ?? null,
    // The sniffed kind decides the markup, not the declared MIME type — a
    // file named .png that is really an MP4 must still render as a player.
    video: uploaded?.video ?? file.type.startsWith('video/'),
    r2Url,
  };
}

/** Markdown for the issue body. Images render inline; MP4 renders as a player on GitHub. */
export function renderAttachment(a: StoredAttachment): string {
  const url = a.githubUrl ?? a.r2Url;
  if (!url) {
    return `- \`${a.name}\` (${(a.size / 1048576).toFixed(1)} MB) — upload failed; stored internally as \`${a.key}\``;
  }
  // GitHub renders a video ONLY from a bare URL on its own line. Wrapping one
  // in link or image syntax yields a dead link instead of a player (v1,
  // worker.js:470-473).
  if (a.video) return url;
  return `![${a.name}](${url})`;
}
