import { OAuthConnect } from './service/oauth-connect.ts';
import { BackupService } from './service/backup.ts';
import { EditorAssistant } from './service/assistant.ts';
import { WorkflowPlanner } from './service/planner.ts';
import { ModelDiagnostics } from './service/model-diagnostics.ts';
import { MailhookService } from './service/mailhook.ts';
import { ExecutionStateStore } from './service/execution-state.ts';
import { ResponseCache } from './service/cache.ts';
import { FeedbackStore } from './service/feedback.ts';
import { AlertStore } from './service/alerts.ts';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { JasmineDb } from './db/database.ts';
import { SecretBox } from './db/secrets.ts';
import { EngineError } from './errors.ts';
import { describeEgressPolicy, egressPolicyFromEnv, guardedFetch, type EgressPolicy } from './integrations/egress.ts';
import { TablesStore } from './integrations/tables.ts';
import { ModelRouter } from './llm/router.ts';
import { defaultRegistry } from './nodes/builtin.ts';
import type { NodeRegistry, Services } from './nodes/types.ts';
import { ApiKeyStore } from './service/apikeys.ts';
import { ChatStore } from './service/chat.ts';
import { ConnectionService } from './service/connections.ts';
import { CredentialStore } from './service/credentials.ts';
import { DeploymentRegistry, SqliteDeploymentStore } from './service/deployments.ts';
import { FileStore } from './service/files.ts';
import { KnowledgeService } from './service/knowledge.ts';
import { ProjectStore } from './service/project.ts';
import { PromptStore } from './service/prompts.ts';
import { RunStore } from './service/runlog.ts';
import { RunService } from './service/runs.ts';
import { Scheduler } from './service/scheduler.ts';
import { SettingsStore } from './service/settings.ts';
import { SessionStore } from './service/sessions.ts';
import { WorkspaceStore, type WorkspaceFlow } from './service/workspace.ts';
import { VectorStore } from './vector/store.ts';

export interface JasmineConfig {
  /** Where drafts, the database, uploads and keys live. */
  dataDir: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Keep the operational database in memory (tests). */
  inMemory?: boolean;
  /** Look for Ollama / LM Studio on first boot (default true). */
  probeModels?: boolean;
  /** Run cron and folder triggers (default true). */
  scheduler?: boolean;
  codeTimeoutMs?: number;
  /** Seed starter flows into an empty workspace (default true). */
  seed?: boolean;
  log?: (message: string) => void;
}

export const TEMPLATES_DIR = new URL('../examples/templates/', import.meta.url);

/** The whole local platform: storage, models, runtime, deployments, triggers and monitoring. */
export class Jasmine {
  readonly config: JasmineConfig;
  readonly db: JasmineDb;
  readonly box: SecretBox;
  readonly settings: SettingsStore;
  readonly project: ProjectStore;
  readonly llm: ModelRouter;
  readonly connections: ConnectionService;
  readonly credentials: CredentialStore;
  readonly vectors: VectorStore;
  readonly tables: TablesStore;
  readonly files: FileStore;
  readonly apiKeys: ApiKeyStore;
  readonly sessions: SessionStore;
  readonly workspace: WorkspaceStore;
  readonly registry: NodeRegistry;
  readonly deployments: DeploymentRegistry;
  readonly runStore: RunStore;
  readonly alerts: AlertStore;
  readonly runs: RunService;
  readonly executionState: ExecutionStateStore;
  readonly cache: ResponseCache;
  readonly feedback: FeedbackStore;
  readonly assistant: EditorAssistant;
  readonly planner: WorkflowPlanner;
  readonly modelDiagnostics: ModelDiagnostics;
  readonly backups: BackupService;
  readonly oauth: OAuthConnect;
  readonly mailhook: MailhookService;
  readonly knowledge: KnowledgeService;
  readonly chat: ChatStore;
  readonly prompts: PromptStore;
  readonly scheduler: Scheduler;
  readonly services: Services;
  readonly egress: EgressPolicy;
  private retention: NodeJS.Timeout | undefined;

