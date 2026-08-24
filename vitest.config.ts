import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Phase 0 harness — see ~/tasks/mfv2-spam-layer-plan-2026-08-24.md.
 *
 * The suite runs against the REAL wrangler.jsonc so bindings, DO classes and
 * the compatibility date are the deployed ones, not a parallel description of
 * them that can drift.
 *
 * Secrets and the two abuse-control limits are overridden here on purpose.
 * Secrets have no value in wrangler.jsonc at all (they are Cloudflare secrets),
 * and pinning the limits keeps the regression suite from failing the day
 * someone tunes CAP_PER_HOUR in production — these tests assert BEHAVIOUR, not
 * the current numbers.
 *
 * Pool v0.22 / vitest 4: configuration is a Vite PLUGIN. The older
 * `defineWorkersConfig` + `test.poolOptions.workers` form no longer resolves.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      /**
       * HERMETIC. wrangler.jsonc declares an `ai` binding, and Workers AI is
       * remote even in local dev — left on, every `npm test` opens an
       * authenticated connection to dash.cloudflare.com, which makes the suite
       * need a logged-in wrangler and a network, and puts a paid binding one
       * mistake away from a test. setup.ts additionally replaces env.AI with a
       * thrower so the degraded-retrieval path is what gets exercised.
       */
      remoteBindings: false,
      miniflare: {
        bindings: {
          TURNSTILE_SECRET: 'test-turnstile-secret',
          INGEST_HMAC_KEY: 'test-hmac-key',
          BACKFILL_TOKEN: 'test-backfill-token',
          GITHUB_WRITE_TOKEN: 'test-gh-token',
          LLM_API_KEY_PRIMARY: 'test-llm-primary',
          LLM_API_KEY_FALLBACK: 'test-llm-fallback',
          // Low enough to trip inside a test without 20 round trips.
          RATE_LIMIT_PER_HOUR: '3',
          // High enough that the publish gate never closes by accident;
          // the cap test lowers it deliberately.
          CAP_PER_HOUR: '100',
          CAP_PER_DAY: '400',
          REPORTER_CAP_PER_HOUR: '50',
          REPORTER_CAP_PER_DAY: '100',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
