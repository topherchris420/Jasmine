import { readFile } from 'node:fs/promises';
import { createApi } from '../src/api/graphql.ts';
import { LocalLLMProvider, StaticLLMRouter } from '../src/llm/providers.ts';
import { defaultRegistry } from '../src/nodes/builtin.ts';
import { DeploymentRegistry } from '../src/service/deployments.ts';
import { RunService } from '../src/service/runs.ts';

const local = new LocalLLMProvider({
  ...(process.env['LLM_BASE_URL'] ? { baseURL: process.env['LLM_BASE_URL'] } : {}),
  ...(process.env['LLM_MODEL'] ? { model: process.env['LLM_MODEL'] } : {}),
  ...(process.env['LLM_API_KEY'] ? { apiKey: process.env['LLM_API_KEY'] } : {}),
});
const deployments = new DeploymentRegistry(defaultRegistry());
const runs = new RunService(deployments, {
  services: { llm: new StaticLLMRouter({ local }, 'local', 'auto'), fetch, codeTimeoutMs: 1000 },
});
const api = createApi(deployments, runs);
const definition: unknown = JSON.parse(await readFile(new URL('../examples/local-chat.json', import.meta.url), 'utf8'));
const deployed = await api.execute('mutation($definition: JSON!) { deployFlow(workflowId: "local-chat", definition: $definition) { version } }', { definition });
if (deployed.errors) throw new Error(JSON.stringify(deployed.errors));
const response = await api.execute('mutation($payload: JSON) { executeWorkflow(workflowId: "local-chat", payload: $payload) { status result error { code message } } }', {
  payload: { message: 'Explain what multi-factor authentication is in two sentences.' },
});
const run = response.data?.['executeWorkflow'] as { status?: string; result?: unknown } | undefined;
console.log(JSON.stringify(response, null, 2));
if (response.errors || run?.status !== 'success') process.exitCode = 1;