  private constructor(config: JasmineConfig) {
    this.config = config;
    const env = config.env ?? {};
    const dataDir = path.resolve(config.dataDir);
    this.db = config.inMemory ? JasmineDb.memory() : new JasmineDb(path.join(dataDir, 'jasmine.db'));
    this.box = config.inMemory && !env['JASMINE_SECRET_KEY'] ? SecretBox.ephemeral() : SecretBox.fromEnvOrFile(dataDir, env['JASMINE_SECRET_KEY']);
    this.settings = new SettingsStore(this.db);
    this.project = new ProjectStore(this.settings, this.box);
    this.llm = new ModelRouter();
    const structured = env['LLM_JSON_MODE'] === 'json_object' ? 'json_object' as const : undefined;
    this.connections = new ConnectionService(this.db, this.box, this.settings, this.llm, {
      ...(config.fetch ? { fetch: config.fetch } : {}), ...(structured ? { structuredOutput: structured } : {}), mockLatencyMs: Number(env['MOCK_LATENCY_MS'] ?? 0) || 0,
    });
    this.credentials = new CredentialStore(this.db, this.box);
    this.vectors = new VectorStore(this.db);
    this.tables = new TablesStore(config.inMemory ? ':memory:' : path.join(dataDir, 'tables.db'));
    this.files = new FileStore(path.join(dataDir, 'files'));
    this.apiKeys = new ApiKeyStore(this.db, env['JASMINE_API_KEY']);
    this.sessions = new SessionStore(this.db, this.apiKeys, env['JASMINE_API_KEY']);
    this.workspace = new WorkspaceStore(dataDir);
    this.registry = defaultRegistry();
    this.deployments = new DeploymentRegistry(this.registry, async () => {}, new SqliteDeploymentStore(this.db));
    // Whatever makes a version live, or confirms the live one (Studio, REST, GraphQL, MCP, boot redeploys, FLOWS_DIR), supersedes an earlier failed deploy.
    this.deployments.onChange((e) => { if (e.version !== null) this.settings.set(`deploy.failure.${e.flowId}`, null); });
    this.runStore = new RunStore(this.db);
    this.alerts = new AlertStore(this.db);
    this.runStore.onFinished = (result, status) => this.alerts.evaluate(result, status);
    this.runStore.secrets = () => Object.values(this.project.secrets());
    this.egress = egressPolicyFromEnv(env);
    config.log?.(`egress: ${describeEgressPolicy(this.egress)}`);
    this.services = {
      llm: this.llm,
      // URLs that flow data can supply go through the egress guard; endpoints set in credentials do not.
      fetch: config.fetch ?? guardedFetch({ policy: this.egress }),
      configuredFetch: config.fetch ?? globalThis.fetch,
      codeTimeoutMs: config.codeTimeoutMs ?? 10_000,
      vectors: this.vectors,
      credentials: this.credentials,
      secrets: () => this.project.secrets(),
      env: () => this.project.env(),
      runSource:async(type,values,ctx)=>{const handler=this.registry.get(type);if(!handler||handler.kind!=='action'||handler.spec?.category!=='app')throw new EngineError('BAD_PAYLOAD','Select an app or database action');const node={...ctx.node,type,values};if(handler.sideEffect?.(node))throw new EngineError('BAD_PAYLOAD','Scheduled source configuration must use a read action');return handler.run({...ctx,node,values});},
      filesDir: this.files.dir,
      saveFile:(bytes,name,mime)=>{const saved=this.files.save(bytes,name,mime);return {key:saved.id,url:this.fileUrl(saved.id)};},
      tables: this.tables,
    };
    this.executionState = new ExecutionStateStore(this.db,this.box);
    this.cache = new ResponseCache(this.db,this.box,this.settings,()=>({ models:this.connections.list(),knowledge:this.vectors.listCollections(),env:this.project.env(),secrets:this.project.secrets(),credentials:this.credentials.list() }));
    this.feedback = new FeedbackStore(this.db);
    const limit=(name:string,fallback:number,max:number)=>{const n=env[name]===undefined?fallback:Number(env[name]);if(!Number.isInteger(n)||n<1||n>max)throw new EngineError('BAD_PAYLOAD',`${name} must be 1–${max}`);return n;};
    this.runs = new RunService(this.deployments, {
      maxConcurrentRuns:limit('JASMINE_MAX_CONCURRENT_RUNS',4,256),
      maxQueuedRuns:limit('JASMINE_MAX_QUEUED_RUNS',128,10000),
      nodeConcurrency:limit('JASMINE_NODE_CONCURRENCY',2,64),
      services: this.services, store: this.runStore, state:this.executionState, cache:this.cache,
      ...(env['JASMINE_REALTIME_TIMEOUT_MS'] ? { realtimeDeadlineMs: Number(env['JASMINE_REALTIME_TIMEOUT_MS']) } : {}),
      ...(env['JASMINE_ASYNC_TIMEOUT_MS'] ? { asyncDeadlineMs: Number(env['JASMINE_ASYNC_TIMEOUT_MS']) } : {}),
    });
    this.knowledge = new KnowledgeService(this.db, this.vectors, this.llm, this.files, this.services.fetch);
    this.chat = new ChatStore(this.db);
    this.prompts = new PromptStore(this.db);
    this.assistant = new EditorAssistant(this);
    this.planner = new WorkflowPlanner(this);
    this.modelDiagnostics = new ModelDiagnostics(this);
    this.backups = new BackupService(this);
    this.oauth = new OAuthConnect(this);
    this.mailhook = new MailhookService(this);
    this.scheduler = new Scheduler(this.deployments, this.runs, this.db, this.settings);
    this.scheduler.log = config.log ?? (() => {});
  }

