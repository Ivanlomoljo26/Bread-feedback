# When the stores are actually contacted

Collection runs in **two cycles a day**: 00:00 and 12:00 in Asia/Manila, which
are 16:00 and 04:00 UTC. Manila is UTC+8 all year, so there is no daylight
saving for the two to drift apart on.

It replaced a cron that ran every five minutes, all day, giving each store a
tick every ten minutes — 144 a day per store, whether or not there was anything
to collect.

## A cycle, not a clock

A **cycle** is a clock fact, not a stored one: `cycleStart(now)` is the most
recent 04:00 or 16:00 UTC. Nothing is written to open a cycle and nothing has to
be cleared to close one.

A source is finished for the cycle once it has **completed a pass** in it —
`last_pass_at`, which only a pass reaching the end of the source ever moves. So:

- a store with nothing new is asked **once** and then left alone until the next
  cycle;
- a store with a backlog is asked again every tick until its pass is done;
- a pass that does not finish inside its window keeps its cursor and **resumes**
  in the next cycle, from where it stopped.

That last point is also why overlapping cycles are impossible without a lock.
There is no "start a cycle" write to race and no flag an invocation can leave
set; two ticks in the same window compute the same answer, and a source that has
not finished simply continues the one pass it already has. There is never a
second pass beside it (GP35).

## The window is a ceiling, not a schedule

`STORE_CRON` is `*/5 4-7,16-19 * * *` — five-minute ticks through four hours
after each cycle opens. That window exists so a backlog can be walked page by
page, because **one page per invocation is what the free plan's 50 queries
allow**; it is not a plan to make 48 requests.

| | Per store |
|---|---|
| Ticks available per cycle | 24 |
| Reviews collectable per cycle | 120 |
| Requests on a quiet day | **1 per cycle** |

Every tick after a store's pass completes costs a single query to discover there
is nothing to do, and contacts nobody.

## What it costs to get wrong

Google Play serves only the last 7 days. Two cycles a day is 14 chances to
collect a review before it ages out of the API for good, and each cycle can take
120 reviews per store — far more than this app will receive. But the number to
watch is not the ceiling, it is whether passes are actually completing:
`/health` reports `coverageGapHours` per store, and `windowConsumed` for Google
Play, both measured from the last **completed pass**. A store that cannot finish
a pass within a cycle will show those climbing (`docs/FREE-PLAN-HEADROOM.md`).

## Changing it

`STORE_CRON` in `src/crons.ts` and `triggers.crons` in `wrangler.jsonc` must
match character for character — test GP14 compares the two sets, and a trigger
with no matching constant silently never runs.

The cycle times themselves are `CYCLE_OFFSET_MS` and `CYCLE_PERIOD_MS` in
`src/store/checkpoint.ts`. **The cron windows have to open at the cycle starts.**
GP33 pins both halves together: if you move one, that test fails until you move
the other, because a tick that fires in a cycle its window does not belong to
would collect nothing and look like a healthy quiet day.
