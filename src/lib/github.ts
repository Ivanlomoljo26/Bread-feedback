/**
 * READ-ONLY GitHub client — mirror sync only.
 *
 * Writes live in src/lib/publish.ts and nowhere else. Keeping the read and
 * write paths in separate modules is deliberate: it makes the boundary
 * visible in the file tree, so an added POST is obvious in review.
 *
 * If you are about to add a write method here, put it in publish.ts instead.
 */

const UA = 'miden-feedback-v2';

export interface MirrorIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  author: string | null;
  created_at: number;
  updated_at: number;
  marker: string | null;
}

function extractMarker(body: string | null): string | null {
  const m = body?.match(/<!--\s*(?:mfv2|miden-feedback):([0-9a-f-]{36})\s*-->/i);
  return m ? m[1] : null;
}

/**
 * Page issues updated since a cursor. Uses the list endpoint, never
 * /search/issues — search is capped at 30 req/min and is lexically blind
 * to paraphrase, which is the exact problem dedup has to solve.
 */
export async function listIssuesSince(
  repo: string,
  since: string | null,
  token?: string
): Promise<MirrorIssue[]> {
  const out: MirrorIssue[] = [];
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let page = 1; page <= 20; page++) {
    const url = new URL(`https://api.github.com/repos/${repo}/issues`);
    url.searchParams.set('state', 'all');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'asc');
    if (since) url.searchParams.set('since', since);

    const res = await fetch(url, { headers });

    if (res.status === 403 || res.status === 429) {
      const retry = res.headers.get('retry-after');
      throw new RateLimited(retry ? Number(retry) * 1000 : 60_000);
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);

    const batch = (await res.json()) as any[];
    if (batch.length === 0) break;

    for (const it of batch) {
      // Pull requests come back from the issues endpoint. Exclude them.
      if (it.pull_request) continue;
      out.push({
        number: it.number,
        title: it.title,
        body: it.body ?? null,
        state: it.state,
        labels: (it.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
        author: it.user?.login ?? null,
        created_at: Date.parse(it.created_at),
        updated_at: Date.parse(it.updated_at),
        marker: extractMarker(it.body ?? null),
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

export class RateLimited extends Error {
  constructor(public retryAfterMs: number) {
    super(`rate limited, retry in ${retryAfterMs}ms`);
  }
}
