/**
 * PublishGate — global volume cap across the whole service.
 *
 * This is the primary abuse control, not defence in depth. GitHub's secondary
 * limits are ~80 content-creating requests/min and ~500/hr, and the account
 * behind the token is accountable for everything it creates. A runaway loop
 * or a spam flood must hit a wall here, not at GitHub.
 *
 * Exceeding the cap does NOT drop the report. The submission stays in D1 in
 * state 'capped' and the queue retries it in a later window — backpressure,
 * not data loss.
 */

export interface GateDecision {
  allowed: boolean;
  reason?: 'hourly' | 'daily' | 'killswitch';
  resetAt?: number;
}

export class PublishGate {
  constructor(private state: DurableObjectState, private env: { PUBLISH_ENABLED: string; CAP_PER_HOUR: string; CAP_PER_DAY: string }) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const now = Date.now();

    // Clears the rolling write log. Needed at cutover: the counters carry
    // testing writes into the production window, so day-one caps would refuse
    // real reports for reasons that have nothing to do with production.
    if (url.pathname === '/reset') {
      const before = ((await this.state.storage.get<number[]>('writes')) ?? []).length;
      await this.state.storage.put('writes', []);
      return Response.json({ ok: true, cleared: before });
    }

    if (url.pathname === '/status') {
      const writes = (await this.state.storage.get<number[]>('writes')) ?? [];
      return Response.json({
        lastHour: writes.filter((t) => now - t < 3_600_000).length,
        lastDay: writes.filter((t) => now - t < 86_400_000).length,
        enabled: this.env.PUBLISH_ENABLED === 'true',
      });
    }

    // Kill switch. One env var flip stops every write in the service.
    if (this.env.PUBLISH_ENABLED !== 'true') {
      return Response.json({ allowed: false, reason: 'killswitch' } satisfies GateDecision);
    }

    // Deliberately BELOW the configured caps (50/200). These fire only if the
    // vars go missing, and a config loss must fail tight, never open.
    const perHour = Number(this.env.CAP_PER_HOUR ?? 5);
    const perDay = Number(this.env.CAP_PER_DAY ?? 50);

    const writes = ((await this.state.storage.get<number[]>('writes')) ?? [])
      .filter((t) => now - t < 86_400_000);

    const hourly = writes.filter((t) => now - t < 3_600_000);
    if (hourly.length >= perHour) {
      return Response.json({
        allowed: false, reason: 'hourly',
        resetAt: Math.min(...hourly) + 3_600_000,
      } satisfies GateDecision);
    }
    if (writes.length >= perDay) {
      return Response.json({
        allowed: false, reason: 'daily',
        resetAt: Math.min(...writes) + 86_400_000,
      } satisfies GateDecision);
    }

    writes.push(now);
    await this.state.storage.put('writes', writes);
    return Response.json({ allowed: true } satisfies GateDecision);
  }
}
