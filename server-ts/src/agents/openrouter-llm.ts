import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import type { Content, FunctionDeclaration, Part } from '@google/genai';

/**
 * An OpenRouter model for ADK, because the TypeScript SDK does not ship one.
 *
 * `@google/adk` v2 provides exactly two models — `ApigeeLlm` and `RoutedLlm` —
 * over an extensible `BaseLlm`. Berry runs entirely on OpenRouter, so this is
 * the seam that has to exist for ADK to be usable here at all. The Go SDK has
 * `model/openaimodel`; this is its counterpart, written rather than imported.
 *
 * The work is translation in both directions. ADK speaks Google GenAI types —
 * `Content` with `parts`, `functionCall`, `functionResponse` — and OpenRouter
 * speaks OpenAI chat completions. Neither is a superset of the other, and the
 * places they disagree are where agents break silently rather than loudly.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterOptions {
   model: string;
   apiKey: string;
   baseUrl?: string;
   /** OpenRouter attributes usage to these; both are optional. */
   referer?: string;
   title?: string;
   fetchImpl?: typeof fetch;
}

/** What a completion cost, for the run ledger. */
export interface Usage {
   promptTokens: number;
   completionTokens: number;
   totalTokens: number;
}

interface OpenAIToolCall {
   id: string;
   type: 'function';
   function: { name: string; arguments: string };
}

interface OpenAIMessage {
   role: 'system' | 'user' | 'assistant' | 'tool';
   content?: string | null;
   tool_calls?: OpenAIToolCall[];
   tool_call_id?: string;
   name?: string;
}

export class OpenRouterLlm extends BaseLlm {
   private readonly apiKey: string;
   private readonly baseUrl: string;
   private readonly headers: Record<string, string>;
   private readonly fetchImpl: typeof fetch;

   /**
    * Matches every OpenRouter model id, which are always `vendor/name`.
    *
    * Registered rather than matched by prefix so a bare `gemini-2.0-flash`
    * still reaches ADK's own registry if one is ever added.
    */
   static override readonly supportedModels: Array<string | RegExp> = [/^[a-z0-9-]+\/.+$/];

   constructor(options: OpenRouterOptions) {
      super({ model: options.model });
      this.apiKey = options.apiKey;
      this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
      this.fetchImpl = options.fetchImpl ?? fetch;
      this.headers = {
         'content-type': 'application/json',
         authorization: `Bearer ${this.apiKey}`,
         ...(options.referer ? { 'HTTP-Referer': options.referer } : {}),
         ...(options.title ? { 'X-Title': options.title } : {}),
      };
   }

   /**
    * One turn, streamed or not.
    *
    * Streaming yields partial responses as text arrives and one final response
    * carrying the complete content plus usage — which is the shape ADK's runner
    * expects, and the reason a caller can render tokens as they land while
    * still getting one authoritative result to record.
    */
   override async *generateContentAsync(
      llmRequest: LlmRequest,
      stream = false,
      abortSignal?: AbortSignal
   ): AsyncGenerator<LlmResponse, void> {
      const body = this.buildRequest(llmRequest, stream);
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
         method: 'POST',
         headers: this.headers,
         body: JSON.stringify(body),
         ...(abortSignal ? { signal: abortSignal } : {}),
      });

      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         throw new OpenRouterError(response.status, detail);
      }

      if (!stream) {
         yield parseCompletion(await response.json());
         return;
      }
      yield* this.readStream(response);
   }

   /**
    * Live bidirectional sessions are not available.
    *
    * ADK's `connect` is for models with a duplex socket. OpenRouter is a
    * request/response API, so this throws rather than returning something that
    * looks like a connection and then does nothing.
    */
   override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
      return Promise.reject(
         new Error('OpenRouter does not support live connections; use generateContentAsync')
      );
   }

   private buildRequest(llmRequest: LlmRequest, stream: boolean): Record<string, unknown> {
      const messages = toOpenAIMessages(llmRequest);
      const tools = toOpenAITools(llmRequest);
      const config = llmRequest.config ?? {};

      return {
         model: llmRequest.model ?? this.model,
         messages,
         ...(tools.length > 0 ? { tools } : {}),
         ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
         ...(config.topP !== undefined ? { top_p: config.topP } : {}),
         ...(config.maxOutputTokens !== undefined
            ? { max_tokens: config.maxOutputTokens }
            : {}),
         ...(config.stopSequences?.length ? { stop: config.stopSequences } : {}),
         ...(config.responseMimeType === 'application/json'
            ? { response_format: { type: 'json_object' } }
            : {}),
         ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      };
   }

   /**
    * Reassembles an SSE stream into partial responses and one final one.
    *
    * Tool call arguments arrive as fragments across deltas keyed by index, so
    * they are accumulated rather than emitted: half a JSON object is not a
    * tool call, and forwarding one would have the agent invoke a tool with
    * arguments that do not parse.
    */
   private async *readStream(response: Response): AsyncGenerator<LlmResponse, void> {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('OpenRouter returned no body to stream');

      const decoder = new TextDecoder();
      let buffered = '';
      let text = '';
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let usage: Usage | undefined;
      let finishReason: string | undefined;

      for (;;) {
         const { done, value } = await reader.read();
         if (done) break;
         buffered += decoder.decode(value, { stream: true });

         let boundary = buffered.indexOf('\n');
         for (; boundary !== -1; boundary = buffered.indexOf('\n')) {
            const line = buffered.slice(0, boundary).trim();
            buffered = buffered.slice(boundary + 1);
            if (!line.startsWith('data:')) continue;

            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;

            let chunk: StreamChunk;
            try {
               chunk = JSON.parse(payload) as StreamChunk;
            } catch {
               // OpenRouter interleaves comment lines to keep the connection
               // alive; anything unparseable is one of those.
               continue;
            }

            if (chunk.usage) usage = toUsage(chunk.usage);
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;

            const delta = choice.delta ?? {};
            if (typeof delta.content === 'string' && delta.content !== '') {
               text += delta.content;
               yield { content: { role: 'model', parts: [{ text: delta.content }] }, partial: true };
            }
            for (const call of delta.tool_calls ?? []) {
               const existing = calls.get(call.index) ?? { id: '', name: '', args: '' };
               calls.set(call.index, {
                  id: call.id ?? existing.id,
                  name: call.function?.name ?? existing.name,
                  args: existing.args + (call.function?.arguments ?? ''),
               });
            }
         }
      }

      yield finalResponse(text, [...calls.values()], usage, finishReason);
   }
}

