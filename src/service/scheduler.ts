import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { JasmineDb } from '../db/database.ts';
import { toEngineError } from '../errors.ts';
import { extractDocument } from '../vector/extract.ts';
import { matches, nextRun, parseCron, type CronSchedule } from './cron.ts';
import type { DeployedVersion, DeploymentRegistry } from './deployments.ts';
import type { RunService } from './runs.ts';
import type { SettingsStore } from './settings.ts';

export interface ScheduleView {
  flowId: string;
  version: string;
  trigger: 'cronNode' | 'localFolderNode' | 'sourceTriggerNode';
  expression: string;
  timezone: string | null;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastRunId: string | null;
  lastStatus: string | null;
  error?: string;
}

const SCHEDULED_TRIGGERS = new Set(['cronNode', 'localFolderNode', 'sourceTriggerNode']);

/** Fires deployed flows whose trigger is a cron schedule or a local folder sync. */
export class Scheduler {
  private readonly deployments: DeploymentRegistry;
  private readonly runs: RunService;
  private readonly db: JasmineDb;
  private readonly settings: SettingsStore;
  private timer: NodeJS.Timeout | undefined;
  private lastMinute = -1;
  private readonly syncing = new Set<string>();
  log: (message: string) => void = () => {};

  constructor(deployments: DeploymentRegistry, runs: RunService, db: JasmineDb, settings: SettingsStore) {
    this.deployments = deployments;
    this.runs = runs;
    this.db = db;
    this.settings = settings;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`scheduler: ${(e as Error).message}`)), 10_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): ScheduleView[] {
    const out: ScheduleView[] = [];
    for (const d of this.scheduled()) {
      const state = this.db.get<{ last_fired_at: string | null; last_run_id: string | null; last_status: string | null }>('SELECT * FROM schedule_state WHERE flow_id = ?', d.flowId);
      const trigger = d.plan.nodes.get(d.plan.triggerId)!.node;
      const { expression, timezone } = scheduleOf(trigger.type, trigger.values);
      const base = {
        flowId: d.flowId, version: d.version, trigger: trigger.type as ScheduleView['trigger'], expression, timezone: timezone ?? null,
        lastFiredAt: state?.last_fired_at ?? null, lastRunId: state?.last_run_id ?? null, lastStatus: state?.last_status ?? null,
      };
      try {
        const next = nextRun(parseCron(expression, timezone));
        out.push({ ...base, nextRunAt: next?.toISOString() ?? null });
      } catch (e) {
        out.push({ ...base, nextRunAt: null, error: (e as Error).message });
      }
    }
    return out;
  }

  /** Fires everything due in the current minute (each minute is processed at most once). */
  async tick(now = new Date()): Promise<string[]> {
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === this.lastMinute) return [];
    this.lastMinute = minute;
    const fired: string[] = [];
    for (const d of this.scheduled()) {
      const trigger = d.plan.nodes.get(d.plan.triggerId)!.node;
      const { expression, timezone } = scheduleOf(trigger.type, trigger.values);
      let schedule: CronSchedule;
      try {
        schedule = parseCron(expression, timezone);
      } catch {
        continue;
      }
      if (!matches(schedule, now)) continue;
      const state = this.db.get<{ last_fired_at: string | null }>('SELECT last_fired_at FROM schedule_state WHERE flow_id = ?', d.flowId);
      if (state?.last_fired_at && Math.floor(Date.parse(state.last_fired_at) / 60_000) === minute) continue;
      this.record(d.flowId, now.toISOString(), null, 'running');
      fired.push(d.flowId);
      if (trigger.type === 'localFolderNode') void this.syncFolder(d, trigger.values);
      else void this.fireCron(d, trigger.values, now);
    }
    return fired;
  }

  /** Runs a scheduled flow now, as the scheduler would. */
  async runNow(flowId: string): Promise<string | undefined> {
    const d = this.deployments.getActive(flowId);
    if (!d) return undefined;
    const trigger = d.plan.nodes.get(d.plan.triggerId)!.node;
    if (trigger.type === 'localFolderNode') return (await this.syncFolder(d, trigger.values)).at(-1);
    return this.fireCron(d, trigger.values, new Date());
  }

  private scheduled(): DeployedVersion[] {
    return this.deployments.activeFlows().filter((d) => SCHEDULED_TRIGGERS.has(d.plan.nodes.get(d.plan.triggerId)?.node.type ?? ''));
  }

  private async fireCron(d: DeployedVersion, values: Record<string, unknown>, now: Date): Promise<string | undefined> {
    let extra: Record<string, unknown> = {};
    try {
      const raw = values['cronPayload'];
      const parsed = typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extra = parsed as Record<string, unknown>;
    } catch {
      /* invalid payload JSON: fire without it */
    }
    const payload = { ...extra, scheduledAt: new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString(), firedAt: new Date().toISOString() };
    try {
      const res = await this.runs.executeWorkflow(d.flowId, payload, { mode: 'realtime', source: 'cron', version: d.version });
      this.record(d.flowId, now.toISOString(), res.requestId, res.status);
      return res.requestId;
    } catch (e) {
      this.record(d.flowId, now.toISOString(), null, `error: ${toEngineError(e).message}`);
      return undefined;
    }
  }

  /** Runs the flow once per new or changed file in the folder (incremental by size + mtime). */
  async syncFolder(d: DeployedVersion, values: Record<string, unknown>): Promise<string[]> {
    if (this.syncing.has(d.flowId)) return [];
    this.syncing.add(d.flowId);
    const runIds: string[] = [];
    try {
      const root = path.resolve(String(values['folderPath'] ?? ''));
      const globs = (Array.isArray(values['globs']) ? values['globs'] : String(values['globs'] ?? '**/*').split(',')).map((g) => String(g).trim()).filter(Boolean);
      const patterns = (globs.length ? globs : ['**/*']).map(globToRegex);
      const maxFiles = Math.min(Math.max(Math.trunc(Number(values['maxFiles'] ?? 100)) || 100, 1), 1000);
      const key = `folder-sync:${d.flowId}`;
      const seen = this.settings.get<Record<string, string>>(key, {});
      const files = await walk(root, values['recursive'] !== false);
      let processed = 0;
      let lastStatus = 'success';
      for (const file of files) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (!patterns.some((p) => p.test(rel))) continue;
        const info = await stat(file);
        const fingerprint = `${info.size}:${Math.trunc(info.mtimeMs)}`;
        if (seen[rel] === fingerprint) continue;
        if (processed++ >= maxFiles) break;
        let content = '';
        let format = 'text';
        try {
          const doc = extractDocument(await readFile(file), { filename: file });
          content = doc.rows && doc.format === 'csv' ? JSON.stringify(doc.rows) : doc.pages.join('\n\n');
          format = doc.format;
        } catch (e) {
          content = '';
          format = `unreadable: ${(e as Error).message}`;
        }
        const payload = {
          document_key: rel, document_id: createHash('sha256').update(file).digest('hex').slice(0, 32), document_name: path.basename(file),
          document_url: `file://${file}`, content, format, size: info.size, modified: info.mtime.toISOString(), _ab_source_file_last_modified: info.mtime.toISOString(),
        };
        try {
          const res = await this.runs.executeWorkflow(d.flowId, payload, { mode: 'realtime', source: 'folder', version: d.version });
          runIds.push(res.requestId);
          lastStatus = res.status;
          if (res.status === 'success') seen[rel] = fingerprint;
        } catch (e) {
          lastStatus = `error: ${toEngineError(e).message}`;
        }
      }
      this.settings.set(key, seen);
      this.record(d.flowId, new Date().toISOString(), runIds.at(-1) ?? null, processed ? lastStatus : 'no changes');
    } catch (e) {
      this.record(d.flowId, new Date().toISOString(), null, `error: ${toEngineError(e).message}`);
    } finally {
      this.syncing.delete(d.flowId);
    }
    return runIds;
  }

  private record(flowId: string, at: string, runId: string | null, status: string) {
    this.db.run(
      `INSERT INTO schedule_state (flow_id, last_fired_at, last_run_id, last_status) VALUES (?, ?, ?, ?)
       ON CONFLICT (flow_id) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_run_id = COALESCE(excluded.last_run_id, schedule_state.last_run_id), last_status = excluded.last_status`,
      flowId, at, runId, status,
    );
  }
}

function scheduleOf(type: string, values: Record<string, unknown>): { expression: string; timezone: string | undefined } {
  const expression = String(values['cronExpression'] ?? (type === 'localFolderNode' ? '*/15 * * * *' : '')).trim();
  const tz = String(values['cronTimezone'] ?? '').trim();
  return { expression, timezone: tz || undefined };
}

async function walk(dir: string, recursive: boolean, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 12 || out.length > 50_000) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) await walk(full, recursive, out, depth + 1);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const close = glob.indexOf('}', i);
      if (close > i) {
        re += `(?:${glob.slice(i + 1, close).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close;
      } else re += '\\{';
    } else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
