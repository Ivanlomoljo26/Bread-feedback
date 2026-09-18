# Turning the store syncs on

This document exists because the change that turns them on is three lines, and
what has to be true before those three lines ship is not.

Once `STORE_SYNC_ENABLED` is `"true"` in production, Bread Wallet's Worker starts
calling Google Play and App Store Connect with real credentials, and starts
collecting real reviews written by real people into a database an admin console
renders. Turning it back off is **data-destructive for Google Play** — Google
serves only the last 7 days, so a week switched off is a week of Android reviews
gone for good (SAFETY-CONTROLS.md §12).

## What this change is

A revert of `6a7ddd5` (#19), which is itself a revert. Three things:

- `STORE_SYNC_ENABLED` and `APP_STORE_SYNC_ENABLED` become `"true"` in
  `wrangler.jsonc`.
- The three `APPLE_ASC_*` names go back into `secrets.required`, so the deploy
  preflight refuses to upload a Worker that is missing them (AS21).
- GP14 and AS21 pin `"true"` again.

No code changes. Every behavioural guarantee it arms was built and tested with
the switches off.

## Blockers — every one of these before the merge

### 1. Credentials exist and are confirmed

- [ ] Google Play service-account key for the **team account**, set as
      `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
- [ ] App Store Connect key for the team account: `APPLE_ASC_KEY_ID`,
      `APPLE_ASC_ISSUER_ID`, `APPLE_ASC_PRIVATE_KEY`.
- [ ] Whoever issued them has confirmed the access each one carries — the Play
      service account has **Reply to reviews**, the App Store key has **Admin or
      Customer Support**. Neither is discoverable from our side without calling
      the API, which is the thing this gate is in front of.

Secrets are set by Ivan, with `npx wrangler secret put <NAME>`. The agent handles
names, never values.

### 2. The sample reviews are out of production D1

- [ ] The eight sample rows are removed
      (`~/tasks/mfv2-sample-reviews-2026-09-15.md` lists them by id;
      `~/tasks/mfv2-scripts/remove-samples-2026-09-15.sql` removes them).

One of them carries an **approved reply** from a walkthrough. Real syncing on top
of samples means a console where invented reviews and real ones are
indistinguishable, and an approved reply sitting in the queue of a system that is
about to gain the ability to send.

### 3. Ingestion is correct before it is fed real data

- [ ] **#27 — an interrupted write losing a review's original — fixed, merged
      and deployed.** Fixed in #28 and open for review as of 2026-09-16; not yet
      deployed. Until it is, an interrupted write leaves a review whose original
      is missing and nothing puts it back.
- [ ] **The A → B → A paging loop — fixed, merged and deployed.** Fixed in #30
      and open for review as of 2026-09-16; not yet deployed. See §4 below for
      what it is and why shipping without it is not an option.
- [ ] **The twice-daily collection cycle merged and deployed.** #31, stacked on
      #30. Without it the syncs run every ten minutes round the clock, which is
      not the schedule this is being switched on for.
- [ ] **Migrations 0011 and 0012 applied to production D1**, in that order and
      both before the Worker that needs them (`docs/MIGRATION-0011.md`,
      `docs/MIGRATION-0012.md`). Without 0011, a sync that is rate limited or
      has its credential refused throws where it means to record that; without
      0012, so does one that finishes a pass.
- [ ] The Worker deployed and `/health` read back: `commit` is the expected SHA
      and both stores appear under `stores`.

### 4. Known limits accepted, not discovered later

- [ ] **The A → B → A paging loop must be fixed before sync is enabled — not
      accepted as a known failure mode.** It is fixed in #30, which is listed as
      a blocker in §3 above; this section says what it was, so that a reviewer
      can tell whether #30 actually closes it.

      `paginate` caught a cursor that pointed at the page it came from and
      nothing longer. A store answering A → B and then B → A walked a different
      page every tick, repeated nothing within any one run, and **recorded a
      clean success every time** — so the sync would collect the same two pages
      for ever while `/health` reported `state: "ok"` with a fresh
      `lastSuccessHours`, and Google's 7-day window emptied behind it.

      What #30 has to be verified to do, before this box is ticked:

      - detect it **across runs**, because one run is one page (GP29);
      - not fire on the legitimate repeats — the same tokens on a later pass
        (GP29b), a cursor the store refuses (GP29c), a transient failure on the
        page the pass is holding (GP29d);
      - **recover**: reset the pass so the next run starts from the top;
      - make it impossible for a stuck loop to keep the health signal looking
        like progress — `cycle_at` cleared only by a completed pass, and
        `windowConsumed` measured from the last completed pass rather than the
        last page fetched (16k).

      One limit remains and is accepted rather than fixed: a cycle whose period
      is longer than 200 pages is not detected, because the pass memory is
      capped so the checkpoint row cannot grow with the backlog
      (`docs/FREE-PLAN-HEADROOM.md`).
- [ ] **CPU per invocation is unverified** (`docs/FREE-PLAN-HEADROOM.md`). The
      free plan allows 10 ms per cron invocation and nothing local measures it.
      The D1 and subrequest budgets are measured and comfortable; CPU is the one
      that could bite, and it can only be read from the Worker's observability
      after the first live day.

### 5. Ivan's explicit approval to activate

- [ ] Said for **this** change, at the time of the deploy. Not inherited from
      approving the code, the branch, or this document.

## Order on the day

1. Apply migrations 0011 and 0012 to production D1, in that order.
2. Remove the sample rows.
3. Merge this PR.
4. Deploy.
5. Read `/health`, then watch the first cycle in the console. `state` should be
   `never` before the first tick and `ok` after it, and `lastCompletedPassHours`
   should stop being null once the first pass finishes.

**Collection runs twice a day**, at 00:00 and 12:00 Asia/Manila
(`docs/SYNC-SCHEDULE.md`), so the first collection is at the next of those after
the deploy, not immediately. The first App Store pass is that app's whole review
history and may legitimately take several cycles to finish; Google's is at most
the last 7 days.

Migration first, always. Sample removal before the first real sync, so the
console is never showing both at once.

## Rollback

`APP_STORE_SYNC_ENABLED` back to `"false"` is safe: App Store Connect serves a
review's whole history, so the next run continues from its checkpoint.

`STORE_SYNC_ENABLED` back to `"false"` is **not** safe and is only for a
credential compromise. Every hour it stays off is an hour of Google's 168-hour
window spent, and reviews that age out of it are recoverable only from a Play
Console CSV export — which nobody is taking today.