export class OpenRouterError extends Error {
   readonly status: number;
   readonly detail: string;

   constructor(status: number, detail: string) {
      super(`OpenRouter request failed with ${status}`);
      this.name = 'OpenRouterError';
      this.status = status;
      this.detail = detail;
   }

   /** 429 and 5xx are worth retrying; a 400 is the request's own fault. */
   get retryable(): boolean {
      return this.status === 429 || this.status >= 500;
   }
}

// ---- request translation ---------------------------------------------------

/**
 * ADK contents into OpenAI messages.
 *
 * The system instruction lives in `config.systemInstruction` rather than in
 * `contents`, so it is prepended here — an agent whose instructions silently
 * failed to reach the model is the kind of bug that looks like a bad prompt.
 */
export function toOpenAIMessages(llmRequest: LlmRequest): OpenAIMessage[] {
   const messages: OpenAIMessage[] = [];

   const system = systemText(llmRequest.config?.systemInstruction);
   if (system) messages.push({ role: 'system', content: system });

   for (const content of llmRequest.contents ?? []) {
      messages.push(...contentToMessages(content));
   }
   return messages;
}

function contentToMessages(content: Content): OpenAIMessage[] {
   const parts = content.parts ?? [];
   const messages: OpenAIMessage[] = [];

   // A tool result is its own message with its own role, not text on a turn.
   const responses = parts.filter((part) => part.functionResponse);
   for (const part of responses) {
      const response = part.functionResponse!;
      messages.push({
         role: 'tool',
         tool_call_id: response.id ?? response.name ?? '',
         ...(response.name ? { name: response.name } : {}),
         content: JSON.stringify(response.response ?? null),
      });
   }

   const text = parts
      .filter((part) => typeof part.text === 'string' && !part.thought)
      .map((part) => part.text)
      .join('');
   const calls = parts.filter((part) => part.functionCall).map(toOpenAIToolCall);

   if (text === '' && calls.length === 0) return messages;

   // ADK says "model"; OpenAI says "assistant". Everything else is "user".
   const role: OpenAIMessage['role'] = content.role === 'model' ? 'assistant' : 'user';
   messages.push({
      role,
      content: text === '' ? null : text,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
   });
   return messages;
}

function toOpenAIToolCall(part: Part): OpenAIToolCall {
   const call = part.functionCall!;
   return {
      id: call.id ?? call.name ?? '',
      type: 'function',
      function: { name: call.name ?? '', arguments: JSON.stringify(call.args ?? {}) },
   };
}

function systemText(instruction: unknown): string {
   if (!instruction) return '';
   if (typeof instruction === 'string') return instruction;
   if (Array.isArray(instruction)) return instruction.map(systemText).filter(Boolean).join('\n');
   const content = instruction as Content;
   if (content.parts) {
      return content.parts.map((part) => part.text ?? '').filter(Boolean).join('\n');
   }
   return '';
}

