# Build prompt — paste this into Claude Code

> Run from the repo root after extracting the bundle. Everything referenced
> below is already in the tree.

---

You are completing `miden-feedback-v2`, an automated feedback pipeline that
files GitHub issues on `0xMiden/wallet` from an anonymous in-app form.

Read these first, in order, before writing any code:

1. `README.md` — what this is and how it runs
2. `docs/ARCHITECTURE.md` — the decision record, including the credential policy
3. `docs/SAFETY-CONTROLS.md` — the controls that make automated writes survivable
4. `docs/WIRE-FORMAT.md` — the submission contract

## Hard invariants — do not violate these, do not "improve" them

1. **The write credential is a classic GitHub token with scope `public_repo`,
   and no other credential type is permitted anywhere in this project.** Not
   `repo` — that reaches private repositories. Not any other GitHub token
   type, under any circumstance. Do not propose alternatives, do not add them
   to code, comments, or docs, and do not mention them even to rule them out.
   This is settled; treat it as a fixed constraint of the project.
2. **The LLM never holds a tool or a credential.** It receives text, returns
   JSON, and deterministic code performs every write. Do not give the model
   function-calling, MCP access, or a GitHub client.
3. **All GitHub writes live in `src/lib/publish.ts`.** `src/lib/github.ts`
   stays read-only. Do not add a POST to it.
4. **All testing goes to `Ivanlomoljo26/Jovan-GitHub-`.** `TARGET_REPO` in
   `wrangler.jsonc` already points there. Do not change it to `0xMiden/wallet`
   for any reason, including a "quick check". Cutover is a separate deliberate
   step with its own procedure below, and happens only after every box in
   "Definition of done" is ticked. Test noise in the real repo is not
   recoverable.
5. **Do not touch the existing v1 relay or the existing Bread Wallet feedback
   form.** Different repo, different Worker, different database. This project
   is additive.
6. **Caps defer, they never drop.** A capped submission stays in D1 with
   `next_attempt_at` set, and the drain cron reclaims it. It costs no retry
   budget. Losing a report is worse than filing it late.

## Tasks, in order

### 1. `uploadToGitHub()` in `src/lib/attachments.ts`
Currently returns `null`. The GitHub user-attachments endpoint is
undocumented, so do **not** reconstruct the handshake from guesswork — port
the working implementation from the v1 relay verbatim.

Contract: resolve to a URL string on success, resolve to `null` on any
failure. It must never throw. The caller falls back to an R2 link; a broken
attachment must not block an issue from being filed.

### 2. `classify()` in `src/lib/classify.ts`
Wire two providers behind the single exported function so no AI vendor is
load-bearing. Use the existing `SYSTEM` prompt and `buildUserMessage()`, then
pass the parsed response through `validateVerdict()` — which already rejects
hallucinated issue numbers and off-allowlist labels. Do not weaken it.

On primary failure, fall through to secondary. If both fail, throw: the
consumer catches it and retries rather than publishing unclassified.

### 3. Embeddings retrieval in `src/pipeline.ts` → `retrieveCandidates()` — DONE
This is the one that matters. Today it is fingerprint + keyword only, which
misses paraphrase — and paraphrase is the entire reason this system exists.
GitHub's lexical search will never match "my tokens vanished after I closed
the app" to "notes stuck in consuming state".

- Compute embeddings for `issue_mirror` rows in `src/cron.ts` after upsert,
  store in `issue_mirror.embedding`.
- Retrieve top-k by cosine similarity, merge with the existing fingerprint
  hits, dedupe, cap at ~8 candidates.
- Include closed issues. Regressions are the highest-value dedup target.

### 4. Backfill — DONE, as POST `/admin/backfill` (not a script)
One-time full pull of every issue, open and closed, into `issue_mirror` with
embeddings. Idempotent — safe to re-run.