  static async create(config: JasmineConfig): Promise<Jasmine> {
    const app = new Jasmine(config);
    await app.boot();
    return app;
  }

  private async boot(): Promise<void> {
    const log = this.config.log ?? (() => {});
    await this.connections.bootstrap(this.config.env ?? {}, this.config.probeModels ?? true);
    await this.workspace.load();
    const interrupted = this.runStore.markInterrupted();
    for(const result of this.executionState.recoverInterrupted())this.runStore.finish(result,'failed');
    if (interrupted) log(`marked ${interrupted} interrupted run(s) as failed`);
    const restored = this.deployments.restore();
    for (const f of restored.failed) log(`could not restore ${f.flowId}@${f.version}: ${f.error}`);
    // Failures recorded by earlier releases were not cleared by every deploy path; one older than the live version is stale.
    for (const flow of this.workspace.list()) {
      const failure = this.settings.get<{ at: string } | null>(`deploy.failure.${flow.id}`, null);
      const active = this.deployments.getActive(flow.id);
      if (failure && active && failure.at <= active.deployedAt) this.settings.set(`deploy.failure.${flow.id}`, null);
    }
    // Data directories from before the deployment store existed: redeploy the recorded definition.
    for (const flow of this.workspace.list()) {
      if (flow.deployedDefinition !== undefined && !this.deployments.getActive(flow.id)) {
        await this.deployments.deploy(flow.id, flow.deployedDefinition).catch((e: Error) => log(`could not redeploy ${flow.id}: ${e.message}`));
      }
    }
    if ((this.config.seed ?? true) && this.workspace.list().length === 0) await this.seed();
    const flowsDir = this.config.env?.['FLOWS_DIR'];
    if (flowsDir) {
      for (const file of (await readdir(flowsDir)).filter((f) => f.endsWith('.json'))) {
        const id = path.basename(file, '.json');
        const definition: unknown = JSON.parse(await readFile(path.join(flowsDir, file), 'utf8'));
        const r = await this.deployments.deploy(id, definition);
        log(`deployed ${id} ${r.version} from FLOWS_DIR`);
      }
    }
    if (this.config.scheduler ?? true) this.scheduler.start();
    this.retention = setInterval(() => this.pruneRuns(), 3600_000);
    this.retention.unref();
    this.pruneRuns();
  }

  pruneRuns(): number {
    const policy = this.settings.get('runs.retention', { maxRuns: 20_000, maxAgeDays: 30 });
    const removed=this.runStore.prune(policy.maxRuns, policy.maxAgeDays);
    this.executionState.prune(); this.cache.prune(); this.chat.prune(policy.maxAgeDays);
    return removed;
  }

  /** Starter flows for a new workspace. */
  async seed(): Promise<void> {
    const first = await this.templates().then((list) => list.find((t) => t.id === 'getting-started'));
    if (first) await this.workspace.save('getting-started', first.name, first.definition);
  }

