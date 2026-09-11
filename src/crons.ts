/**
 * Every cron string the Worker dispatches on.
 *
 * Must match wrangler.jsonc `triggers.crons` exactly — character for character,
 * one entry per trigger. `scheduled()` does NOTHING for a string it does not
 * recognise (see the note there), so a trigger with no entry here never runs
 * its job, and an entry with no trigger never fires. Test GP14 compares the two
 * sets, reading wrangler.jsonc the way scripts/deploy.sh does.
 */
export const DRAIN_CRON = '* * * * *';
export const MIRROR_CRON = '*/15 * * * *';
/** One Store Reviews phase per tick. See src/store/cron.ts. */
export const STORE_CRON = '*/5 * * * *';
