import { codeBlock, h, page } from '../ui.js';
import { origin } from '../shared.js';

const ERRORS = [
  ['BAD_PAYLOAD', 'The request or trigger payload is invalid.'],
  ['NOT_FOUND', 'Flow, run, version or resource does not exist (or the flow is not deployed).'],
  ['FORBIDDEN', 'Missing or invalid API key, webhook signature, or a disallowed origin. GraphQL answers "Access Denied".'],
  ['TIMEOUT', 'A node exceeded its timeout. Retryable.'],
  ['DEADLINE_EXCEEDED', 'The whole run exceeded its deadline.'],
  ['CANCELLED', 'The run was cancelled.'],
  ['PROVIDER', 'The local model server failed or is unreachable. Retryable.'],
  ['UPSTREAM_HTTP', 'An API/integration node got an error response. Retryable for 5xx and 429.'],
  ['NETWORK', 'A network request failed before a response. Retryable.'],
  ['RATE_LIMITED', 'Too many requests to a widget endpoint or upstream. Retryable.'],
  ['OVERLOADED', 'The server is at its run concurrency and queue limit. Retryable.'],
  ['CODE_ERROR', 'A Code node threw or timed out.'],
  ['OUTPUT_SCHEMA', 'A model did not return JSON matching the requested schema.'],
  ['TEMPLATE_UNRESOLVED', 'A {{reference}} pointed at a value that does not exist.'],
  ['LOOP_LIMIT', 'A loop or agent exceeded its iteration limit.'],
  ['COMPILE', 'The flow is invalid; diagnostics are in extensions.diagnostics.'],
  ['CONFLICT', 'A concurrent edit or deploy (expected revision/version mismatch).'],
  ['INTERNAL', 'Unexpected server error.'],
];

