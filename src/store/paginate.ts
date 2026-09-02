/**
 * The paging loop, with the fetcher injected.
 *
 * WHY THE FETCHER IS A PARAMETER.
 * Everything hard about syncing a store — how many pages to take before the
 * invocation budget runs out, what to do when page four fails, what the next
 * run resumes from — is independent of who is being called and of any
 * credential. Passing the fetcher in means all of it is built and tested now,
 * while the Google service account is still being provisioned, and Phase 1
 * becomes a wiring job rather than a build job: supply a function that returns
 * one page.
 *
 * It is also how the App Store client reuses this instead of growing its own
 * paging loop with its own subtly different idea of when to stop.
 *
 * PARTIAL PROGRESS IS KEPT, ALWAYS.
 * When a page fails, this returns everything collected up to that point
 * ALONGSIDE the error rather than throwing it away. The caller writes what it
 * has and records the failure. That is safe only because `upsertReview` is
 * idempotent — a page re-read on the next run writes nothing — and it is worth
 * doing because Google's window is 7 days wide: reviews discarded because page
 * four failed may not be offered again.
 */

export interface Page<T> {
  items: T[];
  /** Null or absent means this was the last page. */
  nextToken: string | null;
}

export type FetchPage<T> = (token: string | null) => Promise<Page<T>>;

export interface PaginateOptions {
  /** Resume from here. Null starts at the beginning. */
  startToken?: string | null;
  /**
   * Hard ceiling on pages per invocation.
   *
   * The Workers free plan allows 50 subrequests per invocation, and a sync
   * spends them on more than pages — minting an access token, and whatever the
   * runtime counts for storage. Eight pages leaves generous headroom, and the
   * cost of stopping early is nil: the cursor is saved and the next tick picks
   * up where this one stopped. Running OUT of budget mid-page, by contrast,
   * fails the whole invocation.
   */
  maxPages?: number;
  /** Guards against a server that returns a token pointing at itself. */
  maxItems?: number;
}

export interface PaginateResult<T> {
  items: T[];
  /** Where the next run should resume. Null means the source was exhausted. */
  nextToken: string | null;
  pages: number;
  /** True when the last page was reached — nothing left to collect. */
  exhausted: boolean;
  /**
   * Set when a page threw. `items` still holds everything collected before it,
   * and `nextToken` still points at the page that failed, so the next run
   * retries exactly there.
   */
  error: unknown | null;
}

export const DEFAULT_MAX_PAGES = 8;
export const DEFAULT_MAX_ITEMS = 2000;

export async function paginate<T>(
  fetchPage: FetchPage<T>,
  options: PaginateOptions = {}
): Promise<PaginateResult<T>> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

  const items: T[] = [];
  let token = options.startToken ?? null;
  let pages = 0;
  const seenTokens = new Set<string>();

  while (pages < maxPages && items.length < maxItems) {
    /**
     * A token that has already been used means the server is pointing back at
     * a page we have read. Left alone that is an infinite loop that burns the
     * whole invocation budget and produces nothing; treated as the end of the
     * data it costs, at worst, one delayed page.
     */
    if (token && seenTokens.has(token)) {
      return { items, nextToken: null, pages, exhausted: true, error: null };
    }
    if (token) seenTokens.add(token);

    let page: Page<T>;
    try {
      page = await fetchPage(token);
    } catch (error) {
      // Everything gathered so far is returned, not discarded. `token` still
      // points at the page that failed, so the next run retries exactly there.
      return { items, nextToken: token, pages, exhausted: false, error };
    }

    pages += 1;
    items.push(...(page.items ?? []));

    if (!page.nextToken) {
      // The source is exhausted. A null cursor is stored deliberately: the next
      // run starts from the beginning of a 7-day window, which is what a
      // complete pass should do.
      return { items, nextToken: null, pages, exhausted: true, error: null };
    }
    token = page.nextToken;
  }

  // Budget spent with pages still to come. Not a failure — the cursor is saved
  // and the next tick continues.
  return { items, nextToken: token, pages, exhausted: false, error: null };
}
