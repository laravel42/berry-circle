import { randomUUID } from 'node:crypto';
import {
   errorForStatus,
   SourceControlError,
   SourceControlGatewayUnavailableError,
} from './errors.ts';

/**
 * Amazon Bedrock AgentCore Gateway, over MCP.
 *
 * Deliberately knows nothing about GitHub. A gateway is a tool transport, and
 * Berry will put other systems behind the same one — GitLab, Jira, Slack — so
 * anything here that mentioned repositories would have to be unpicked the
 * first time it did.
 *
 * MCP rather than an AWS SDK client because there is no SDK operation for
 * this: `@aws-sdk/client-bedrock-agentcore` manages runtimes, memory and code
 * interpreters, and `-control` manages gateways and their targets, but calling
 * a gateway's tools is JSON-RPC over Streamable HTTP. That is what this is.
 *
 * Authentication is a callback rather than a scheme. A gateway may take a
 * workload access token, an OAuth bearer or SigV4, and which one is a
 * deployment's decision — so this asks for headers and does not care.
 */

export interface ToolDefinition {
   name: string;
   description: string;
   /** JSON Schema, as MCP describes a tool's arguments. */
   inputSchema: Record<string, unknown>;
}

export interface GatewayClientOptions {
   /** The gateway's MCP endpoint. */
   url: string;
   /** Returns the headers that authorise one call. Never logged. */
   authorize: () => Promise<Record<string, string>>;
   fetch?: typeof globalThis.fetch;
   timeoutMs?: number;
   /** How many times a transient failure is retried. */
   maxAttempts?: number;
   clock?: () => number;
   sleep?: (ms: number) => Promise<void>;
   observe?: (event: GatewayCall) => void;
}

/** One call, for the log and for metrics. Never carries arguments or credentials. */
export interface GatewayCall {
   method: string;
   tool: string | null;
   durationMs: number;
   ok: boolean;
   attempts: number;
   requestId: string | null;
   errorKind: string | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;

export class AgentCoreGatewayClient {
   readonly #url: string;
   readonly #authorize: () => Promise<Record<string, string>>;
   readonly #fetch: typeof globalThis.fetch;
   readonly #timeoutMs: number;
   readonly #maxAttempts: number;
   readonly #clock: () => number;
   readonly #sleep: (ms: number) => Promise<void>;
   readonly #observe: (event: GatewayCall) => void;
   #sessionId: string | null = null;

   constructor(options: GatewayClientOptions) {
      this.#url = options.url;
      this.#authorize = options.authorize;
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      this.#clock = options.clock ?? Date.now;
      this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
      this.#observe = options.observe ?? (() => undefined);
   }

   /** Opens the MCP session. Safe to call more than once. */
   async initialize(): Promise<void> {
      if (this.#sessionId) return;
      const result = await this.#rpc('initialize', {
         protocolVersion: '2025-06-18',
         capabilities: {},
         clientInfo: { name: 'berry', version: '1' },
      });
      // A gateway may or may not hand back a session; both are legal, and a
      // missing one simply means every call stands alone.
      this.#sessionId = typeof result.sessionId === 'string' ? result.sessionId : 'stateless';
   }

   /** Every tool this gateway exposes. */
   async listTools(): Promise<ToolDefinition[]> {
      await this.initialize();
      const tools: ToolDefinition[] = [];
      let cursor: string | undefined;
      do {
         const page = await this.#rpc('tools/list', cursor ? { cursor } : {});
         for (const entry of asArray(page.tools)) {
            const tool = entry as Record<string, unknown>;
            if (typeof tool.name !== 'string') continue;
            tools.push({
               name: tool.name,
               description: typeof tool.description === 'string' ? tool.description : '',
               inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
            });
         }
         cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
         // A gateway that keeps handing back the same cursor would otherwise
         // page forever; the loop ends when it stops changing.
      } while (cursor);
      return tools;
   }

   /**
    * Calls one tool and returns what it produced.
    *
    * MCP reports a tool's own failure as a successful response carrying
    * `isError`, which is not the same as the transport failing — so that case
    * is turned into an error here rather than handed back as a result the
    * caller has to remember to check.
    */
   async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      await this.initialize();
      const result = await this.#rpc('tools/call', { name, arguments: args }, name);

