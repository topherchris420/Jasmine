import { EngineError } from '../errors.ts';
import { readLines } from '../llm/types.ts';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Model Context Protocol client over Streamable HTTP (JSON or SSE responses). */
export class McpClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | undefined;
  private nextId = 1;
  private initialized = false;

  constructor(url: string, opts: { headers?: Record<string, string>; fetch?: typeof fetch } = {}) {
    this.url = url;
    this.headers = opts.headers ?? {};
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async rpc(method: string, params: unknown, signal: AbortSignal, notification = false): Promise<unknown> {
    const id = notification ? undefined : this.nextId++;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST', signal,
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}), ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}), ...(id !== undefined ? { id } : {}) }),
      });
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      throw new EngineError('NETWORK', `MCP server ${new URL(this.url).host} unreachable: ${(e as Error).message}`, { retryable: true });
    }
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (!res.ok) {
      await res.body?.cancel();
      throw new EngineError(res.status === 401 || res.status === 403 ? 'FORBIDDEN' : 'UPSTREAM_HTTP', `MCP ${method} returned HTTP ${res.status}`, { retryable: res.status >= 500 });
    }
    if (notification) {
      await res.body?.cancel();
      return undefined;
    }
    const type = res.headers.get('content-type') ?? '';
    let message: { result?: unknown; error?: { message?: string; code?: number } } | undefined;
    if (type.includes('text/event-stream') && res.body) {
      for await (const line of readLines(res.body, signal)) {
        if (!line.startsWith('data:')) continue;
        try {
          const data = JSON.parse(line.slice(5).trim()) as { id?: unknown; result?: unknown; error?: { message?: string } };
          if (data.id === id) {
            message = data;
            break;
          }
        } catch {
          /* ignore keep-alives */
        }
      }
    } else {
      message = await res.json() as typeof message;
    }
    if (!message) throw new EngineError('UPSTREAM_HTTP', `MCP ${method} returned no response`);
    if (message.error) throw new EngineError('UPSTREAM_HTTP', `MCP ${method} failed: ${message.error.message ?? 'unknown error'}`);
    return message.result;
  }

  async initialize(signal: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jasmine', version: '1.0.0' } }, signal);
    await this.rpc('notifications/initialized', undefined, signal, true).catch(() => {});
    this.initialized = true;
  }

  async listTools(signal: AbortSignal): Promise<McpTool[]> {
    await this.initialize(signal);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {}, signal) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result?.tools ?? []));
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean; structured?: unknown }> {
    await this.initialize(signal);
    const result = await this.rpc('tools/call', { name, arguments: args }, signal) as { content?: { type?: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
    const text = (result?.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} content]`)).join('\n');
    return { text, isError: result?.isError === true, ...(result?.structuredContent !== undefined ? { structured: result.structuredContent } : {}) };
  }
}
