# Miden Wallet Feedback → GitHub Issues
## Architecture decision record — v3

**Date:** 13 August 2026
**Supersedes:** v1, v2
**Scope:** this repository. The existing Bread Wallet feedback form and its relay are **out of scope and untouched.**

---

## 0. Credential policy — fixed, not up for discussion

Only two credential types are permitted anywhere in this system.

| Purpose | Credential | Scopes |
|---|---|---|
| Reading the repo (dedup mirror) | none, **or** a classic token with **no scopes selected** | none |
| Publishing an issue | your existing `gh` CLI auth (`gho_`), locally, behind the approval gate | as issued |
| Publishing, *if* unattended mode is ever enabled | classic token, **`public_repo` only** | `public_repo` |

Rationale for each:

- **Scopeless classic token for reads.** Authenticates for rate-limit purposes (5,000 req/hr vs 60 anonymous) while granting nothing beyond what an anonymous visitor already sees. Exactly right for a read-only mirror.
- **`public_repo` for writes.** `0xMiden/wallet` is public, so this is sufficient for issues, comments, and labels. It requires **no organization approval at creation or renewal**, and it grants **no private repository access** — which closes the exfiltration path described in §5.
- **Never `repo` in a service.** Your `gh` token has it, which is why that token stays local and behind a human gate. `repo` reaches every private 0xMiden repository the account can see. A process handling anonymous input must not hold it.

Token settings: https://github.com/settings/tokens

---

## 1. Verified facts

Checked against `0xMiden/wallet` via `gh api repos/0xMiden/wallet`:

| Check | Result |
|---|---|
| Authenticated as | `Ivanlomoljo26` |
| `permissions.push` | true |
| `permissions.triage` | true |
| `permissions.pull` | true |
| `permissions.admin` / `maintain` | false |
| `has_issues` | enabled |
| `archived` | false |

**With zero org-admin coordination you can:** create issues, comment, set labels/assignees/milestones at creation, add and remove labels, create new label definitions, edit and delete existing ones, open and close issues.

**You cannot:** change repo settings, branch protection, webhooks, secrets, or install a GitHub App.

Repo: https://github.com/0xMiden/wallet

---

## 2. Architecture

**Two tiers, split where untrusted input would otherwise meet a credential.**

### Tier 1 — ingest and triage
Runs 24/7 on Cloudflare. Anonymous feedback is validated, secret-scanned, sanitized, deduplicated, and stored. Reads the repo to maintain a dedup mirror. **Holds no write credential and has no write path in code.**

### Tier 2 — publish
Tier 1 emits drafts. You review them and publish through `gh` with your own auth, one at a time, under your existing `feedback_github_write_permission` rule.

**Properties this buys:**

- Zero org-admin coordination at any point.
- Nothing worth stealing in the always-on component.
- Physically cannot double-file with the existing relay — it has no write path.
- Reporters never touch GitHub.
- If maintainers ever lock issues or block automation, Tier 1 keeps the full record and Tier 2 degrades to manual export. No single org-side decision destroys the system.

**Cost:** review latency. A crash report waits until you next sit down. If that is unacceptable, see `docs/UNATTENDED.md` — the change is a `public_repo` classic token plus mandatory volume caps, not simply "add a token."

---

## 3. Data flow

```
WALLET / standalone form
  No GitHub account needed. No credentials present.
  Generates submission_id (UUIDv4), reused across retries.
        │  POST { submission_id, body, meta, turnstile_token }
        ▼
TIER 1 — ingest Worker                      [no write credential]
  1. HMAC + Turnstile + nonce
  2. Rate limit (Durable Object: 5/hr per install or IP)
  3. SECRET SCAN — quarantine before storing, never log the value
  4. Sanitize — neutralize @mentions, #refs, HTML
  5. D1 INSERT ... ON CONFLICT DO NOTHING  → state `received`
  6. 202. No enqueue — the row IS the work item.
        ▼
CRON (1 min) — drain                        [attempts + next_attempt_at in D1]
  6a. Claim ≤ DRAIN_BATCH_SIZE pending rows (CAS on state → `claimed`)
  7. Fingerprint from the 12-code error taxonomy
  8. Retrieve candidates from the local mirror
  9. Classify — model has NO TOOLS, strict JSON, schema-validated
 10. Emit draft
        ▼
TIER 2 — you + Claude Code                  [gh auth, per-issue approval]
  gh issue create --repo 0xMiden/wallet --title … --body-file … --label …
  Marker: <!-- mfv2:{submission_id} -->
        ▼
CRON (15 min) — mirror sync                 [read-only, scopeless or no token]
  GET /repos/0xMiden/wallet/issues?state=all&since=…
  Never /search/issues — 30 req/min cap, lexically blind to paraphrase
```

---

## 4. Labels

You can create and edit labels unilaterally. Use it.

