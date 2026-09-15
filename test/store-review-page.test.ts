/**
 * The Store Reviews pages after the review-page rework: filters and their
 * explanations, the identifier, the reply's two buttons, the editable summary and
 * the suggested reply.
 *
 * The properties that matter most:
 *   PF1-PF3  every filter narrows the list, alone and combined, through the same
 *            URL the form submits, so a filter cannot silently stop applying
 *   PF4      a redacted review's hidden text cannot be probed through search
 *   PS1/PS2  Approve reply (Send, while sending is on) saves and approves in one
 *            step and contacts no store; a saved draft is what the page opens with
 *   PM1-PM4  a summary edit is a person's, kept beside the AI's, never over it,
 *            and two people editing at once never overwrite each other silently
 *   PT1-PT4  reply templates are the maintainer's wording, verbatim, each within
 *            the reply limit, picked by the documented rules, apart from the AI
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  callWorker, seedAdmin, seedStoreReview, adminCookie, adminCsrf, adminHeaders, ADMIN_EMAIL, recordedCalls,
  installFetchStub,
} from './helpers';
import { FILTER_TIPS } from '../src/store/admin';
import { pickTemplate, templateText, TEMPLATE_KEYS } from '../src/store/reply-templates';
import { REPLY_MAX_CHARS, replyLength } from '../src/store/reply-panel';
import { runSummary } from '../src/store/summary';

const BASE = 'https://mfv2.test';
const get = async (path: string, headers: Record<string, string> | null = null) =>
  callWorker(new Request(`${BASE}${path}`, { headers: headers ?? await adminHeaders() }));
const html = async (path: string) => (await get(path)).text();

async function post(path: string, fields: Record<string, string>, csrf = true) {
  const form = new FormData();
  if (csrf) form.set('csrf', await adminCsrf());
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return callWorker(new Request(`${BASE}${path}`, { method: 'POST', body: form, headers: { cookie: await adminCookie() } }));
}

/** The platform_review_ids a list page shows, in order. */
const listed = (page: string) => [...page.matchAll(/<span class="rv-key">([^<]+)<\/span><span class="rv-arrow"/g)].map((m) => m[1]);

