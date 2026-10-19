/**
 * Turns an engine error into something a person can act on: which component failed, the likely cause and how
 * to recover. The original code and message are always kept alongside; an explanation never hides a failure.
 */

export interface Explanation {
  title: string;
  /** The failed component, in words ("Step “Answer from your documents” (RAG)"). */
  component: string;
  cause: string;
  steps: string[];
  actions: { label: string; href: string }[];
  /** True when the user can usually fix it in configuration; false for transient or unknown failures. */
  fixable: boolean;
  code: string;
  message: string;
}

export interface ExplainContext {
  nodeId?: string | undefined;
  nodeName?: string | undefined;
  nodeType?: string | undefined;
  nodeLabel?: string | undefined;
  flowId?: string | undefined;
}

const MODEL_NODES = /LLMNode|InstructorLLMNode|agentClassifierNode|agentNode|RAGNode|mcpNode|ImageGenNode|memoryNode/;

export function explainError(error: { code?: unknown; message?: unknown; nodeId?: unknown } | null | undefined, ctx: ExplainContext = {}): Explanation {
  const code = typeof error?.code === 'string' ? error.code : 'ERROR';
  const message = typeof error?.message === 'string' ? error.message : 'The run failed without a message.';
  const nodeId = ctx.nodeId ?? (typeof error?.nodeId === 'string' ? error.nodeId : undefined);
  const component = nodeId
    ? `Step “${ctx.nodeName ?? nodeId}”${ctx.nodeLabel && ctx.nodeLabel !== ctx.nodeName ? ` (${ctx.nodeLabel})` : ''}`
    : 'The workflow';
  const flowLink = ctx.flowId ? `/flows/${encodeURIComponent(ctx.flowId)}` : undefined;
  const modelStep = !!ctx.nodeType && MODEL_NODES.test(ctx.nodeType);
  const make = (title: string, cause: string, steps: string[], actions: Explanation['actions'] = [], fixable = true): Explanation => ({ title, component, cause, steps, actions, fixable, code, message });
  const url = /\b(https?:\/\/[^\s;,)]+)/.exec(message)?.[1];

  if (code === 'NETWORK' && /ollama|model server/i.test(message)) {
    return make('Jasmine couldn’t reach your model server', `The runtime tried ${url ?? 'the model server'} and nothing answered. The server is stopped, the address is wrong, or the runtime cannot reach that machine.`,
      ['Start the model server (Ollama: open the app or run “ollama serve”; LM Studio: Developer → Start Server).', 'Run the connection diagnosis to see exactly what the runtime sees.', 'If Jasmine is hosted, remember that localhost means the runtime server, not your computer.'],
      [{ label: 'Diagnose the connection', href: `/models?diagnose=${encodeURIComponent(url ?? 'default')}` }]);
  }
  if (code === 'NETWORK') {
    return make('A network request failed', `${url ? `The runtime could not reach ${url}.` : 'The runtime could not reach the service this step calls.'} It may be offline, blocked by a firewall, or the address may be mistyped.`,
      ['Check the URL on this step.', 'Confirm the runtime’s machine has network access to that service.', 'Add a retry on the Retry & timeout tab if the service is sometimes unavailable.'], flowLink ? [{ label: 'Open the step', href: `${flowLink}?node=${encodeURIComponent(nodeId ?? '')}` }] : []);
  }
  if (code === 'TIMEOUT') {
    return make('The step took too long', modelStep ? 'The model did not finish in time. Large models on modest hardware, long prompts and long answers all take longer.' : 'The service this step waits on did not answer in time.',
      modelStep ? ['Try a smaller or faster model.', 'Lower the maximum output tokens in the step’s advanced settings.', 'Raise the step timeout on the Retry & timeout tab.'] : ['Raise the step timeout on the Retry & timeout tab.', 'Check that the service is responsive.'], []);
  }
  if (code === 'DEADLINE_EXCEEDED') {
    return make('The run reached its time budget', 'The whole run took longer than its budget (2 minutes for realtime requests by default).',
      ['Call long workflows with "mode": "async" and poll for the result.', 'Shorten slow steps or use a faster model.', 'Reasoning models (Qwen3, DeepSeek-R1, gpt-oss…) think before answering; set Thinking to Off in a model step’s advanced settings.', 'Operators can raise JASMINE_REALTIME_TIMEOUT_MS on the runtime.']);
  }
  if (code === 'CANCELLED') return make('The run was cancelled', 'Someone stopped the run, a client disconnected, or another step failed first and the rest were stopped.', ['Run it again when ready. If another step failed, fix that step first.'], [], false);
  if (code === 'INTERRUPTED') return make('Jasmine restarted during this run', 'The runtime stopped while the run was in progress, so it could not finish.', ['Retry the run; completed steps are reused when possible.'], [], false);
  if (code === 'OVERLOADED') return make('Too many runs at once', 'The runtime is already running and queueing as many workflows as it is configured to.', ['Retry in a moment.', 'Operators can raise JASMINE_MAX_CONCURRENT_RUNS if the hardware allows.'], [], false);
  if (code === 'RATE_LIMITED') return make('The service is rate limiting requests', 'The model server or external service asked Jasmine to slow down.', ['Wait and retry.', 'Add a retry with exponential backoff on the Retry & timeout tab.'], [], false);

  if (code === 'PROVIDER' || code === 'UPSTREAM_HTTP') {
    if (/only provides embeddings/i.test(message)) return make('This step needs a chat model', 'The step is set to the built-in embedding connection, which cannot write text.', ['Choose a chat-capable connection for the step, or set a default chat connection under Models.'], [{ label: 'Open Models', href: '/models' }]);
    if (/cannot create embeddings/i.test(message)) return make('This connection cannot create embeddings', 'Document search needs an embedding model, and the chosen connection does not provide one.', ['Pull an embedding model (Ollama: “ollama pull nomic-embed-text”) or choose built-in keyword embeddings for the collection.'], [{ label: 'Open Models', href: '/models' }]);
    if (/no (?:local )?chat model|no embedding model|run `ollama pull|load (?:a|one)/i.test(message)) return make('No suitable model is installed', message.replace(/`/g, '“'), ['Install the model named in the message, then test the connection under Models.'], [{ label: 'Open Models', href: '/models' }]);
    if (/HTTP 401|HTTP 403/.test(message)) return make('The server refused the request', 'The API key is missing, wrong or lacks permission.', ['Update the key on the connection or credential, then test it.'], [{ label: modelStep ? 'Open Models' : 'Open Integrations', href: modelStep ? '/models' : '/integrations' }]);
    if (/HTTP 404/.test(message) && (modelStep || /ollama|model server/i.test(message))) return make('The model was not found', `The server answered, but not for the requested model or path. ${/not found|pull/i.test(message) ? 'The model is probably not installed.' : ''}`.trim(), ['Pick an installed model on the step (or the connection’s default).', 'Ollama: “ollama pull <model>”; LM Studio: load the model first.'], [{ label: 'Open Models', href: '/models' }]);
    if (/returned only its thinking/i.test(message)) return make('The model thought but wrote no answer', 'This is a reasoning model: it finished thinking and stopped without writing an answer, so Jasmine did not pass a blank reply on.',
      ['Open the step’s advanced settings and set Thinking to Off (fastest) or Low.', 'Run it again, or add a retry on the Retry & timeout tab; the model may answer the next time.', 'Or choose a model without thinking for this step.']);
    if (/whole token limit thinking/i.test(message)) return make('The model ran out of room while thinking', 'This is a reasoning model: it thinks before it answers, and its thinking used the step’s whole output budget, so no answer was written.',
      ['Open the step’s advanced settings and set Thinking to Off (fastest) or Low.', 'Or raise the step’s max output tokens; thinking also makes each run slower.', 'Or choose a model without thinking for this step.']);
    if (/token limit/i.test(message)) return make('The answer was cut off', 'The model reached its maximum output length before finishing.', ['Raise the maximum output tokens in the step’s advanced settings.', 'Ask for a shorter answer in the instructions.']);
    if (/ended the streamed reply before it finished|reported an error mid-reply/i.test(message)) return make('Your model server stopped mid-reply', `${message}. The answer was incomplete, so Jasmine did not use it.`,
      ['Check the model server’s log: running out of memory, a crash, or switching models during a request are common causes.', 'llama-cpp-python’s server cancels a reply whenever another request arrives (including Jasmine’s status checks); start it with --interrupt_requests False.', 'Retry the run; add a retry on the Retry & timeout tab if it happens occasionally.', 'Run the connection diagnosis to confirm the server is healthy.'], [{ label: 'Diagnose the connection', href: '/models?diagnose=default' }]);
    if (/HTTP 5\d\d/.test(message) && (modelStep || /ollama|model server/i.test(message))) return make('Your model server reported an error', `${message}. The server received the request but failed while handling it.`,
      ['Check the model server’s own log for the error it recorded.', 'Some models and servers do not support tools or structured JSON output; try another model on this step.', 'Run the connection diagnosis, then retry.'], [{ label: 'Diagnose the connection', href: '/models?diagnose=default' }]);
    if (/HTTP 5\d\d/.test(message)) return make('The service reported an internal error', message, ['Check the service’s own logs, then retry.', 'Add a retry on the Retry & timeout tab for transient errors.'], [], false);
    if (code === 'UPSTREAM_HTTP') return make('The external service returned an error', message, ['Check the URL, method and headers on this step.', 'Confirm any credentials it uses are valid.']);
    return make('The model server returned something unexpected', message, ['Test the connection under Models.', 'Try another model; some models do not support tools or structured JSON.'], [{ label: 'Open Models', href: '/models' }]);
  }

  if (code === 'OUTPUT_SCHEMA' || /does not match the schema|not valid JSON|no JSON object/i.test(message)) {
    return make('The model’s answer didn’t fit the required format', 'This step asks for JSON that matches a schema, and the reply did not match.', ['Use a more capable model, or simplify the schema (fewer, clearer fields).', 'Describe each field in the instructions.', 'Demo responses fill schemas with placeholder values; a real model is needed for real extraction.']);
  }
  if (/did not choose one of/i.test(message)) {
    return make('The model didn’t pick a category', 'The classifier’s reply did not name one of its categories.', ['Add a short description to each category.', 'Keep an “Other” category for anything that does not fit.', 'Try a more capable model.']);
  }

  if (code === 'NOT_FOUND') {
    const collection = /Vector database "([^"]+)"|Collection ([\w.:-]+) does not exist/.exec(message);
    if (collection) {
      const name = collection[1] ?? collection[2]!;
      return make(`The “${name}” collection doesn’t exist`, 'This step searches a knowledge collection that has not been created yet.', ['Create the collection, choose its embedding model, and upload documents.', 'Or select an existing collection on the step.'], [{ label: 'Create collection', href: `/context?tab=knowledge&create=${encodeURIComponent(name)}` }]);
    }
    if (/not deployed|Workflow .* not found/i.test(message)) return make('The workflow this step calls is not deployed', message, ['Deploy the called workflow, or choose another one on the step.'], [{ label: 'Open Deployments', href: '/deployments' }]);
    return make('Something this step needs was not found', message, ['Check names and IDs on the step.']);
  }

  if (code === 'BAD_PAYLOAD') {
    if (/Invalid trigger payload/i.test(message)) return make('The input doesn’t match what the workflow expects', message.replace(/^Invalid trigger payload: /, 'The request is missing or mistyping fields: '), ['Send the fields listed in the trigger’s input schema.', 'Or edit the input schema on the first step.']);
    if (/required/i.test(message)) return make('A required setting is empty', message, ['Open the step and fill in the highlighted field.'], flowLink && nodeId ? [{ label: 'Open the step', href: `${flowLink}?node=${encodeURIComponent(nodeId)}` }] : []);
    if (/credential/i.test(message)) return make('Missing account credentials', message, ['Add the credential this integration needs, then select it on the step.'], [{ label: 'Open Integrations', href: '/integrations' }]);
    return make('A setting or input was invalid', message, ['Review this step’s settings and the input you sent.']);
  }
  if (code === 'FORBIDDEN' && /credential|token|oauth/i.test(message)) return make('Account access was refused', message, ['Reconnect or update the credential under Integrations.'], [{ label: 'Open Integrations', href: '/integrations' }]);
  if (code === 'TEMPLATE_UNRESOLVED') return make('A reference points at a value that doesn’t exist', `${message} A {{…}} reference names a step output that was empty or misspelled.`, ['Use the reference picker ({ } button) to insert outputs from earlier steps.', 'Check that the referenced step ran before this one.']);
  if (code === 'CODE_ERROR') return make('The code step threw an error', message, ['Fix the JavaScript on this step; the message shows the line that failed.', 'Use the Last run tab to inspect the values it received.']);
  if (code === 'NO_RESPONSE') return make('No response step ran', message, ['Make sure every branch ends in a response step, or add an Else branch.']);
  if (code === 'LOOP_LIMIT') return make('A loop or nesting limit was reached', message, ['Reduce the number of items, or the depth of workflows calling workflows.']);
  if (code === 'COMPILE') return make('The workflow has configuration errors', message, ['Open Validate in the builder and fix each listed issue.']);
  if (code === 'INTERNAL') return make('Something unexpected went wrong', message, ['Retry the run.', 'If it keeps failing, check the runtime logs and report the error with its request ID.'], [], false);
  return make('The step failed', message, ['Review the step’s settings and its Last run tab.'], [], false);
}
