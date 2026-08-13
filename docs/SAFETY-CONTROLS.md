# Safety controls

This service files GitHub issues automatically, with no human in the loop.
That is the requirement. These are the controls that make it survivable.

None of them add a human approval step. All of them are automatic.

---

## 1. Credential

**Classic token, scope `public_repo` and nothing else.**

- `0xMiden/wallet` is public, so this is sufficient for issues, comments,
  and labels.
- No organization approval at creation or renewal.
- **No access to any private repository.** This is the control that matters:
  the service processes anonymous, attacker-controlled text, and the May 2025
  GitHub MCP disclosure showed exactly what happens when a process in that
  position holds a credential that can reach private data
  (https://invariantlabs.ai/blog/mcp-github-vulnerability).

Never substitute a broader scope. `repo` reaches every private repository the
account can see and defeats the entire control. Set a 90-day expiry.

Token settings: https://github.com/settings/tokens

Stored as a Worker secret: `wrangler secret put GITHUB_WRITE_TOKEN`.
Never in the wallet bundle, never in git, never in a client-reachable config.

## 2. Kill switch

`PUBLISH_ENABLED = "false"` in `wrangler.jsonc`, then `wrangler deploy`.

Every GitHub write stops within seconds. Ingest, secret scanning, dedup and
storage keep running — nothing is lost, and the backlog drains when you turn
it back on. Test this before launch, not during an incident.

Current consumption is visible at `GET /health`.

## 3. Volume caps

`CAP_PER_HOUR = 50`, `CAP_PER_DAY = 200`, enforced globally by the `PublishGate`
durable object. The daily ceiling is deliberately 4× the hourly: at parity a
single busy hour would exhaust the day's budget and stall every later report.

- Only **new issue creation** consumes budget. Folding a duplicate into an
  existing issue does not.
- Hitting a cap **defers**, it does not drop. The submission stays in D1 in
  state `capped` with `next_attempt_at` 15 minutes out, and the drain cron
  reclaims it then. A cap costs no retry budget: `attempts` is restored when
  the row is deferred, so backpressure can never park a report as `failed`.
- GitHub's own secondary limits are ~80 content-creating requests/min and
  ~500/hr. These caps sit far below that deliberately: the account behind the
  token is accountable for everything it creates, and a runaway loop must hit
  a wall here rather than at GitHub.

## 4. Escalation ladder

Duplicates never produce a new issue, and usually produce nothing at all.

| Rung | Trigger | GitHub cost |
|---|---|---|
| Silent | fewer than `COMMENT_THRESHOLD` (3) matching reports | none |
| Label | threshold crossed | `triage:auto-deduped`, `recurring` — quieter than a comment |
| Comment | threshold crossed | one comment, **edited in place** thereafter |

Twenty duplicate reports become one comment edited twenty times. This is the
difference between an automation the team tolerates and one they ask you to
switch off.

## 5. Secret scanning

Runs before anything is stored, let alone published. Detects BIP-39-shaped
sequences (12/15/18/21/24 words), hex key material, labelled secrets, and
GitHub token formats. A hit quarantines the submission and returns 202 —
deliberately indistinguishable from success, so an attacker learns nothing
and a legitimate user is not alarmed.

**Attachments are published to GitHub.** Images and MP4 render inline in the
issue. A durable copy is kept in R2 first, so a file can be revoked from your
own storage and old links repointed if GitHub's endpoint changes.

The residual risk is accepted deliberately and mitigated at the point of
entry, not after: the form carries a prominent warning above the description
field, and a second reminder directly under the file picker. Automated
scanning cannot see inside an image or a video, so **the user's own check is
the control** for attachment content.

Two things follow:

- Keep both warnings in the form. They are load-bearing, not decoration.
- If a leaked file is reported, delete the R2 object **and** edit the GitHub
  issue. GitHub-hosted attachments cannot be revoked by deleting the R2 copy.

Adding OCR on images and frame-sampled OCR on video would move this from a
user-side control to a system-side one. Worth doing eventually; not a blocker.

## 6. Classification never publishes blind

If both LLM providers are unavailable, the submission is **retried**, not
published unclassified. Publishing without dedup is how one bug becomes
fifteen issues.

Low-confidence matches fold into the candidate issue rather than creating a
new one: a misplaced comment is recoverable, a duplicate issue is maintainer
noise someone must triage and close.

## 7. The model holds nothing

Non-negotiable. The model receives candidates and untrusted text and returns
JSON. `validateVerdict` rejects hallucinated issue numbers and off-allowlist
labels. Deterministic code performs every write.

A successful prompt injection can therefore do exactly one thing: misclassify
a report. It cannot cause an API call, because none is available to it.

## 8. Idempotency — three layers

1. `submission_id` unique constraint in D1.
2. State machine: `publishing` is set *before* the API call, so a mid-call
   crash leaves a row to investigate rather than blindly retry.
3. `<!-- mfv2:{id} -->` marker in every issue body. Checked against the mirror
   before any write. If D1 were lost or restored stale, this alone prevents
   re-publishing.

## 8b. Durability without a queue

There is no Cloudflare Queue. Queues requires the paid Workers plan, and this
runs on the free tier by decision (2026-08-13). A `* * * * *` cron claims a
batch of pending rows and runs each through exactly the same publish path.
Every guard above still applies, in the same order — the cap gate, the three
idempotency layers, never-publish-unclassified, and secret-scan quarantine at
ingest, which happens before any of this and is untouched.

What replaces the queue's guarantees, and what does not:

- **The row is the work item.** Ingest commits to D1 and returns 202. A report
  that reached D1 cannot be lost by a failed handoff, because there is no
  handoff to fail.
- **Retry budget** is `attempts`, incremented at claim time — so a Worker that
  dies mid-flight still burns one, and a crash loop cannot run forever.
  `MAX_ATTEMPTS` reached → state `failed`, parked with `last_error`.
- **Deferrals cost nothing.** Cap closed, classifier down, GitHub rate
  limiting: `attempts` is restored. Only unexplained errors spend budget.
  Backpressure and outages must never park a real report.
- **In-flight ownership** is a compare-and-swap on `state`, so two overlapping
  ticks cannot both claim a row. A claim older than 10 minutes is treated as
  abandoned and reclaimed.
- **Not replaced:** platform-managed redelivery. If Cloudflare skips a cron
  tick, nothing retries it — the row simply waits for the next tick. And
  nothing alerts on `state='failed'`; the launch checklist item is a person
  looking.

`docs/ARCHITECTURE.md` §7 carries the full ledger of what the drain gives up
versus Queues, and the throughput ceiling to watch.

## 9. Labels are additive only

The pipeline creates labels in its own namespace and applies labels. It never
edits or deletes a label definition — deleting one strips it from every issue
using it, irreversibly.

Match your Claude Code allowlist:
- allow: `Bash(gh label create *)`, `Bash(gh label list *)`
- confirm: `gh label delete`, `gh label edit`

---

## Launch checklist

- [ ] `GITHUB_WRITE_TOKEN` is a classic token with **only** `public_repo`
- [ ] Kill switch tested — flip to `false`, confirm writes stop, flip back
- [ ] Caps verified against a scratch repo you own before pointing at `0xMiden/wallet`
- [x] Embeddings retrieval implemented — Workers AI `@cf/baai/bge-small-en-v1.5`,
      vectors in `issue_mirror.embedding`, cosine in the Worker
- [ ] Mirror backfilled — POST `/admin/backfill` until `remaining` is 0.
      An empty mirror means every report looks new and files its own issue
- [ ] Both LLM providers configured, failover tested
- [ ] Parked rows monitored — `SELECT * FROM submissions WHERE state='failed'`
      is the DLQ. Nothing alerts on it; someone has to look
- [ ] Drain confirmed running — `state_log` shows `claimed` transitions within
      a minute of a submission. A cron that never fires looks exactly like a
      quiet day
- [ ] Ran against a scratch repo for a full day at realistic volume
- [ ] Maintainers told the pipeline exists, with the label namespace and caps
