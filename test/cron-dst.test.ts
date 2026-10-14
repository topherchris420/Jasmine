import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JasmineDb } from '../src/db/database.ts';
import { matches, nextRun, parseCron } from '../src/service/cron.ts';
import { Scheduler } from '../src/service/scheduler.ts';

const at = (iso: string) => new Date(iso);
const NY = 'America/New_York';

/** Every minute in [from, to) at which the schedule fires. */
function firings(expression: string, timezone: string | undefined, from: string, to: string): string[] {
  const schedule = parseCron(expression, timezone);
  const out: string[] = [];
  for (let t = Date.parse(from); t < Date.parse(to); t += 60_000) if (matches(schedule, new Date(t))) out.push(new Date(t).toISOString());
  return out;
}

describe('cron: Quartz L and trailing time zones', () => {
  it('treats L as the real last day of the month (and L-n as n days before it)', () => {
    const last = parseCron('0 0 12 L * ?', 'UTC');
    expect(nextRun(last, at('2026-02-01T00:00:00Z'))?.toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(nextRun(last, at('2028-02-01T00:00:00Z'))?.toISOString()).toBe('2028-02-29T12:00:00.000Z');
    expect(nextRun(last, at('2026-04-01T00:00:00Z'))?.toISOString()).toBe('2026-04-30T12:00:00.000Z');
    expect(matches(last, at('2026-03-31T12:00:00Z'))).toBe(true);
    expect(matches(last, at('2026-04-30T12:00:00Z'))).toBe(true);
    expect(matches(last, at('2026-03-30T12:00:00Z'))).toBe(false);
    expect(nextRun(parseCron('0 0 9 L-1 * ?'), at('2026-02-01T00:00:00Z'))?.toISOString()).toBe('2026-02-27T09:00:00.000Z');
    expect(() => parseCron('0 0 0 LW * ?')).toThrow(/Invalid cron expression/);
  });

  it('only reads the trailing field as a time zone when it looks like one', () => {
    const friday = parseCron('0 15 10 ? * FRI');
    expect(friday.timezone).toBeUndefined();
    expect(matches(friday, at('2026-10-16T10:15:00Z'))).toBe(true); // a Friday
    expect(matches(friday, at('2026-10-15T10:15:00Z'))).toBe(false);
    expect(parseCron('0 0 9 ? * MON-FRI').timezone).toBeUndefined();
    expect(parseCron('0 0 9 ? * MON', 'Asia/Tokyo').timezone).toBe('Asia/Tokyo');
    expect(parseCron('0 0 0 1/1 * ? * UTC').timezone).toBe('UTC');
    expect(parseCron('30 8 * * * Europe/Paris').timezone).toBe('Europe/Paris');
    expect(parseCron('0 30 8 ? * * CET').timezone).toBe('CET');
    expect(() => parseCron('0 30 8 ? * * Mars/Base')).toThrow(/Unknown time zone "Mars\/Base"/);
  });
});

describe('cron: daylight-saving changes', () => {
  it('fires a fixed-time job once when the local time repeats (fall back)', () => {
    // 2026-11-01: 01:00–01:59 happens twice in New York (EDT, then EST).
    expect(firings('30 1 * * *', NY, '2026-11-01T04:00:00Z', '2026-11-01T09:00:00Z')).toEqual(['2026-11-01T05:30:00.000Z']);
    expect(nextRun(parseCron('30 1 * * *', NY), at('2026-11-01T05:30:00Z'))?.toISOString()).toBe('2026-11-02T06:30:00.000Z');
    // Interval jobs follow the wall clock through both passes.
    expect(firings('*/30 * * * *', NY, '2026-11-01T05:00:00Z', '2026-11-01T07:00:00Z')).toHaveLength(4);
  });

  it('fires a job whose local time is skipped (spring forward) once, right after the change', () => {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00Z), so 02:30 does not exist.
    expect(firings('30 2 * * *', NY, '2026-03-08T05:00:00Z', '2026-03-09T05:00:00Z')).toEqual(['2026-03-08T07:00:00.000Z']);
    expect(nextRun(parseCron('30 2 * * *', NY), at('2026-03-08T00:00:00Z'))?.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(nextRun(parseCron('30 2 * * *', NY), at('2026-03-08T07:00:00Z'))?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
    // Times that exist are unaffected.
    expect(firings('30 3 * * *', NY, '2026-03-08T05:00:00Z', '2026-03-09T05:00:00Z')).toEqual(['2026-03-08T07:30:00.000Z']);
  });

  it('computes nextRun across 23- and 25-hour days', () => {
    const monday = parseCron('30 0 * * 1', NY);
    expect(nextRun(monday, at('2026-03-07T17:00:00Z'))?.toISOString()).toBe('2026-03-09T04:30:00.000Z');
    expect(nextRun(monday, at('2026-10-31T16:00:00Z'))?.toISOString()).toBe('2026-11-02T05:30:00.000Z');
  });

  it('agrees with matches() minute by minute around transitions, including half-hour and 45-minute zones', () => {
    const cases: [string, string][] = [[NY, '2026-03-07T12:00:00Z'], [NY, '2026-10-31T12:00:00Z'], ['Australia/Lord_Howe', '2026-04-04T00:00:00Z'], ['Pacific/Chatham', '2026-09-26T00:00:00Z'], ['Europe/London', '2026-03-28T12:00:00Z']];
    for (const [zone, start] of cases) {
      for (const expression of ['30 2 * * *', '0,45 1-3 * * *', '*/20 * * * *', '59 23 L * *']) {
        const schedule = parseCron(expression, zone);
        const hits = firings(expression, zone, start, new Date(Date.parse(start) + 2 * 86_400_000).toISOString()).map(Date.parse);
        for (let from = Date.parse(start); from < Date.parse(start) + 36 * 3_600_000; from += 47 * 60_000) {
          const expected = hits.find((h) => h > from);
          if (expected !== undefined) expect([zone, expression, new Date(from).toISOString(), nextRun(schedule, new Date(from))?.getTime()]).toEqual([zone, expression, new Date(from).toISOString(), expected]);
        }
      }
    }
  });
});

describe('scheduler', () => {
  const deployment = (trigger: { id: string; type: string; values: Record<string, unknown> }) => ({ flowId: 'nightly', version: 'v1', plan: { triggerId: trigger.id, nodes: new Map([[trigger.id, { node: trigger }]]) } });

  function fakeRuns() {
    const calls: { payload: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
    return {
      calls,
      executeWorkflow: async (_flowId: string, payload: Record<string, unknown>, opts: Record<string, unknown>) => {
        calls.push({ payload, opts });
        return { requestId: `r${calls.length}`, status: 'in-progress' };
      },
      wait: async (requestId: string) => ({ requestId, status: 'success' }),
    };
  }

  it('fires a nightly job once across the fall-back night, as a background (async) run', async () => {
    const db = JasmineDb.memory();
    const d = deployment({ id: 't', type: 'cronNode', values: { cronExpression: '30 1 * * *', cronTimezone: NY } });
    const runs = fakeRuns();
    const scheduler = new Scheduler({ activeFlows: () => [d], getActive: () => d } as never, runs as never, db, {} as never);
    for (let t = Date.parse('2026-11-01T04:00:00Z'); t <= Date.parse('2026-11-01T08:00:00Z'); t += 10_000) await scheduler.tick(new Date(t));
    await new Promise((r) => setTimeout(r, 20));
    expect(runs.calls.map((c) => c.payload['scheduledAt'])).toEqual(['2026-11-01T05:30:00.000Z']);
    // Scheduled runs get the async deadline budget, and the scheduler records the finished status.
    expect(runs.calls[0]!.opts).toMatchObject({ mode: 'async', source: 'cron', version: 'v1' });
    expect(db.get('SELECT last_run_id, last_status FROM schedule_state WHERE flow_id = ?', 'nightly')).toEqual({ last_run_id: 'r1', last_status: 'success' });
  });

  it('runs folder-sync files as background (async) runs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jasmine-sync-'));
    try {
      await writeFile(path.join(dir, 'a.txt'), 'alpha');
      const db = JasmineDb.memory();
      const d = deployment({ id: 't', type: 'localFolderNode', values: { folderPath: dir } });
      const runs = fakeRuns();
      const saved = new Map<string, unknown>();
      const settings = { get: (k: string, fallback: unknown) => saved.get(k) ?? fallback, set: (k: string, v: unknown) => saved.set(k, v) };
      const scheduler = new Scheduler({ activeFlows: () => [d], getActive: () => d } as never, runs as never, db, settings as never);
      expect(await scheduler.syncFolder(d as never, d.plan.nodes.get('t')!.node.values)).toEqual(['r1']);
      expect(runs.calls[0]!.opts).toMatchObject({ mode: 'async', source: 'folder' });
      expect(await scheduler.syncFolder(d as never, d.plan.nodes.get('t')!.node.values)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
