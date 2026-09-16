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
      and deployed.** Fixed and open for review as of 2026-09-16; not yet
      deployed. Until it is, an interrupted write leaves a review whose original
      is missing and nothing puts it back.
- [ ] **Migration 0011 applied to production D1**, before the Worker that needs
      it (`docs/MIGRATION-0011.md`). Without it, a sync that is rate limited or
      has its credential refused throws where it means to record that.
- [ ] The Worker deployed and `/health` read back: `commit` is the expected SHA
      and both stores appear under `stores`.

### 4. Known limits accepted, not discovered later

- [ ] **The A → B → A pagination loop is unresolved.** `paginate` catches a
      cursor that points at the page it came from (GP28). It does **not** catch
      a longer cycle: a store answering A → B and then B → A walks a different
      page every tick, repeats nothing within any one run, and **records a clean
      success every time** — so the sync collects the same two pages for ever
      while `/health` reports `state: "ok"` with a fresh `lastSuccessHours`, and
      the 7-day window empties behind it. GP29 pins that this is still possible.
      Catching it needs cursor history kept between runs, which is a checkpoint
      change nobody has made.

      Not a reason to hold the switch by itself — no store is known to do this —
      but it is a way the syncs can fail silently, and the person turning them on
      should know that before rather than after. Watch the collected count in the
      console against the stores' own review counts over the first days;
      `/health` will not tell you.
- [ ] **CPU per invocation is unverified** (`docs/FREE-PLAN-HEADROOM.md`). The
      free plan allows 10 ms per cron invocation and nothing local measures it.
      The D1 and subrequest budgets are measured and comfortable; CPU is the one
      that could bite, and it can only be read from the Worker's observability
      after the first live day.

### 5. Ivan's explicit approval to activate

- [ ] Said for **this** change, at the time of the deploy. Not inherited from
      approving the code, the branch, or this document.

## Order on the day

1. Apply migration 0011 to production D1.
2. Remove the sample rows.
3. Merge this PR.
4. Deploy.
5. Read `/health`, then watch the first ticks in the console.

Migration first, always. Sample removal before the first real sync, so the
console is never showing both at once.

## Rollback

`APP_STORE_SYNC_ENABLED` back to `"false"` is safe: App Store Connect serves a
review's whole history, so the next run continues from its checkpoint.

`STORE_SYNC_ENABLED` back to `"false"` is **not** safe and is only for a
credential compromise. Every hour it stays off is an hour of Google's 168-hour
window spent, and reviews that age out of it are recoverable only from a Play
Console CSV export — which nobody is taking today.
