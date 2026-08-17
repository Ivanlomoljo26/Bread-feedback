# Safety controls

This service files GitHub issues automatically, with no human in the loop.
That is the requirement. These are the controls that make it survivable.

None of them add a human approval step. All of them are automatic.

---

## 0. Ingress — what actually gates `/submit`

This is a **public web form**. Anyone can open it, read its source, and replay
its requests. Three controls stand between that and the pipeline, in this
order:

1. **Turnstile — the ingress control.** Every submission carries a token that
   the Worker verifies server-side against Cloudflare with `TURNSTILE_SECRET`,
   which lives only on the Worker. A request without a valid token is rejected
   with 403 before it touches the database. This is the gate.

   The widget type is **Managed** (confirmed against the live dashboard
   2026-08-17: `mode = managed`). Do not change the type. Invisible mode
   carries a condition — Cloudflare requires their Turnstile Privacy Addendum
   to be referenced in our own privacy policy — which is why it was rejected on
   2026-08-13.

   The "Success!" card is **no longer shown** (2026-08-17). That is
   `appearance: 'interaction-only'` on the `turnstile.render()` call, which
   changes only *when* the widget is drawn, never the widget type — so the
   Privacy Addendum condition above does not attach. Visitors Managed mode
   clears silently see nothing; visitors it wants to challenge get the checkbox
   automatically.

   **Never hide the widget with CSS instead.** Managed mode is adaptive, so a
   real share of visitors are asked to interact. `display:none` leaves those
   people staring at "Complete the verification check above" with nothing to
   complete, and they cannot report the fault because the form *is* the
   reporting channel. It also will not show up in testing: whoever is testing
   almost certainly gets the silent auto-pass, so the broken path is invisible
   to them. Verified 2026-08-17 in a real browser against the production key —
   see §0.1a.
2. **Rate limiter.** A durable object, `RATE_LIMIT_PER_HOUR` (currently **20**)
   per hour per install id, falling back to IP when no install id is present.
   Sliding window; only submissions that passed Turnstile are counted.
   Bounds a reporter who passes Turnstile and then floods.

   Be honest about its strength: the install id comes from the client's own
   localStorage, so clearing one key resets the bucket. This bounds casual
   flooding, not a determined abuser. Turnstile is the gate, and the
   `PublishGate` caps in §3 are the hard ceiling on what can reach GitHub.
3. **Secret-scan quarantine.** Runs before anything is stored, on the raw body.
   See §5 — it is a data-safety control, not an anti-abuse one.

**HMAC is NOT an ingress control, and must not be described as one.** The form
signs a canonical subset of each submission, and the Worker verifies that
signature *only when it is present*. The key ships inside the client bundle —
the wallet is distributed as an extension and a mobile app, so anything in the
bundle is extractable — which means anyone can sign anything. Requiring a
signature would stop no attacker while reading like authentication to the next
reviewer. It is kept for one narrow purpose: a *wrong* signature indicates a
broken or forked client, so it is worth surfacing as 401. An absent signature
is normal and accepted.

If ingest ever needs real authentication, it needs a credential the client
does not hold. Do not promote the HMAC back to a requirement.

### 0.1a Re-arming the widget — why it is not `reset()`

A Turnstile token is single-use, so the widget must be re-armed after every
send. The form does that with `window.tsRearm()`, which **removes and
re-renders** rather than calling `turnstile.reset()`.

The reason is specific to interaction-only. There is a reported failure where a
widget that was never shown on its first execution stays hidden after `reset()`
even when the new execution *does* require interaction. This form re-arms on
both the success path and the error path, so if that bug is real it strands
anyone filing a second report — silently, and again with no way to tell us. We
could not reproduce it: Cloudflare's test keys are deterministic, so "passed
first, challenged second" is not constructible. A fresh render evaluates
appearance from nothing, so the stale state cannot carry over at all. That
makes reproducing it unnecessary rather than merely unresolved.

**Do not simplify this back to `reset()`** without first constructing that
scenario for real.

Verified 2026-08-17 in headless Chromium against `localhost` (an allowed
domain on the site key), using Cloudflare's test keys plus the production key:

| Case | Expected | Result |
|---|---|---|
| Auto-pass visitor (`1x…AA`) | hidden, token still issued | ✅ height 0, token issued |
| Challenged visitor (`3x…FF`) | widget shows itself | ✅ height 72 |
| Challenged → `tsRearm()` | still visible, new widget id | ✅ no stacking |
| Auto-pass → `tsRearm()` | fresh token, still hidden | ✅ |
| Production key (`0x4AAA…Ql`) | challenged here; re-arms cleanly | ✅ no error |

Reproduce with `python3 -m http.server` in `public/` and the page's own
`?tskey=` override. Headless Chromium is reliably challenged by the production
key, which makes it a usable stand-in for an at-risk visitor.

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

Every GitHub write stops within seconds — new issues, and the labels and
rolling comments that duplicates would otherwise produce. Ingest, secret
scanning, dedup and storage keep running: folds are still recorded in D1, so
nothing is lost and the comment appears on the next fold once writes resume.

That completeness is not free. The `PublishGate` guards only new-issue
creation, and folds never reach it — until 2026-08-13 a third duplicate would
have commented on someone else's issue with the kill switch off. `foldIntoIssue`
now checks `PUBLISH_ENABLED` directly, as an env var rather than through the
gate, so suppressing a comment still consumes no cap budget. Any future GitHub
write added outside the gate needs the same check.

Test this before launch, not during an incident.

Current consumption is visible at `GET /health`.

## 3. Volume caps

`CAP_PER_HOUR = 200`, `CAP_PER_DAY = 800`, enforced globally by the
`PublishGate` durable object. Raised from 50/200 for campaign traffic
(2026-08-13).

Both windows are **rolling**, not calendar: the gate keeps write timestamps and
filters on `now - t`, so budget frees up continuously rather than resetting at
the top of the hour or at midnight.

The daily stays 4× the hourly, deliberately: at parity, or even at 2.5×, a
couple of sustained busy hours exhaust the day and every later report crawls
in 15-minute deferrals. Note that 200 new issues/hour means roughly 400
content-creating GitHub requests/hour once label writes are counted, against
GitHub's ~500/hour secondary limit: the wall this cap exists to hit is no
longer far below GitHub's own.

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
| Silent | fewer than `COMMENT_THRESHOLD` (currently **1**) matching reports | none |
| Comment | threshold crossed | one comment, **edited in place** thereafter, carrying each folded report's text |

The comment quotes each folded report and its match confidence. That is the
only place a maintainer can audit a dedup decision: without the words, a wrong
match is invisible on GitHub and the reporter's text exists solely in D1. It
also gives them a way to object — the comment says plainly that the match was
automatic and can be split out.

At `COMMENT_THRESHOLD = 1` every fold comments immediately. That is not noisier
than 3: GitHub notifies on a new comment but not on an edit, so an issue that
collects twenty duplicates still produces exactly one notification. The
threshold only decides how early the comment appears.

The former label rung (`triage:auto-deduped`, `recurring`) went with the
reduction to a single label on 2026-08-13. Recurrence is still visible — the
rolling comment states the count — but it is no longer filterable from the
issue list. Restoring `recurring` alone would bring that back at the cost of a
second label.

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
- **A refusal is not backpressure.** GitHub answers 403 for a rate limit AND
  for "this token may not", and only the headers tell them apart. Because a
  deferral restores `attempts`, treating every 403 as a limit would make a
  permanent credential failure retry forever while `needsAttention.failed`
  stayed at 0 — an outage that reports itself as healthy. `lib/gh-status.ts`
  defers only on 429, `x-ratelimit-remaining: 0`, or a `retry-after` header;
  every other 403, and any 404 on a write, spends budget and parks in
  `failed`. Verify the credential without writing: `GET /admin/whoami`.
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
- [ ] Parked and quarantined rows monitored — `GET /health` reports
      `needsAttention.quarantined` and `.failed`; `GET /admin/quarantined`
      with the `BACKFILL_TOKEN` bearer lists them with reasons. **Quarantine
      returns 202 to the reporter on purpose, so a false positive is silent:
      a non-zero count is the only signal a real report was discarded.**
      Nothing alerts on it; someone has to look
- [ ] Drain confirmed running — `state_log` shows `claimed` transitions within
      a minute of a submission. A cron that never fires looks exactly like a
      quiet day
- [ ] Ran against a scratch repo for a full day at realistic volume
- [ ] Maintainers told the pipeline exists, with the label namespace and caps