| Label | Purpose |
|---|---|
| `source:in-app-feedback` | Provenance. Turns mirror sync into a filtered query; lets maintainers filter the pipeline in or out. |
| `pipeline:v2` | Distinguishes this system's issues from the existing relay's. |
| `triage:auto-deduped` | Absorbed one or more duplicate reports. |
| `triage:needs-review` | Classifier was uncertain. |
| `recurring` | Report count crossed threshold. |
| `err:*` | One per code in the 12-code taxonomy. Makes free-text reports queryable. |
| `platform:*` | android / ios / extension / desktop. |

### Escalation ladder for duplicates
Quietest signal that carries the information wins:

1. **Silent** — increment locally. No GitHub write. Most reports.
2. **Label** — `recurring`, platform bump. Quieter than a comment for subscribers.
3. **Comment** — only for genuinely new diagnostic information, and then edit one rolling comment rather than posting repeatedly.

### Guardrail
`Bash(gh label *)` permits `delete` and `edit`. Renaming or deleting an existing label strips it from every issue using it, irreversibly.

- **Allow:** `Bash(gh label create *)`, `Bash(gh label list *)`
- **Confirm:** `gh label delete`, `gh label edit`

Rule: the pipeline may create labels in its own namespace and apply any label, but never modify or delete a label it did not create.

---

## 5. Security

**Credential storage.** Nothing in the wallet bundle — it ships as an extension and mobile app, so anything in it is extractable. The `gh` token stays local behind the approval gate. Tier 1 holds no write credential.

