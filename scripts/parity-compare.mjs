import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const executeQuery =
  'query Run($workflowId:String!,$payload:JSON){executeWorkflow(workflowId:$workflowId,payload:$payload){status requestId result}}';
const statusQuery = 'query Status($requestId:String!){checkStatus(requestId:$requestId){status requestId result}}';
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
const at = (value, pointer) =>
  pointer
    ? pointer
        .split('/')
        .slice(1)
        .reduce((v, key) => v?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], value)
    : value;
const escape = (key) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** Exact structural comparison, with explicitly declared ignored JSON pointers and numeric tolerance. */
export function compareValues(reference, jasmine, { ignorePaths = [], numericTolerance = 0 } = {}) {
  const mismatches = [];
  const visit = (a, b, pointer) => {
    if (ignorePaths.includes(pointer)) return;
    if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= numericTolerance) return;
    if (Object.is(a, b)) return;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
      mismatches.push(pointer || '/');
      return;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const child = `${pointer}/${escape(key)}`;
      if (ignorePaths.includes(child)) continue;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) mismatches.push(child);
      else visit(a[key], b[key], child);
    }
    if (Array.isArray(a) && a.length !== b.length) mismatches.push(`${pointer}/length`);
  };
  visit(reference, jasmine, '');
  return { equal: mismatches.length === 0, mismatches: [...new Set(mismatches)].slice(0, 100) };
}

async function run(target, flowId, payload, signal, http) {
  const post = async (body) => {
    const response = await http(target.endpoint, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
        ...(target.projectId ? { 'x-project-id': target.projectId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Endpoint returned HTTP ${response.status}`);
    const data = await response.json();
    if (data.errors?.length) throw new Error('Endpoint returned GraphQL errors');
    return data;
  };
  let response = at(
    await post({ query: target.executeQuery ?? executeQuery, variables: { workflowId: flowId, payload } }),
    target.executeResultPath ?? '/data/executeWorkflow',
  );
  while (response?.status === 'in-progress') {
    await new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 250);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    response = at(
      await post({ query: target.statusQuery ?? statusQuery, variables: { requestId: response.requestId } }),
      target.statusResultPath ?? '/data/checkStatus',
    );
  }
  if (!response || typeof response.status !== 'string') throw new Error('Endpoint returned no execution status');
  return response;
}

/**
 * Accepts either a GraphQL URL or a server base URL. A Jasmine base URL such as http://127.0.0.1:8787 (the form the CLI's
 * JASMINE_ENDPOINT uses) gets /graphql appended. For another platform, whose GraphQL path may differ, only a bare origin is
 * completed; any other path is used as given.
 */
export function graphqlEndpoint(endpoint, { jasmine = true } = {}) {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, '');
  if (!jasmine && path !== '' && !/\/graphql$/i.test(path)) return url.href;
  url.pathname = /\/graphql$/i.test(path) ? path : `${path}/graphql`;
  return url.href;
}

/** Executes only the already deployed flows named in the manifest. Never imports or deploys a flow. */
export async function compareFlows(manifest, targets, http = globalThis.fetch) {
  if (!Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error('Provide at least one comparison case');
  for (const target of Object.values(targets)) {
    const url = new URL(target.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP(S) GraphQL endpoint without credentials in the URL');
  }
  const cases = [];
  for (const item of manifest.cases) {
    const started = Date.now();
    const report = { name: item.name, passed: false };
    try {
      if (!item.name || !item.referenceFlowId || !item.jasmineFlowId)
        throw new Error('Each case needs a name and both flow ids');
      const signal = AbortSignal.timeout(item.timeoutMs ?? 120000);
      // Sequential calls keep comparative resource usage stable.
      const reference = await run(targets.reference, item.referenceFlowId, item.payload ?? {}, signal, http);
      const jasmine = await run(targets.jasmine, item.jasmineFlowId, item.payload ?? {}, signal, http);
      const a = at(reference.result, item.referenceOutputPath ?? ''),
        b = at(jasmine.result, item.jasmineOutputPath ?? '');
      const comparison = compareValues(a, b, item);
      const expected =
        !Object.hasOwn(item, 'expected') ||
        (compareValues(item.expected, a, item).equal && compareValues(item.expected, b, item).equal);
      Object.assign(report, {
        passed:
          comparison.equal &&
          expected &&
          reference.status === (item.expectedStatus ?? 'success') &&
          jasmine.status === (item.expectedStatus ?? 'success'),
        referenceStatus: reference.status,
        jasmineStatus: jasmine.status,
        mismatches: comparison.mismatches,
        expectedPassed: expected,
        referenceDigest: digest(a),
        jasmineDigest: digest(b),
      });
    } catch (error) {
      report.error = error.message;
    }
    report.durationMs = Date.now() - started;
    cases.push(report);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    passed: cases.every((c) => c.passed),
    verifiedCases: cases.filter((c) => c.passed).length,
    totalCases: cases.length,
    cases,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [file, output = 'parity-report.json'] = process.argv.slice(2);
    if (!file || !process.env.REFERENCE_ENDPOINT)
      throw new Error('Usage: REFERENCE_ENDPOINT=<GraphQL URL> [JASMINE_ENDPOINT=<Jasmine URL>] npm run parity:compare -- manifest.json [report.json]');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    const targets = {
      reference: {
        ...manifest.reference,
        endpoint: graphqlEndpoint(process.env.REFERENCE_ENDPOINT, { jasmine: false }),
        apiKey: process.env.REFERENCE_API_KEY,
        projectId: process.env.REFERENCE_PROJECT_ID,
      },
      jasmine: {
        ...manifest.jasmine,
        endpoint: graphqlEndpoint(process.env.JASMINE_ENDPOINT || 'http://127.0.0.1:8787'),
        apiKey: process.env.JASMINE_API_KEY,
        projectId: process.env.JASMINE_PROJECT_ID,
      },
    };
    const report = await compareFlows(manifest, targets);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`${report.verifiedCases}/${report.totalCases} cases matched. Report: ${output}`);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
