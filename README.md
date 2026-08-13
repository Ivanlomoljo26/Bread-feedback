# miden-feedback-v2

Feedback intake → dedup → triage → draft GitHub issues for `0xMiden/wallet`.

Greenfield. **Does not touch the existing Bread Wallet feedback form or its Cloudflare Worker relay.** Separate repo, separate Worker, separate D1, separate secrets.

---

## How it works

Fully automated, end to end. No human in the loop.

```
form → Worker → scan → dedup → classify → GitHub issue
```

A user submits feedback; minutes later there is an issue on `0xMiden/wallet`,
labelled and deduplicated. You are not required to be online, awake, or
involved.

Duplicates never create a second issue — they fold into the existing one, and
below a threshold they cost GitHub nothing at all.

**Read `docs/SAFETY-CONTROLS.md` before deploying.** Automated write access to
someone else's repository under your account name has exactly one acceptable
configuration, and the controls there are not optional.

## Isolation from v1

| | v1 relay | v2 (this) |
|---|---|---|
| Worker | existing | `miden-feedback-v2` |
| D1 | existing | `miden-feedback-v2-db` |
| GitHub write | yes | yes — classic token, `public_repo` only |
| Marker | v1 format | `<!-- mfv2:{submission_id} -->` |
| Label | — | `pipeline:v2` on anything this system drafts |

The mirror ingests **all** issues in the repo, including v1's. That is intentional: v1's issues are valid dedup targets.

---

## Setup

```bash
npm install
npx wrangler d1 create miden-feedback-v2-db      # paste the id into wrangler.jsonc
npx wrangler d1 execute miden-feedback-v2-db --remote --file=./schema.sql
# No queues: free tier. The drain cron in wrangler.jsonc replaces them.

# secrets
npx wrangler secret put GITHUB_WRITE_TOKEN   # classic token, public_repo ONLY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put INGEST_HMAC_KEY      # also embedded in public/index.html
npx wrangler secret put BACKFILL_TOKEN       # guards /admin/backfill; NOT in the bundle
npx wrangler secret put LLM_API_KEY_PRIMARY
npx wrangler secret put LLM_API_KEY_FALLBACK

# one-time, run locally with your own gh auth — not from the Worker
./scripts/bootstrap-labels.sh

npx wrangler deploy
npx wrangler dev            # local
```

`GITHUB_WRITE_TOKEN` must be a **classic token with `public_repo` and no
other scope**. Not `repo` — that reaches private repositories and defeats the
containment described in `docs/SAFETY-CONTROLS.md`. The same token serves the
read-only mirror sync.

---

## Build it

Paste `PROMPT.md` into Claude Code from the repo root.

## Docs

| File | What it covers |
|---|---|
| `PROMPT.md` | Build prompt — start here |
| `docs/ARCHITECTURE.md` | Decision record, credential policy, rejected options |
| `docs/SAFETY-CONTROLS.md` | Kill switch, caps, escalation ladder, launch checklist |
| `docs/WIRE-FORMAT.md` | Submission contract |

## Layout

```
src/index.ts          ingest: validate → scan → sanitize → persist; both cron handlers
src/pipeline.ts       triage: fingerprint → retrieve → classify → publish
src/drain.ts          cron loop: claim pending rows, run the pipeline, retry/park
src/cron.ts           mirror sync (read-only)
src/lib/publish.ts    the ONLY module permitted to write to GitHub
src/lib/gate.ts       global volume cap + kill switch (durable object)
src/lib/attachments.ts  R2 store + GitHub upload with fallback
public/index.html     the feedback form
src/lib/validate.ts   Turnstile + HMAC + nonce
src/lib/secret-scan.ts  BIP-39 / key material — quarantine before anything is stored
src/lib/sanitize.ts   neutralize @mentions, #refs, HTML
src/lib/fingerprint.ts  deterministic bucket from the 12-code error taxonomy
src/lib/github.ts     read-only client, ETag-cached
src/lib/classify.ts   LLM adjudication — no tools, strict JSON, two providers
schema.sql            D1
scripts/              label bootstrap
```

## Status

Implemented: ingest, secret scan, sanitize, fingerprint, schema, mirror sync,
label bootstrap, write path, volume caps, kill switch, escalation ladder,
three-layer idempotency.

**Two stubs remain, and both block production:**
- `src/lib/classify.ts` — provider calls. Without them nothing publishes
  (by design: it retries rather than filing unclassified).
- Mirror backfill has to be run once before go-live: POST `/admin/backfill`
  with the `BACKFILL_TOKEN` bearer, repeatedly, until `remaining` is 0.
  An empty mirror has nothing to dedup against, so every report files a
  new issue.