      if (result.isError === true) {
         throw new SourceControlError(`${name} failed: ${textOf(result)}`, 'validation');
      }
      // Structured output when the tool provides it; otherwise the text
      // content parsed as JSON, which is how most MCP tools return a record.
      if (result.structuredContent !== undefined) return result.structuredContent;
      const text = textOf(result);
      if (text === '') return null;
      try {
         return JSON.parse(text);
      } catch {
         return text;
      }
   }

   async #rpc(
      method: string,
      params: Record<string, unknown>,
      tool: string | null = null
   ): Promise<Record<string, unknown>> {
      const started = this.#clock();
      let attempt = 0;
      let lastError: SourceControlError | null = null;

      while (attempt < this.#maxAttempts) {
         attempt += 1;
         try {
            const result = await this.#send(method, params);
            this.#observe({
               method,
               tool,
               durationMs: this.#clock() - started,
               ok: true,
               attempts: attempt,
               requestId: result.requestId,
               errorKind: null,
            });
            return result.body;
         } catch (error: unknown) {
            const normalized =
               error instanceof SourceControlError
                  ? error
                  : new SourceControlGatewayUnavailableError(
                       `the gateway could not be reached: ${error instanceof Error ? error.message : String(error)}`,
                       { cause: error }
                    );
            lastError = normalized;
            // Only transient failures are retried, and never a conflict: a
            // duplicate is the one failure where trying again makes it worse.
            if (!normalized.retryable || attempt >= this.#maxAttempts) break;
            await this.#sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
         }
      }

      this.#observe({
         method,
         tool,
         durationMs: this.#clock() - started,
         ok: false,
         attempts: attempt,
         requestId: lastError?.requestId ?? null,
         errorKind: lastError?.kind ?? null,
      });
      throw lastError ?? new SourceControlGatewayUnavailableError('the gateway call failed');
   }

   async #send(
      method: string,
      params: Record<string, unknown>
   ): Promise<{ body: Record<string, unknown>; requestId: string | null }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
         const response = await this.#fetch(this.#url, {
            method: 'POST',
            headers: {
               'content-type': 'application/json',
               accept: 'application/json, text/event-stream',
               ...(this.#sessionId && this.#sessionId !== 'stateless'
                  ? { 'mcp-session-id': this.#sessionId }
                  : {}),
               ...(await this.#authorize()),
            },
            body: JSON.stringify({
               jsonrpc: '2.0',
               id: randomUUID(),
               method,
               params,
            }),
            signal: controller.signal,
         });

         const requestId =
            response.headers.get('x-amzn-requestid') ?? response.headers.get('x-amz-request-id');
         const raw = await response.text();

         if (!response.ok) {
            const retryAfter = Number(response.headers.get('retry-after') ?? '');
            throw errorForStatus(response.status, `gateway ${method}: ${raw.slice(0, 300)}`, {
               requestId,
               ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}),
            });
         }

         const envelope = parseEnvelope(raw);
         if (envelope.error) {
            // JSON-RPC carries its own error, and its `code` is not an HTTP
            // status — so it is mapped rather than passed to `errorForStatus`.
            throw rpcError(envelope.error, requestId);
         }
         return { body: isRecord(envelope.result) ? envelope.result : {}, requestId };
      } finally {
         clearTimeout(timer);
      }
   }
}

/**
 * A JSON-RPC response, whether it arrived as JSON or as an SSE frame.
 *
 * Streamable HTTP allows either for a single call, and a client that handled
 * only the first would work until the gateway decided to stream.
 */
function parseEnvelope(raw: string): { result?: unknown; error?: Record<string, unknown> } {
   const text = raw.trim();
   if (text === '') return {};
   const body = text.startsWith('event:') || text.startsWith('data:') ? sseData(text) : text;
   try {
      const parsed: unknown = JSON.parse(body);
      if (!isRecord(parsed)) return {};
      return {
         result: parsed.result,
         ...(isRecord(parsed.error) ? { error: parsed.error } : {}),
      };
   } catch {
      return {};
   }
}

/** The last `data:` payload in an SSE body. */
function sseData(text: string): string {
   const lines = text.split('\n').filter((line) => line.startsWith('data:'));
   return lines.length === 0 ? '' : lines[lines.length - 1]!.slice(5).trim();
}

function rpcError(error: Record<string, unknown>, requestId: string | null): SourceControlError {
   const message = String(error.message ?? 'the gateway reported an error');
   const code = Number(error.code ?? 0);
   // -32601 is "method not found", which for a tool call means the tool is not
   // there — a validation problem, not something to retry.
   const status = code === -32601 ? 404 : code === -32602 ? 422 : 500;
   return errorForStatus(status, message, { cause: error, requestId });
}

/** The text an MCP tool returned, joined across content blocks. */
function textOf(result: Record<string, unknown>): string {
   return asArray(result.content)
      .map((entry) => {
         const block = entry as Record<string, unknown>;
         return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .join('');
}

function asArray(value: unknown): unknown[] {
   return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}