### 5. Tune thresholds against real data
`REVIEW_THRESHOLD` and `AUTO_ACTION_THRESHOLD` in `wrangler.jsonc` are
guesses. (`COMMENT_THRESHOLD` and `DUP_THRESHOLD` are both gone — see
`docs/SAFETY-CONTROLS.md` §4 for what replaced them.) Build a small labelled set from historical QA reports with known
duplicate relationships and measure precision/recall before going live.

## Setup

```bash
npm install
npx wrangler d1 create miden-feedback-v2-db     # paste id into wrangler.jsonc
npx wrangler d1 execute miden-feedback-v2-db --remote --file=./schema.sql
# Queues are paid-only and deliberately not used — see docs/ARCHITECTURE.md §7.
npx wrangler r2 bucket create mfv2-attachments   # needs R2 enabled in the dashboard

npx wrangler secret put GITHUB_WRITE_TOKEN      # classic, public_repo ONLY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put LLM_API_KEY_PRIMARY
npx wrangler secret put LLM_API_KEY_FALLBACK
```

Set `TURNSTILE_SITE_KEY` in `public/index.html`, and `R2_PUBLIC_BASE` in
`wrangler.jsonc` if you want attachment fallback links to resolve.

Run `./scripts/bootstrap-labels.sh` with `REPO=<your-scratch-repo>` first.
It only creates labels — it never edits or deletes one.

## Definition of done

- [ ] `npm run typecheck` clean
- [ ] Form submits end to end against a scratch repo: text-only, with an
      image, with an MP4
- [ ] **Remove** clears the file, and re-picking the same filename still works
- [ ] "Your reports" flips Received → Filed with a working GitHub link
- [ ] After changing `TARGET_REPO` and deploying, the form's "View on GitHub"
      links follow it with **no second edit** — the page must never need an
      HTML change to point at a different repo. Exercise this before cutover
      by pointing `TARGET_REPO` at any other repo you own and reloading
- [ ] Submitting the same `submission_id` twice produces exactly one issue
- [ ] Two paraphrased reports of the same bug produce one issue, not two
- [ ] Third duplicate triggers the rolling comment; fourth **edits** it rather
      than posting again
- [ ] Cap hit → submission lands in state `capped`, is not lost, and files on
      the next window
- [ ] `PUBLISH_ENABLED=false` stops writes while ingest keeps working
- [ ] A submission containing a 12-word phrase is quarantined and returns 202
- [ ] Killing the LLM provider mid-run defers rather than filing unclassified

## Cutover to production

Only after every box above is ticked. Order matters — labels must exist
before the first issue is filed.

1. `REPO=0xMiden/wallet ./scripts/bootstrap-labels.sh`
2. Set `PUBLISH_ENABLED` to `"false"`. Deploy. Writes are now off.
3. Change `TARGET_REPO` to `0xMiden/wallet`. Deploy.
4. Submit one report. Confirm it ingests and classifies but writes nothing.
5. Drop `CAP_PER_HOUR` to `1`, `CAP_PER_DAY` to `3` for the first day.
   **Then put them back.** Left at 1/3 past cutover this is not a safety
   margin, it is an outage: on 2026-08-20 a genuine report waited 65 minutes
   behind one filed six minutes earlier. Production now runs 200/800 global
   plus 20/50 per reporter — see `docs/SAFETY-CONTROLS.md` §3.
6. Set `PUBLISH_ENABLED` to `"true"`. Deploy. Watch the first issue land.
7. Verify labels, inline attachment, marker in body, operator footer.
8. Raise caps to 50/200 after 24 hours.

If step 7 looks wrong, flip `PUBLISH_ENABLED` back to `"false"` and redeploy.
Ingest keeps running; nothing is lost.

Do not skip step 2. Production repo plus writes already enabled means the
first mistake is public and permanent.

## Style

Match what is already there: strict TypeScript, no new dependencies unless
necessary, comments that explain *why* a constraint exists rather than
restating the code. Where you make a judgement call, leave a short comment
saying what you chose and what you rejected.

If a task cannot be completed correctly, stop and say so rather than shipping
a plausible-looking stub. A silently broken dedup path files duplicates into
someone else's repository under my account name.