export function toOpenAITools(llmRequest: LlmRequest): Array<Record<string, unknown>> {
   const declarations: FunctionDeclaration[] = [];
   for (const tool of llmRequest.config?.tools ?? []) {
      const functions = (tool as { functionDeclarations?: FunctionDeclaration[] })
         .functionDeclarations;
      if (functions) declarations.push(...functions);
   }

   return declarations.map((declaration) => ({
      type: 'function',
      function: {
         name: declaration.name,
         ...(declaration.description ? { description: declaration.description } : {}),
         parameters: toJsonSchema(declaration.parametersJsonSchema ?? declaration.parameters) ?? {
            type: 'object',
            properties: {},
         },
      },
   }));
}

/**
 * ADK's schema into the JSON Schema OpenRouter accepts.
 *
 * ADK emits Google's Schema shape, whose `type` is an uppercase enum —
 * `"OBJECT"`, `"STRING"`. OpenRouter rejects the whole request with
 * `400 Provider returned error` when it sees one, and the message says nothing
 * about the casing. Lowering it recursively is the entire fix, and it is the
 * single most confusing failure in this integration.
 */
export function toJsonSchema(schema: unknown): Record<string, unknown> | undefined {
   if (schema === null || schema === undefined) return undefined;
   if (Array.isArray(schema)) {
      return schema.map((entry) => toJsonSchema(entry)) as unknown as Record<string, unknown>;
   }
   if (typeof schema !== 'object') return schema as Record<string, unknown>;

   const out: Record<string, unknown> = {};
   for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'type' && typeof value === 'string') {
         out[key] = value.toLowerCase();
      } else if (value !== null && typeof value === 'object') {
         out[key] = toJsonSchema(value);
      } else {
         out[key] = value;
      }
   }
   return out;
}

// ---- response translation --------------------------------------------------

interface StreamChunk {
   choices?: Array<{
      delta?: {
         content?: string | null;
         tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
         }>;
      };
      message?: OpenAIMessage;
      finish_reason?: string | null;
   }>;
   usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export function parseCompletion(payload: unknown): LlmResponse {
   const chunk = payload as StreamChunk;
   const choice = chunk.choices?.[0];
   const message = choice?.message;
   const calls = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      args: call.function.arguments,
   }));
   return finalResponse(
      typeof message?.content === 'string' ? message.content : '',
      calls,
      chunk.usage ? toUsage(chunk.usage) : undefined,
      choice?.finish_reason ?? undefined
   );
}

function finalResponse(
   text: string,
   calls: Array<{ id: string; name: string; args: string }>,
   usage: Usage | undefined,
   finishReason: string | undefined
): LlmResponse {
   const parts: Part[] = [];
   if (text !== '') parts.push({ text });
   for (const call of calls) {
      parts.push({
         functionCall: {
            id: call.id,
            name: call.name,
            // Arguments arrive as a JSON string. A model that emits malformed
            // JSON produces an empty object rather than throwing, so the agent
            // sees a tool call it can refuse instead of the turn dying.
            args: safeParseArgs(call.args),
         },
      });
   }

   return {
      content: { role: 'model', parts },
      partial: false,
      turnComplete: true,
      ...(usage
         ? {
              usageMetadata: {
                 promptTokenCount: usage.promptTokens,
                 candidatesTokenCount: usage.completionTokens,
                 totalTokenCount: usage.totalTokens,
              },
           }
         : {}),
      ...(finishReason ? { finishReason: toFinishReason(finishReason) } : {}),
   } as LlmResponse;
}

function safeParseArgs(raw: string): Record<string, unknown> {
   if (!raw) return {};
   try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
         ? (parsed as Record<string, unknown>)
         : {};
   } catch {
      return {};
   }
}

/** OpenAI's finish reasons onto the GenAI enum ADK reports. */
function toFinishReason(reason: string): string {
   switch (reason) {
      case 'stop':
      case 'tool_calls':
      case 'function_call':
         return 'STOP';
      case 'length':
         return 'MAX_TOKENS';
      case 'content_filter':
         return 'SAFETY';
      default:
         return 'FINISH_REASON_UNSPECIFIED';
   }
}

function toUsage(usage: {
   prompt_tokens?: number;
   completion_tokens?: number;
   total_tokens?: number;
}): Usage {
   const promptTokens = usage.prompt_tokens ?? 0;
   const completionTokens = usage.completion_tokens ?? 0;
   return {
      promptTokens,
      completionTokens,
      totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
   };
}
