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

Two scopes, both served by the `PublishGate` durable object, told apart by the
object's name.

| Scope | Cap | What it is for |
|---|---|---|
| **Global** (`global`) | `CAP_PER_HOUR = 200`, `CAP_PER_DAY = 800` | The circuit breaker. Everything the service creates, from everyone. |
| **Per reporter** (`r:<reporter_key>`) | `REPORTER_CAP_PER_HOUR = 20`, `REPORTER_CAP_PER_DAY = 50` | Fairness between honest reporters. |

Both windows are **rolling**, not calendar: the gate keeps write timestamps and
filters on `now - t`, so budget frees up continuously rather than resetting at
the top of the hour or at midnight.

**The global scope is the only one that is an abuse control.** `reporter_key`
is a hash of the client-supplied `install_id` — a UUID the browser generates
and can clear at will — so anyone determined to flood just rotates it. The
per-reporter cap stops one honest reporter from monopolising the budget; it
stops nothing else. Per-reporter caps also have no ceiling in aggregate: 100
reporters at 20/hour is 2,000/hour, roughly 4× GitHub's ~500/hour secondary
limit, and crossing that throttles the *account* the write token belongs to —
at which point nothing files for anybody.

Sizing: 200 new issues/hour is ~200 content-creating GitHub requests/hour.
Labels travel inside the same `POST /issues` body (`addLabels` exists but is
not on the publish path), so an issue costs one request, not two; a report
carrying an attachment adds one upload. That leaves real headroom under
GitHub's ~80/min and ~500/hr secondary limits. The drain can physically move
only 5 reports/minute — 300/hour — so at 200/hour the cap binds first, which
is the correct ordering: the limit should be a decision, not an accident.

The daily stays 4× the hourly, deliberately: at parity, or even at 2.5×, a
couple of sustained busy hours exhaust the day and every later report crawls.

- Only **new issue creation** consumes budget. Folding a duplicate into an
  existing issue does not, and is never capped.
- The gates are checked **reporter first, then global**. Both consume a slot
  when they allow, so the order decides whose budget is spent on a write that
  then does not happen. A reporter over quota — the everyday case — returns
  without touching the global counter. The reverse order burned a global slot
  on every throttled reporter.
- Hitting a cap **defers**, it does not drop. The row stays in D1 in state
  `capped` and the drain returns to it at the gate's own `resetAt` — the
  moment the window actually clears — bounded to at most `CAP_DEFER_MS`
  (15 min) so a *daily* cap cannot park a row for 20 hours past a config
  change made to free it. A cap costs no retry budget: `attempts` is restored
  when the row is deferred, so backpressure can never park a report as
  `failed`.
- The form shows a capped report as **Queued**, not `Received`. Those were one
  pill until 2026-08-20, so a 45-second wait and a 65-minute one looked
  identical — and identical to a failure.

**History.** These were `1/hour, 3/day` in production until 2026-08-20, while
this document already described 200/800. The throttle was deliberate and the
drift was not: a genuine report waited 65 minutes behind one filed six minutes
earlier, showing nothing but "Received" throughout. Config and document now
agree.

## 4. Where a matched report goes

Two inputs: how confident the match is, and whether the issue is still open.

| Confidence | Issue | Action | Writes on an issue we don't own? |
|---|---|---|---|
| ≥ `AUTO_ACTION_THRESHOLD` (0.85) | **open** | Comment on it, from the **first** match — one comment, **edited in place** thereafter, carrying each report's text | **yes** |
| ≥ `AUTO_ACTION_THRESHOLD` | **closed** | New issue with a real `#N` cross-reference: *"Possibly related to #N, which was previously closed."* | a timeline event only |
| `REVIEW_THRESHOLD`–`AUTO_ACTION_THRESHOLD` (0.60–0.85) | either | New issue, match named in **plain text** — never `#N` | no |
| < `REVIEW_THRESHOLD` | — | New issue, no mention | no |

**One row in that table writes on someone else's issue**, and it needs both
high confidence and an open target. Everything else becomes its own issue,
because the two mistakes cost differently: a duplicate issue takes a maintainer
seconds to close, while a wrong comment lands on their thread with no clean
undo. When there is no data on how well-calibrated the classifier is — and on
2026-08-20 there was none, the dedup path having matched exactly once in 22
classified submissions — prefer the mistake that is cheaper to reverse.

The plain-text form is deliberate, not cosmetic. A `#N` reference puts a
"referenced this issue" event on the other issue's timeline; below the
authorisation threshold the match has not earned that mark, and a
cross-reference would be the same unearned assertion by a quieter route. A
maintainer still reads the number.

`AUTO_ACTION_THRESHOLD` is its own variable rather than a reused
`DUP_THRESHOLD`, so "we think this is a duplicate" and "we may act on that in
public" can move independently. Lower it once there is evidence about how often
a 0.70 match is genuinely the same defect.

The comment quotes each attached report and its match confidence. That is the
only place a maintainer can audit a dedup decision: without the words, a wrong
match is invisible on GitHub and the reporter's text exists solely in D1. It
also gives them a way to object — the comment says plainly that the match was
automatic and can be split out.

**`dup_links` is written only after GitHub confirms the comment.** The row is
the record of a completed write, and `/status` reads it to tell a reporter
"added to existing issue #N". Written first — as it was until 2026-08-20 — that
claim went true before the comment existed and stayed true if it never
happened: a 403, a rate limit, or the kill switch left a reporter told their
report had been merged into an issue that had never heard of it. For the same
reason the kill switch now **defers** an attach instead of completing it
silently; previously the report went terminal and its text surfaced only if
some later report happened to attach to the same issue.