  async templates(): Promise<{ id: string; name: string; description: string; category: string; useCase: string; input: string; output: string; definition: unknown }[]> {
    let files: string[];
    try {
      files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out = [];
    for (const file of files) {
      const definition = JSON.parse(await readFile(new URL(file, TEMPLATES_DIR), 'utf8')) as { meta?: { name?: string; description?: string; category?: string; useCase?: string; input?: string; output?: string } };
      const m = definition.meta ?? {};
      out.push({ id: path.basename(file, '.json').replace(/^\d+-/, ''), name: m.name ?? file, description: m.description ?? '', category: m.category ?? 'General', useCase: m.useCase ?? m.description ?? '', input: m.input ?? '', output: m.output ?? '', definition });
    }
    return out;
  }

  /** Deploys a saved draft and records it on the draft. */
  async deployFlow(id: string, opts: { expectedVersion?: string | null } = {}) {
    const draft = this.workspace.get(id);
    if (!draft) throw new EngineError('NOT_FOUND', 'Flow not found');
    let result;
    try {
      result = await this.deployments.deploy(id, draft.definition, opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {});
    } catch (error) {
      // Remembered so Studio can show the flow as Failed rather than silently keeping an older state.
      // A version conflict means someone else deployed first: the live version is newer, not broken.
      const e = error as EngineError;
      if (e.code !== 'CONFLICT') this.settings.set(`deploy.failure.${id}`, { at: new Date().toISOString(), code: e.code ?? 'DEPLOY_FAILED', message: e.message });
      throw error;
    }
    await this.workspace.markDeployed(id, draft.definition, result.version);
    return result;
  }

  /** Where a flow stands for the person who owns it: Draft, Validated, Deployed, Failed or Disabled. */
  lifecycle(flow: WorkspaceFlow, active = this.deployments.getActive(flow.id), draftChanged?: boolean): { state: 'draft' | 'validated' | 'deployed' | 'failed' | 'disabled'; label: string; detail: string; runId?: string } {
    // Activating any version clears the recorded failure, so one that is still recorded came after the live version.
    const failure = this.settings.get<{ at: string; message: string } | null>(`deploy.failure.${flow.id}`, null);
    if (active) {
      if (failure) return { state: 'failed', label: 'Failed', detail: `The last deploy failed (${failure.message}). The earlier version is still live.` };
      const last = this.runStore.list({ flowId: flow.id, limit: 10 }).runs.find((r) => r.source !== 'studio' && r.status !== 'in-progress');
      if (last && (last.status === 'failed' || last.status === 'error') && last.version === active.version) {
        return { state: 'failed', label: 'Failed', detail: `Live, but the latest run failed${last.errorMessage ? `: ${last.errorMessage}` : ''}.`, runId: last.id };
      }
      const changed = draftChanged ?? JSON.stringify(flow.deployedDefinition) !== JSON.stringify(flow.definition);
      return { state: 'deployed', label: 'Deployed', detail: changed ? 'Live. The draft has changes that are not deployed yet.' : 'Live and up to date.' };
    }
    if (this.deployments.listVersions(flow.id).length) return { state: 'disabled', label: 'Disabled', detail: 'Not serving requests. Deploy again or roll back to a version to re-enable it.' };
    if (failure) return { state: 'failed', label: 'Failed', detail: `Deploy failed: ${failure.message}` };
    const validation = this.deployments.validate(flow.id, flow.definition);
    const errors = validation.diagnostics.filter((d) => d.severity === 'error').length;
    return validation.ok
      ? { state: 'validated', label: 'Validated', detail: 'Passes validation and is ready to deploy.' }
      : { state: 'draft', label: 'Draft', detail: errors ? `${errors} issue${errors === 1 ? '' : 's'} to fix before deploying.` : 'Add a trigger to get started.' };
  }

  async deleteFlow(id: string): Promise<boolean> {
    const existed = await this.workspace.remove(id);
    this.deployments.remove(id);
    this.chat.clear(id);
    this.settings.set(`deploy.failure.${id}`, null);
    this.assistant.forget(id);
    return existed;
  }

  flowSummary(flow: WorkspaceFlow) {
    const active = this.deployments.getActive(flow.id);
    const trigger = active?.plan.nodes.get(active.plan.triggerId)?.node.type
      ?? ((flow.definition as { nodes?: { data?: { nodeId?: string; trigger?: boolean }; type?: string }[] })?.nodes ?? []).find((n) => n.type === 'triggerNode' || n.data?.trigger)?.data?.nodeId;
    const draftChanged = !!active && JSON.stringify(flow.deployedDefinition) !== JSON.stringify(flow.definition);
    return {
      tags:((flow.definition as {meta?:{tags?:unknown[]}})?.meta?.tags??[]).filter(t=>typeof t==='string'),
      id: flow.id, name: flow.name, revision: flow.revision, updatedAt: flow.updatedAt,
      deployedVersion: active?.version ?? null, deployedAt: active?.deployedAt ?? null, trigger: trigger ?? null,
      draftChanged,
      lifecycle: this.lifecycle(flow, active, draftChanged),
    };
  }

  fileUrl(id:string,ttlSeconds=3600):string{
    const token=Buffer.from(this.box.sealJson({id,expiresAt:Date.now()+Math.min(ttlSeconds,604800)*1000})).toString('base64url');
    const base=this.config.env?.['PUBLIC_URL']??`http://127.0.0.1:${this.config.env?.['PORT']??8787}`;
    return `${base.replace(/\/+$/,'')}/assets/${encodeURIComponent(id)}?token=${token}`;
  }
  verifyFileToken(id:string,token:string):boolean{try{const text=Buffer.from(token,'base64url').toString();if(!text.startsWith('enc:v1:'))return false;const value=this.box.openJson<{id:string;expiresAt:number}>(text);return value.id===id&&Number.isFinite(value.expiresAt)&&value.expiresAt>Date.now();}catch{return false;}}

  async close(): Promise<void> {
    this.scheduler.stop();
    clearInterval(this.retention);
    await this.mailhook.close();
    this.tables.close();
    this.db.close();
  }
}