**Prompt injection — structural, not prompt-engineered.** Feedback text is attacker-controlled by design. The May 2025 Invariant Labs disclosure showed a malicious GitHub issue hijacking an agent via the GitHub MCP server and coercing it into leaking private-repo data publicly (https://invariantlabs.ai/blog/mcp-github-vulnerability). The defence:

1. The model never holds a credential or write tool.
2. Its blast radius is a label and a number.
3. Output validated against the mirror and a label allowlist before any action.
4. In this design, nothing private is in reach of the untrusted path at all.

Prompt hardening is a speed bump, not a control.

**Attachments → R2, not GitHub.** Replaces the undocumented `uploads.github.com/user-attachments/assets` endpoint:
- Removes an unsupported dependency with no SLA or deprecation notice.
- **Enables pre-publication inspection.** Wallet screenshots can show addresses, balances, transaction history, and — during recovery-flow testing — a seed phrase. Publishing to a public issue is irreversible and immediately indexed.
- **Enables deletion.** You can revoke an R2 object. You cannot un-publish a GitHub attachment.

**Current gap:** the scanner is text-only. A screenshot of a seed phrase passes straight through. Until OCR exists, uploaded images must not be referenced in drafts — hold them in R2 under a quarantine prefix. Video is heavier still: frame sampling plus OCR. Consider images-only at launch.

**Content sanitization.** Neutralize `@mentions` (otherwise a submitter can notify arbitrary users and teams from inside your issue body) and `#123` refs (cross-link noise). Secret scan for BIP-39-shaped sequences, hex key material, and labelled secrets. Strip HTML and remote image URLs.

**Rate limits.** Turnstile + HMAC + per-install/IP limiter. Respect `Retry-After` and `x-ratelimit-reset`; circuit-break rather than hammer — GitHub bans integrations that keep requesting while limited. Search 30/min; content creation ~80/min, ~500/hr.

---

## 6. Duplicate detection

**Stage 0 — idempotency, not dedup.** `submission_id` UUID, unique-constrained. Catches retries and double-taps. Keep strictly separate from semantic dedup; conflating them is how one bug becomes three issues.

**Stage 1 — deterministic fingerprint.** Error code + minor version + platform + route. Cheap, explainable, catches the frequent tail.

**Stage 2 — semantic retrieval over the local mirror.** Embeddings, top-k by cosine. **Required before this leaves prototype** — it is the only stage that handles paraphrase, which is the actual problem. GitHub's lexical search will never match *"my tokens vanished after I closed the app"* to *"notes stuck in consuming state."* Closed issues are the highest-value target: regressions.

**Stage 3 — LLM adjudication, top-k only.** No tools. Untrusted text delimited and labelled as data. Strict JSON, schema-validated. Hallucinated issue numbers and off-allowlist labels rejected. Parse failure → `uncertain`. Two providers behind one interface so no single AI vendor is load-bearing.

**Tune against your own history.** You have months of QA reports with known duplicate relationships. Use them as ground truth rather than guessing thresholds.

---

## 7. Reliability

**Three independent idempotency layers:**
1. `submission_id` unique constraint.
2. State machine — `publishing` set *before* the call, so a mid-call crash leaves a row to investigate, not blindly retry.
3. `<!-- mfv2:{submission_id} -->` in the issue body. If D1 is lost or restored stale, truth is reconstructable by scanning the mirror.

| Failure | Behaviour |
|---|---|
| GitHub 5xx | Drain spends an attempt, sets `next_attempt_at` with linear backoff. Ingest unaffected. |
| Rate limited | Honour `Retry-After` as the defer delay. Costs no attempt — GitHub's problem, not the submission's. |
| AI provider down | Secondary; if both down → defer 5 min, no attempt spent. **Never publish unclassified** — that is how duplicates are born. |
| Cap closed | State `capped`, retried in 15 min. Backpressure, not failure: no attempt spent. |
| Retries exhausted | State `failed` with `last_error`. This is the DLQ, kept in D1 — the row is parked and queryable, never deleted. |
| Worker dies mid-flight | The `claimed_at` stamp goes stale and the row is reclaimed on a later tick. |

**Why a cron loop and not Queues.** Queues requires the paid Workers plan;
this runs on the free tier by decision (2026-08-13). The trigger to reverse it
is reports going missing — see "What the drain gives up" below and tag
`queue-design` for the version that used a real queue.

**Audit trail.** Per submission: payload hash, sanitized body, verdict, confidence, **model version, prompt version**, action, GitHub artifact ID, every state transition — including each claim, so a row's full retry history is reconstructable from `state_log` alone.

### What the drain gives up versus Queues

Honest ledger. None of these is fatal at the volume this pipeline is sized
for, and each is a reason to upgrade if it starts to bite.

| Property | Queues | Cron drain |
|---|---|---|
| Pickup latency | Near-instant | Up to 60 s — a cron tick |
| Delivery guarantee | Platform-managed, at-least-once | Our CAS claim. A cron tick that Cloudflare skips is simply skipped; the row waits for the next one |
| Retry/backoff | `max_retries`, platform backoff | `attempts` + `next_attempt_at`, linear backoff, ours to get right |
| Dead letter | Separate durable queue | State `failed` in D1 |
| Throughput ceiling | Scales with consumers | `DRAIN_BATCH_SIZE` per minute, one invocation, serial |
| In-flight recovery | Automatic redelivery | Stale-claim reclaim after 10 min |
| Free-plan limits | n/a (paid) | 50 subrequests and 10 ms CPU **per invocation** — the reason the batch is small |

The throughput ceiling is the number to watch: `DRAIN_BATCH_SIZE` of 3 caps
sustained publication at 180 submissions/hour, comfortably above the
`CAP_PER_HOUR` of 50 that gates issue creation. If the batch size ever has to
rise far enough to approach the subrequest ceiling, that is the signal to buy
Workers Paid rather than keep tuning.

**Scaling.** Tier 1 scales with Cloudflare. Tier 2 volume is bounded by policy, not capacity. Mirror sync is O(new issues), not O(submissions).

---

## 8. Rejected

| Option | Why not |
|---|---|
| GitHub App | Best security model; requires an org owner to install. Keep the seam — isolate token acquisition behind one function so this is a one-file swap if an owner is ever available. |
| OAuth App | Unapproved OAuth apps get no create/update/delete on public org resources by default. Needs approval. |
| Zapier / Make | Same approval block, plus a third party holds write access to your GitHub identity. |
| n8n self-hosted | Adds an always-on host holding a credential for capability already available in a Worker. Visual workflows resist review and version control. |
| Dedicated machine account | Loses labels, assignees, and milestones on issue creation — silently. Fatal for a triage pipeline. |
| MCP / agent in the unattended write path | Grants zero additional permissions; adds non-determinism and documented toxic-flow exposure. Good operator interface, wrong runtime. |

---

## 9. Limitations

1. No anonymous authorship. Every issue has an authenticated author.
2. A GitHub App on `0xMiden` requires an org owner. No workaround.
3. The org can restrict classic tokens, and maintainers can block an account, lock issues, or disable issues — unilaterally, at any time. Zero-coordination is **permitted, not guaranteed**. Tier 1 is the hedge.
4. Search API 30 req/min; content creation ~80/min, ~500/hr.
5. `uploads.github.com/user-attachments/assets` is undocumented.
6. MCP grants no additional permissions.
7. No `Co-authored-by` equivalent for issues.

---

## 10. Build order

**Now**
1. Narrow the label allowlist (§4). Five minutes.
2. Run `scripts/bootstrap-labels.sh` (§4).
3. Deploy Tier 1 in draft-only mode; confirm ingest, scan, and mirror sync.

**Next**
4. Embeddings retrieval + classifier provider calls — the two stubs.
5. Attachment pipeline with quarantine prefix; images only until OCR exists.
6. Run in parallel with the existing relay for a few weeks. Compare v2's verdicts against what the relay actually filed. That gives a real precision number before turning anything off.

**Then, only if review latency proves unacceptable**
7. `docs/UNATTENDED.md` — `public_repo` classic token, volume caps, kill switch, escalation ladder.

---

## 11. Open items

1. **Unattended vs operator loop.** Determines whether step 7 happens at all.
2. **Video: accept or images-only at launch?** Frame-sampling OCR is materially heavier than the image path.
3. **Does `0xMiden/wallet` use issue forms** (`.github/ISSUE_TEMPLATE/*.yml`)? Match the schema so pipeline issues render identically to human ones.
4. **`~/miden-feedback` has no git remote** — needs an origin before anything can push from there.
5. **Tell the maintainers.** Not a permission request. A short note to Wiktor describing the pipeline, the label namespace, and the caps turns an unexpected automation into a known one. It is the only failure mode you cannot engineer around.