beforeEach(async () => {
  await seedAdmin();
  for (const t of ['store_review_events', 'store_review_versions', 'store_review_replies', 'store_reviews']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

// ---- filters ---------------------------------------------------------------------------

describe('filters', () => {
  /** Six Android reviews that differ in every filtered column, plus one iOS review that must never show. */
  async function seedMatrix() {
    const T = Date.parse('2026-09-10T00:00:00Z');
    const rows: Array<Record<string, unknown>> = [
      { platform_review_id: 'a-new', review_state: 'awaiting_review', eligibility: 'undecided', ai_labels: '["bug","functional_issue"]', rating: 2, review_body: 'Private send spins forever' },
      { platform_review_id: 'a-act', review_state: 'actionable', eligibility: 'eligible', human_labels: '["ui_issue"]', ai_labels: '["praise"]', rating: 3, review_body: 'Buttons overlap the balance', reply_state: 'drafted' },
      { platform_review_id: 'a-not', review_state: 'not_actionable', eligibility: 'not_eligible', human_labels: '["praise"]', rating: 5, review_body: 'Smoothest wallet', reply_state: 'published' },
      { platform_review_id: 'a-info', review_state: 'needs_info', eligibility: 'not_eligible', human_labels: '["insufficient_info"]', rating: 4, review_body: 'Balance looks wrong sometimes' },
      { platform_review_id: 'a-red', review_state: 'awaiting_review', eligibility: 'undecided', rating: 1, review_body: 'abandon ability able about above absent', secret_scan_status: 'flagged' },
      { platform_review_id: 'a-queued', review_state: 'actionable', eligibility: 'eligible', human_labels: '["bug"]', rating: 1, review_body: 'Crash on open', handoff_state: 'accepted' },
      { platform_review_id: 'i-other', platform: 'ios', review_state: 'actionable', eligibility: 'eligible', human_labels: '["bug"]', rating: 1, review_body: 'Crash on open' },
    ];
    for (const [i, r] of rows.entries()) {
      await seedStoreReview({ secret_scan_status: 'clean', review_created_at: T + i * 60_000, ...r });
    }
  }

  const cases: Array<[string, string[]]> = [
    ['', ['a-queued', 'a-red', 'a-info', 'a-not', 'a-act', 'a-new']],
    ['state=awaiting_review', ['a-red', 'a-new']],
    ['state=actionable', ['a-queued', 'a-act']],
    ['state=not_actionable', ['a-not']],
    ['state=needs_info', ['a-info']],
    ['reply=none', ['a-queued', 'a-red', 'a-info', 'a-new']],
    ['reply=drafted', ['a-act']],
    ['reply=published', ['a-not']],
    ['handoff=accepted', ['a-queued']],
    ['handoff=none', ['a-red', 'a-info', 'a-not', 'a-act', 'a-new']],
    ['eligibility=undecided', ['a-red', 'a-new']],
    ['eligibility=eligible', ['a-queued', 'a-act']],
    ['eligibility=not_eligible', ['a-info', 'a-not']],
    ['label=bug', ['a-queued', 'a-new']],
    // A person's labels overrule the AI's: a-act was suggested praise and labelled ui_issue.
    ['label=praise', ['a-not']],
    ['label=ui_issue', ['a-act']],
    ['rating=1', ['a-queued', 'a-red']],
    ['rating=5', ['a-not']],
    ['flagged=yes', ['a-red']],
    ['flagged=no', ['a-queued', 'a-info', 'a-not', 'a-act', 'a-new']],
    ['q=balance', ['a-info', 'a-act']],
    ['sort=oldest', ['a-new', 'a-act', 'a-not', 'a-info', 'a-red', 'a-queued']],
    ['sort=rating_high', ['a-not', 'a-info', 'a-act', 'a-new', 'a-queued', 'a-red']],
    // Combinations.
    ['state=actionable&eligibility=eligible&label=bug', ['a-queued']],
    ['state=actionable&handoff=none', ['a-act']],
    ['rating=1&flagged=no', ['a-queued']],
    ['eligibility=not_eligible&q=wallet', ['a-not']],
    ['state=awaiting_review&label=bug&rating=2&reply=none&handoff=none&eligibility=undecided&flagged=no&q=send', ['a-new']],
    ['state=actionable&eligibility=not_eligible', []],
  ];

  it('PF1. every filter and every combination lists exactly the reviews it says, on its own platform', async () => {
    await seedMatrix();
    for (const [query, want] of cases) {
      const page = await html(`/admin/store?platform=android${query ? `&${query}` : ''}`);
      expect(listed(page), query || '(no filter)').toEqual(want);
    }
  });

  it('PF2. the form submits every field, so what the Apply button sends is what PF1 tests', async () => {
    await seedMatrix();
    const page = await html('/admin/store?platform=android&state=actionable&eligibility=eligible');
    const form = page.slice(page.indexOf('<form class="filters"'), page.indexOf('</form>', page.indexOf('<form class="filters"')));
    expect(form).toContain('method="GET" action="/admin/store"');
    for (const name of ['platform', 'q', 'state', 'reply', 'handoff', 'eligibility', 'label', 'rating', 'flagged', 'sort']) {
      expect(form, name).toMatch(new RegExp(`name="${name}"`));
    }
    // The chosen values come back selected, and the chips say them in words.
    expect(form).toContain('<option value="actionable" selected>');
    expect(form).toContain('<option value="eligible" selected>Eligible to send to GitHub</option>');
    expect(page).toContain('>Eligible to send to GitHub ×</a>');
    expect(page).toContain('2 reviews matching');
  });

  it('PF3. filter names and values read as the review page says them', async () => {
    const page = await html('/admin/store?platform=android');
    expect(page).toContain('<label for="f-handoff">GitHub</label>');
    expect(page).not.toContain('Pipeline');
    expect(page).toContain('<option value="undecided">Not decided yet</option>');
    expect(page).toContain('<option value="not_eligible">Not eligible</option>');
    expect(page).toContain('>Apply filters</button>');
  });

  it('PF4. search never matches the hidden text of a redacted review', async () => {
    await seedMatrix();
    // The redacted review's text is six words of a seed phrase. Guessing one must not light it up.
    expect(listed(await html('/admin/store?platform=android&q=abandon'))).toEqual([]);
    expect(await html('/admin/store?platform=android&q=abandon')).toContain('No review matches these filters');
    // It is still reachable, by the filter that says nothing about its text.
    expect(listed(await html('/admin/store?platform=android&flagged=yes'))).toEqual(['a-red']);
  });

  it('PF5. every filter has an (i) whose one-sentence explanation is its accessible description', async () => {
    const page = await html('/admin/store?platform=android');
    for (const key of ['q', 'state', 'reply', 'handoff', 'eligibility', 'label', 'rating', 'flagged', 'sort']) {
      const tip = FILTER_TIPS[key];
      expect(tip, key).toMatch(/^[A-Z][^.]*\.$/);
      expect(page).toContain(`<span class="tip" role="tooltip" id="tip-${key}">`);
      // The field itself and its (i) button are both described by the tooltip.
      expect(page).toMatch(new RegExp(`id="f-${key}"[^>]*aria-describedby="tip-${key}"`));
      expect(page).toMatch(new RegExp(`<button type="button" class="info" aria-label="About [^"]+" aria-describedby="tip-${key}">i</button>`));
      expect(page).toContain(`<label for="f-${key}">`);
    }
    // type="button": opening an explanation never submits the form.
    const infos = page.match(/<button[^>]*class="info"[^>]*>/g) ?? [];
    expect(infos).toHaveLength(9);
    for (const b of infos) expect(b).toContain('type="button"');
  });
});

// ---- identifier ------------------------------------------------------------------------

describe('the review identifier', () => {
  it('PI1. leads each list card as its link, and titles the review page as a permalink under a breadcrumb', async () => {
    const id = await seedStoreReview({ platform: 'ios', platform_review_id: 'sample-as-01', review_title: 'Stuck after update', review_state: 'awaiting_review' });
    const list = await html('/admin/store?platform=ios');
    const head = list.slice(list.indexOf('<div class="card-head">'));
    expect(head.indexOf(`<a class="id rv-link" href="/admin/store/${id}"><span class="rv-key">sample-as-01</span>`)).toBeLessThan(head.indexOf('class="badge'));

    const page = await html(`/admin/store/${id}`);
    expect(page).toContain('<nav class="crumb" aria-label="Breadcrumb">');
    expect(page).toContain('<li><span aria-current="page">sample-as-01</span></li>');
    expect(page).toContain(`<h2 class="rv-title-key"><a class="rv-link rv-link-lg" href="/admin/store/${id}"><span class="rv-key">sample-as-01</span></a></h2>`);
    expect(page.indexOf('rv-title-key')).toBeLessThan(page.indexOf('<article class="card">'));
    // The reviewer's title is in the card with their text, not the page's name.
    expect(page).toContain('<p class="rv-title">Stuck after update</p>');
  });

  it('PI3. the review page calls the handoff GitHub everywhere, history included', async () => {
    const id = await seedStoreReview({ review_state: 'actionable' });
    await env.DB.prepare(`INSERT INTO store_review_events (store_review_id, at, kind, detail, actor) VALUES (?,?,?,?,?)`)
      .bind(id, Date.now(), 'handoff', 'Queued for GitHub', ADMIN_EMAIL).run();
    const page = await html(`/admin/store/${id}`);
    expect(page).toContain('<span class="tag">GitHub</span>');
    expect(page).not.toContain('Pipeline');
  });

  it('PI2. a redacted review still shows no title anywhere', async () => {
    const id = await seedStoreReview({ platform: 'ios', review_title: 'SECRET-TITLE-MARKER', secret_scan_status: 'flagged' });
    expect(await html(`/admin/store/${id}`)).not.toContain('SECRET-TITLE-MARKER');
  });
});

// ---- reply: Save as draft and Send -------------------------------------------------------

describe('reply: Save as draft and Approve reply / Send', () => {
  const rev = (id: string) => env.DB.prepare('SELECT reply_state, current_reply_id FROM store_reviews WHERE store_review_id = ?').bind(id).first<any>();

  it('PS1. Approve reply with nothing saved yet saves and approves in one step, and contacts no store', async () => {
    installFetchStub();
    const id = await seedStoreReview({ review_state: 'awaiting_review' });
    const before = recordedCalls().length;
    const res = await post(`/admin/store/${id}/reply/send`, { reply_id: '', body: 'Thanks for telling us.' });
    expect(res.status).toBe(303);
    const r = await rev(id);
    expect(r.reply_state).toBe('approved');
    const reply = await env.DB.prepare('SELECT * FROM store_review_replies WHERE reply_id = ?').bind(r.current_reply_id).first<any>();
    expect(reply).toMatchObject({ state: 'approved', body: 'Thanks for telling us.', created_by: ADMIN_EMAIL, approved_by: ADMIN_EMAIL, published_at: null });
    const events = (await env.DB.prepare('SELECT detail FROM store_review_events WHERE store_review_id = ? ORDER BY id').bind(id).all<any>()).results.map((e) => e.detail);
    expect(events).toEqual(['Draft saved', 'Reply approved']);
    expect(recordedCalls().length).toBe(before);
    expect(await html(`/admin/store/${id}`)).toContain('Waiting to send. Sending is switched off.');
  });

  it('PS2. Save as draft keeps the text, and reopening the page restores it; Approve reply then approves that draft with any edits', async () => {
    const id = await seedStoreReview({ review_state: 'awaiting_review' });
    expect((await post(`/admin/store/${id}/reply/draft`, { reply_id: '', body: 'First words' })).status).toBe(303);
    const { current_reply_id: draftId } = await rev(id);
    let page = await html(`/admin/store/${id}`);
    expect(page).toContain('/reply/send">Approve reply</button>');
    expect(page).toContain('>First words</textarea>');
    expect(page).toContain(`name="reply_id" value="${draftId}"`);

    expect((await post(`/admin/store/${id}/reply/draft`, { reply_id: draftId, body: 'Second words' })).status).toBe(303);
    page = await html(`/admin/store/${id}`);
    expect(page).toContain('>Second words</textarea>');

    expect((await post(`/admin/store/${id}/reply/send`, { reply_id: draftId, body: 'Final words' })).status).toBe(303);
    expect(await rev(id)).toEqual({ reply_state: 'approved', current_reply_id: draftId });
    expect((await env.DB.prepare('SELECT body, state FROM store_review_replies WHERE reply_id = ?').bind(draftId).first<any>()))
      .toEqual({ body: 'Final words', state: 'approved' });
  });

  it('PS3. Send on a reply someone else has changed is refused, and what was typed is kept on the page', async () => {
    const id = await seedStoreReview({ review_state: 'awaiting_review' });
    await post(`/admin/store/${id}/reply/draft`, { reply_id: '', body: 'Theirs' });
    const res = await post(`/admin/store/${id}/reply/send`, { reply_id: '', body: 'Mine, typed on a stale page' });
    expect(res.status).toBe(409);
    const page = await res.text();
    expect(page).toContain('What you typed (not saved)');
    expect(page).toContain('Mine, typed on a stale page');
    expect((await rev(id)).reply_state).toBe('drafted');
  });

  it('PS4. Send needs the CSRF token and a reply', async () => {
    const id = await seedStoreReview({ review_state: 'awaiting_review' });
    expect((await post(`/admin/store/${id}/reply/send`, { reply_id: '', body: 'x' }, false)).status).toBe(403);
    expect((await post(`/admin/store/${id}/reply/send`, { reply_id: '', body: '   ' })).status).toBe(400);
    expect((await rev(id)).current_reply_id).toBeNull();
  });
});

// ---- summary -----------------------------------------------------------------------------

describe('the editable summary', () => {
  const ai = JSON.stringify({ summary: 'Sends hang at proving.', affected_area: 'Send', reproducible: true, missing_information: 'logs' });
  const summaryRow = (id: string) => env.DB.prepare(
    'SELECT human_summary, human_summary_by, human_summary_at, ai_structured FROM store_reviews WHERE store_review_id = ?'
  ).bind(id).first<any>();

  it('PM1. saving an edit keeps the AI summary untouched, shows the edit with who made it, and records it', async () => {
    const id = await seedStoreReview({ review_state: 'awaiting_review', ai_structured: ai, ai_classified_at: Date.now() });
    const res = await post(`/admin/store/${id}/summary`, { seen: '', summary: '  Private sends hang at the proving step on Android 14.  ' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/store/${id}#suggestion`);
    const row = await summaryRow(id);
    expect(row.human_summary).toBe('Private sends hang at the proving step on Android 14.');
    expect(row.human_summary_by).toBe(ADMIN_EMAIL);
    expect(row.ai_structured).toBe(ai);
    const page = await html(`/admin/store/${id}`);
    expect(page).toContain('>Private sends hang at the proving step on Android 14.</textarea>');
    expect(page).toContain(`Edited by ${ADMIN_EMAIL}`);
    expect(page).toContain("<summary>The AI's original summary</summary><p>Sends hang at proving.</p>");
    const ev = await env.DB.prepare("SELECT kind, detail, actor FROM store_review_events WHERE store_review_id = ?").bind(id).first<any>();
    expect(ev).toEqual({ kind: 'summary', detail: 'Summary edited', actor: ADMIN_EMAIL });
  });

  it('PM2. two people editing at once: the second is refused, sees the first edit, and keeps their own text', async () => {
    const id = await seedStoreReview({ review_state: 'awaiting_review', ai_structured: ai, ai_classified_at: Date.now() });
    expect((await post(`/admin/store/${id}/summary`, { seen: '', summary: 'First edit' })).status).toBe(303);
    const res = await post(`/admin/store/${id}/summary`, { seen: '', summary: 'Second edit from a stale page' });
    expect(res.status).toBe(409);
    const page = await res.text();
    expect(page).toContain('This summary changed since the page loaded. Reload to see the latest.');
    expect(page).toContain('>First edit</textarea>');
    expect(page).toContain('Second edit from a stale page');
    expect((await summaryRow(id)).human_summary).toBe('First edit');
  });

  it('PM3. clearing the box removes the edit and shows the AI summary again; saving what is shown records nothing', async () => {
    const id = await seedStoreReview({ review_state: 'awaiting_review', ai_structured: ai, ai_classified_at: Date.now() });
    const now = Date.now();
    expect(await runSummary(env.DB, { reviewId: id, user: 'a@miden.team', seenEditedAt: '', summary: 'Sends hang at proving.', nowMs: now })).toEqual({ ok: true });
    expect((await summaryRow(id)).human_summary).toBeNull();
    expect(await runSummary(env.DB, { reviewId: id, user: 'a@miden.team', seenEditedAt: '', summary: 'Edited', nowMs: now })).toEqual({ ok: true });
    expect(await runSummary(env.DB, { reviewId: id, user: 'b@miden.team', seenEditedAt: String(now), summary: '', nowMs: now + 1 })).toEqual({ ok: true });
    expect(await summaryRow(id)).toMatchObject({ human_summary: null, human_summary_by: null, human_summary_at: null });
    const events = (await env.DB.prepare('SELECT detail FROM store_review_events WHERE store_review_id = ? ORDER BY id').bind(id).all<any>()).results.map((e) => e.detail);
    expect(events).toEqual(['Summary edited', "Summary edit removed, showing the AI's summary"]);
    expect(await html(`/admin/store/${id}`)).toContain('>Sends hang at proving.</textarea>');
  });

  it('PM4. a summary save needs the CSRF token and stays within 500 characters', async () => {
    const id = await seedStoreReview({ review_state: 'awaiting_review', ai_structured: ai, ai_classified_at: Date.now() });
    expect((await post(`/admin/store/${id}/summary`, { seen: '', summary: 'x' }, false)).status).toBe(403);
    const long = await post(`/admin/store/${id}/summary`, { seen: '', summary: 'y'.repeat(501) });
    expect(long.status).toBe(400);
    expect(await long.text()).toContain('y'.repeat(501));
    expect((await summaryRow(id)).human_summary).toBeNull();
  });

  it('PM5. the section drops reproducibility, what is missing, confidence and model; a review with no AI can still be summarised', async () => {
    const id = await seedStoreReview({ review_state: 'awaiting_review', ai_structured: ai, ai_classified_at: Date.now(), ai_confidence: 0.7, ai_model: 'm-1' });
    const page = await html(`/admin/store/${id}`);
    const section = page.slice(page.indexOf('id="suggestion"'), page.indexOf('id="decision"'));
    for (const gone of ['Reproducible', 'Still missing', 'Confidence', 'Model', 'm-1', 'logs']) expect(section, gone).not.toContain(gone);
    expect(section).toContain('Affected area');

    const bare = await seedStoreReview({ review_state: 'new' });
    const bareSection = (await html(`/admin/store/${bare}`)).split('id="suggestion"')[1];
    expect(bareSection).toContain('No AI suggestion yet.');
    expect(bareSection).toContain('No summary yet. Write one and save it.');
    expect(bareSection).toContain(`action="/admin/store/${bare}/summary"`);
  });
});

// ---- reply templates ---------------------------------------------------------------------

describe('reply templates', () => {
  const FORM = 'https://miden-feedback-v2.miden-feedback-relay.workers.dev/';
  const TEXT = {
    positive: "Thank you for the awesome feedback! We're super happy the app is helpful for you. If you ever have ideas on how we can make it even better, feel free to let us know!",
    constructive: "Thanks for taking the time to share your thoughts! We love hearing ideas from our community. We've noted your feature request down for our team to consider in upcoming updates.",
    bug: `We're really sorry to hear you're having trouble! We want to make this right for you. Please share more details through our feedback form: ${FORM} We'd love to help troubleshoot.`,
    general: "Thank you for your candid feedback. We're sorry the app didn't meet your expectations. We're constantly working to make improvements, and your input helps us do just that.",
  };
  const shown = (t: string) => t.replace(/'/g, '&#39;');

  it('PT1. the templates are the maintainer\'s wording, verbatim, complete, and each fits the reply limit', () => {
    for (const k of TEMPLATE_KEYS) {
      expect(templateText(k)).toBe(TEXT[k]);
      // Complete: no placeholder left to fill, no email instruction.
      expect(templateText(k)).not.toMatch(/\[|\]|email/i);
      expect(replyLength(templateText(k)), k).toBeLessThanOrEqual(REPLY_MAX_CHARS);
    }
  });

  it('PT2. the template follows the rating and labels as specified', () => {
    expect(pickTemplate(5, [])).toBe('positive');
    expect(pickTemplate(5, ['feature_request'])).toBe('positive');
    expect(pickTemplate(4, [])).toBe('positive');
    expect(pickTemplate(4, ['feature_request'])).toBe('constructive');
    expect(pickTemplate(3, [])).toBe('constructive');
    expect(pickTemplate(3, ['bug'])).toBe('constructive');
    for (const l of ['bug', 'functional_issue', 'ui_issue', 'ux_issue', 'technical_issue']) {
      expect(pickTemplate(2, [l]), l).toBe('bug');
      expect(pickTemplate(1, ['praise', l]), l).toBe('bug');
    }
    expect(pickTemplate(1, [])).toBe('general');
    expect(pickTemplate(2, ['complaint_no_issue'])).toBe('general');
    expect(pickTemplate(null, [])).toBe('constructive');
  });

  it('PT3. "Reply templates" is its own section, under the reply and apart from the AI summary', async () => {
    const id = await seedStoreReview({ rating: 2, ai_labels: '["bug"]', review_state: 'awaiting_review',
      ai_structured: JSON.stringify({ summary: 'Sends hang.' }), ai_classified_at: Date.now() });
    const page = await html(`/admin/store/${id}`);
    const reply = page.indexOf('id="reply"');
    const templates = page.indexOf('<h3 class="sect" id="templates">Reply templates</h3>');
    const ai = page.indexOf('id="suggestion"');
    expect(reply).toBeGreaterThan(0);
    expect(templates).toBeGreaterThan(reply);
    expect(ai).toBeGreaterThan(templates);
    const tplSection = page.slice(templates, ai);
    expect(tplSection).toContain(`${shown(TEXT.bug)}</textarea>`);
    expect(tplSection).toContain(`maxlength="${REPLY_MAX_CHARS}"`);
    expect(tplSection).not.toContain('Sends hang.');
    expect(page.slice(ai)).not.toContain('data-template-text');
    expect(page).not.toMatch(/support address|Your Support Email/i);
    // A person's labels win over the AI's: complaint, not bug, so General.
    const general = await seedStoreReview({ rating: 1, ai_labels: '["bug"]', human_labels: '["complaint_no_issue"]', review_state: 'not_actionable' });
    expect(await html(`/admin/store/${general}`)).toContain(`${shown(TEXT.general)}</textarea>`);
  });

  it('PT4. a template can be switched, without a script by link; Copy targets the field and waits for the script', async () => {
    const id = await seedStoreReview({ rating: 5, review_state: 'awaiting_review' });
    const page = await html(`/admin/store/${id}?template=general`);
    expect(page).toContain(`${shown(TEXT.general)}</textarea>`);
    expect(page).toMatch(/href="\/admin\/store\/[^"]+\?template=general#templates"[\s\S]*?aria-current="true">General dissatisfaction/);
    // The rating's own pick is still marked as the suggestion.
    expect(page).toMatch(/Positive <span class="tpl-pick">suggested<\/span>/);
    expect(page).toContain('<button type="button" class="btn-primary btn-small" data-copy="template-text" data-status="copy-status" hidden>Copy</button>');
    // An unknown template is ignored, not rendered.
    expect(await html(`/admin/store/${id}?template=<script>`)).toContain(`${shown(TEXT.positive)}</textarea>`);
  });

  it('PT5. the script is served behind sign-in, as JavaScript, with nosniff', async () => {
    const res = await get('/admin/store/review.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const js = await res.text();
    expect(js).toContain('navigator.clipboard.writeText');
    // Copies the field's exact value: no trimming, no markup.
    expect(js).toContain('const text = field.value;');
    expect(js).not.toMatch(/fetch\(|XMLHttpRequest|innerHTML|eval\(/);

    const signedOut = await get('/admin/store/review.js', {});
    expect(await signedOut.text()).not.toContain('navigator.clipboard');
  });
});