Commenting on the first fold is not noisier than waiting for a third: GitHub
notifies on a new comment but not on an edit, so an issue that collects twenty
duplicates still produces exactly one notification. Waiting only decided how
long the form's "merged into an existing report" went uncorroborated on GitHub.

A closed match is deliberately **not** folded. The report may mean the defect
was not fully resolved, that it has returned, or simply that the reporter's
build predates the change — and the form cannot tell which, because it has no
reporter version to compare against (`wallet_version` is populated only when
the wallet embeds the form, and is NULL on every submission received so far).
The issue body therefore asserts no fix: routing keys on `state` alone, and a
close can be `not planned` as readily as `completed`. All three readings need a
maintainer, and a comment on a closed issue reaches nobody. The closed issue is
never reopened: reopening is a maintainer's judgement, and the cross-reference
puts the new issue on its timeline either way.

The form's own history list reads `dup_links` — "was this report commented onto
that issue" — never `matched_issue`. They diverge on exactly this path, and
reading the wrong one tells a reporter their report was merged when it is
queued for an issue of its own.

Closed matches are the one duplicate path that consumes cap budget, because
they create an issue. The caps in §3 bound it exactly as they bound any other
new issue.

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

## 10. Store Reviews — the handoff reproduces `/submit`'s guards

A store review is a stranger's text in a public listing. It gets exactly the
treatment a submitted report gets, and the handoff is where that has to be
proven rather than assumed.

| `/submit` guard | At the handoff | Why |
| --- | --- | --- |
| Turnstile | **not applicable** | There is no browser. The review was written on a store listing; the caller is our own cron, authenticated to Google or Apple. |
| Rate limit per reporter | **not applicable** | The store's own posting limits bound the volume, and the sync cannot fetch faster than the API allows. |
| `sanitize()` | **reproduced** | Strips markup, neutralises mentions and issue refs, truncates. A review body may not become a GitHub mention or a live issue reference. |
| `scanForSecrets()` | **reproduced, twice** | At sync, so the console renders a flagged review redacted. At the handoff, as a hard refusal. A wallet review can contain a seed phrase someone pasted looking for help, and a public issue is irreversible and indexed within minutes. |
| Attachment sniffing | **not applicable** | Neither store API returns attachments. |
| Flood check | **not applicable, and cannot misfire** | Store rows carry a synthetic `reporter_key` and a NULL `normalized_hash`. `confirmFloodAtDrain` returns false on a NULL hash, and `flood_repeat` evidence requires `reporter_kind === 'install'`, which a store row never is. Store reviews cannot flag each other. |
| Spam gate | **released in advance** | The row is written with `spam_status = 'clean'` and a `spam_reviewed_at`. Release is sticky in `pipeline.ts` — a human who cleared a report outranks the model, permanently — so a human-approved review cannot be re-parked by the classifier. |

**A flagged review stays visible and stays replyable.** It simply can never
enter the pipeline: the handoff's `WHERE` clause requires
`COALESCE(secret_scan_status,'clean') <> 'flagged'`.

### 10.1 The handoff is compare-and-swap

The claiming `UPDATE` requires `handoff_state IN ('none','failed')`,
`eligibility = 'eligible'` and `human_decided_at IS NOT NULL`. `changes === 0`
is a hard stop, not a retry — that is what makes two concurrent clicks produce
exactly one submission. `UNIQUE(handoff_submission_id)` is the second line:
SQLite permits many NULLs in a unique index, so it allows "not handed off" on
every row while making a second claim of the same id impossible.

## 11. The model suggests; a human decides

The classifier reads a review and returns labels from a fixed allowlist plus a
draft reply. It has no tools, no credentials, and no way to move a review
anywhere. Labels outside the allowlist are dropped, not added.

`eligibility` is the gate on the pipeline and is written **only** by a human
action. `undecided` is the default because a review nobody has read must never
be eligible for a public GitHub issue — the absence of a decision has to read
as "no", not as "not yet no".

An injection attempt inside a review body can therefore change one thing: its
own suggested label, which a human is looking at.

## 12. Store kill switches — and the one that is destructive

There is deliberately **no single store kill switch**. Google serves only the
last 7 days of reviews, so turning collection off for a week destroys every
Android review in that window permanently.

| Variable | Default | Turning it off |
| --- | --- | --- |
| `STORE_SYNC_ENABLED` | `"true"` | **Data-destructive.** Only for a credential compromise, and then with the 168-hour countdown understood. |
| `STORE_CLASSIFY_ENABLED` | `"false"` | Safe. Reviews accumulate in `awaiting_review`; humans can still read, reply and hand off. |
| `STORE_REPLY_ENABLED` | `"false"` | Safe. Drafts and approvals persist; nothing is published. |
| `STORE_HANDOFF_ENABLED` | `"false"` | Safe. Decisions are recorded; no `submissions` row is written. **This is the rollback that fully isolates the existing pipeline.** |

Each follows the existing convention that anything but the literal `"true"`
means off, so a typo can never arm a stage.

## 13. Access to the store pages

The Store Reviews pages currently inherit `/admin/review`'s open access. That is
safe only while they are read-only. **Before the reply-approval and handoff
actions land (Phases 5 and 6), those action surfaces must sit behind a
credential:** approving a reply publishes public text under Bread Wallet's
developer account, and the handoff opens a public issue on a third-party
repository. Neither is an action an uncredentialed page may offer.

The repository is public, which means every admin route is discoverable from
source. Decided with Ivan on 2026-09-02.

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