export async function render(container) {
  const base = origin();
  const sections = [];
  const section = (id, title, ...content) => { sections.push({ id, title }); return h('section', { id }, h('h2', {}, title), ...content); };
  const p = (...c) => h('p', {}, ...c);
  const c = (t) => h('code', {}, t);
  const tbl = (head, rows) => h('table', {}, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((x) => h('td', {}, typeof x === 'string' && /^[A-Z_]+$|^\/|^(GET|POST|PUT|DELETE) /.test(x) ? c(x) : x))))));

  const content = h('div', { class: 'docs stack' },
    section('overview', 'Overview',
      p('Jasmine runs AI workflows on local models. Build a flow in the Studio, deploy it, and call it over GraphQL, REST, a webhook, an embedded widget, or a schedule. Every run is logged with per-node inputs, outputs, timings and token usage.'),
      p('Call ', c('executeWorkflow(workflowId, payload)'), ' and read ', c('result'), ' for the flow output. Studio JSON and AgentKit-style flow files can be imported from the Flows page.')),
    section('auth', 'Authentication',
      p('Create keys under Settings → API keys. Send them as ', c('Authorization: Bearer <key>'), ' (or ', c('x-api-key'), '). Optional ', c('x-project-id'), ' must match the project ID when present.'),
      tbl(['Scope', 'Can'], [['execute', 'Run deployed flows, check status, stream events, inspect traces, cancel and retry runs.'], ['admin', 'Everything, including the Studio and the admin API under /api.']]),
      p('Until a key of a scope exists, that scope is open. The server warns at startup when it listens beyond localhost without an admin key.')),
    section('graphql', 'GraphQL: executeWorkflow',
      p('Endpoint: ', c(`POST ${base}/graphql`), '. Mutation and Query both expose executeWorkflow; prefer the mutation.'),
      codeBlock(`mutation Run($workflowId: String!, $payload: JSON) {
  executeWorkflow(workflowId: $workflowId, payload: $payload) {
    status        # success | failed | error | in-progress
    requestId
    result        # the flow's response (output of its response node)
    statusCode
    timeTakenInSeconds
    usage         # { llmCalls, inputTokens, outputTokens }
    error { code message nodeId }
  }
}`, 'GraphQL'),
      codeBlock(`curl -X POST ${base}/graphql \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $JASMINE_API_KEY" \\
  -d '{"query":"mutation($w:String!,$p:JSON){executeWorkflow(workflowId:$w,payload:$p){status requestId result}}","variables":{"w":"getting-started","p":{"chatMessage":"Hi"}}}'`, 'cURL'),
      p('Async runs: pass ', c('mode: async'), ' to get ', c('{ status: "in-progress", requestId }'), ' immediately, then poll ', c('checkStatus(requestId)'), '. Pass ', c('idempotencyKey'), ' to make retries of the same request return the original run.'),
      p('Other operations: ', c('checkStatus'), ', ', c('flowVersions'), ', ', c('runTrace'), ', ', c('runHistory'), ', ', c('retryWorkflow'), ', ', c('cancelWorkflow'), ', ', c('deployFlow'), ', ', c('rollbackFlow'), ' (admin).')),
    section('rest', 'REST execution API',
      tbl(['Method & path', 'Scope', 'Description'], [
        ['POST /api/v1/flows/{flowId}/execute', 'execute', 'Body { payload, mode?, idempotencyKey? }. Same response as executeWorkflow.'],
        ['GET /api/v1/runs/{requestId}', 'execute', 'Run status and result.'],
        ['POST /api/v1/runs/{requestId}/cancel', 'execute', 'Cancel a running request.'],
        ['GET /api/runs/{requestId}/events', 'execute', 'Server-sent events: trace, node.token, node.progress, done.'],
      ])),
    section('webhooks', 'Webhooks',
      p('Flows with a Webhook trigger accept ', c(`POST ${base}/webhooks/{flowId}`), ' with any JSON body; the body becomes the trigger output.'),
      p('If the trigger has a shared secret, send it as ', c('x-jasmine-signature: <secret>'), ', or sign the raw body: ', c('x-jasmine-signature: sha256=<hex HMAC-SHA256(secret, body)>'), '.'),
      codeBlock(`body='{"event":"ticket.created","id":42}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST ${base}/webhooks/my-flow -H "Content-Type: application/json" -H "x-jasmine-signature: sha256=$sig" -d "$body"`, 'Shell')),
    section('widgets', 'Chat, search and ask widgets',
      p('Deploy a flow with a Chat, Search or Ask trigger and embed it. Allowed origins are set on the trigger node (', c('domains'), ').'),
      codeBlock(`<!-- floating chat bubble -->
<script src="${base}/widget/chat.js" data-flow-id="support-bot" defer></script>

<!-- inline search box -->
<div id="jasmine-search"></div>
<script src="${base}/widget/search.js" data-flow-id="docs-search" data-target="#jasmine-search" defer></script>`, 'HTML'),
      tbl(['Method & path', 'Description'], [
        ['POST /api/chat/{flowId}', 'Body { chatMessage, sessionId?, userId?, stream? }. Returns { sessionId, output: { content, … } }. With stream: true, answers with SSE events session, token, progress, message.'],
        ['GET /api/chat/{flowId}/config', 'Widget appearance (bot name, greeting, suggestions, colors).'],
        ['GET /api/chat/{flowId}/history?sessionId=', 'Recent messages of a session.'],
        ['POST /api/ask/{flowId}', 'Like chat, for Ask triggers.'],
        ['POST /api/search/{flowId}', 'Body { searchQuery }. Returns { results: [...] }.'],
        ['GET /apps/chat/{flowId}, /apps/search/{flowId}', 'Hosted widget pages (iframe-able).'],
      ])),
    section('templates', 'References in node fields',
      p('Any text field can reference earlier data with ', c('{{ … }}'), '. Expressions are evaluated in a sandbox.'),
      tbl(['Reference', 'Value'], [
        ['{{triggerNode_1.output.chatMessage}}', 'A trigger payload field.'],
        ['{{LLMNode_1.output.generatedResponse}}', 'Another node\'s output.'],
        ['{{RAGNode_1.output.references[0]}}', 'Array indexing and slices ([0:3]).'],
        ['{{secrets.project.NAME}}', 'A project secret (Settings → Secrets).'],
        ['{{env.NAME}}', 'A project environment variable.'],
        ['{{codeNode_1.output.items.length > 0 ? "yes" : "no"}}', 'A JavaScript expression.'],
      ])),
    section('models', 'Local models',
      p('Connections under Models point at local inference servers: Ollama (native API) or any OpenAI-compatible server such as LM Studio, llama.cpp, vLLM or LocalAI. Nodes pick a connection and model; imported flows that name cloud models (gpt-4o, claude, gemini, …) run on your default local connection, or on an alias you define.'),
      p('Embeddings for vector databases come from an embedding model on a connection (for example ', c('nomic-embed-text'), ' in Ollama). Without one, Jasmine uses its built-in lexical embeddings so RAG still works offline.')),
    section('admin', 'Admin API',
      p('The Studio uses the admin API under ', c('/api'), ': flows (', c('/api/flows'), ', import, validate, test, deploy, versions, rollback), runs and reports, model connections, collections and documents, tables, files, prompts, credentials, settings and keys. All of it accepts an admin key, so you can script deployments:'),
      codeBlock(`# deploy the current draft of a flow
curl -X POST ${base}/api/flows/my-flow/deploy -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{}'

# ingest a web page into a vector database
curl -X POST ${base}/api/collections/handbook/documents -H "Authorization: Bearer $ADMIN_KEY" \\
  -H "Content-Type: application/json" -d '{"url":"https://example.com/handbook"}'`, 'cURL')),
    section('errors', 'Error codes',
      p('Errors carry a code in ', c('error.code'), ' (REST) or ', c('errors[].extensions.code'), ' (GraphQL), plus ', c('retryable'), ' and, for node failures, ', c('nodeId'), '.'),
      tbl(['Code', 'Meaning'], ERRORS)),
  );

  container.append(page('API docs', 'How to call Jasmine from your applications.', [],
    h('div', { class: 'docs-layout' },
      h('nav', { class: 'toc', 'aria-label': 'On this page' }, sections.map((s) => h('a', { href: `#${s.id}`, onClick: (e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }); } }, s.title))),
      content)));
}
