import {
   BedrockRuntimeClient,
   ConverseCommand,
   type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

/**
 * One model call, for the parts of Berry that are not an agent.
 *
 * The planner, the triage pass and the conversation responder each want the
 * same thing: a system prompt, a user message, and an answer back. They do not
 * want a tool loop, so they do not go through Strands — an agent framework for
 * a single completion is machinery with nothing to do.
 *
 * `Converse` rather than `InvokeModel` deliberately: it is the one Bedrock API
 * whose request and response shapes are the same across model families, so a
 * deployment can change `modelId` from Anthropic to Llama without this file
 * learning a second body format.
 */

export interface ChatResult {
   text: string;
   inputTokens: number;
   outputTokens: number;
   durationMs: number;
}

export class BedrockUnavailable extends Error {
   override readonly name = 'BedrockUnavailable';
   readonly retryable: boolean;
   constructor(message: string, retryable = false) {
      super(message);
      this.retryable = retryable;
   }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 8192;

export interface AwsCredentials {
   accessKeyId: string;
   secretAccessKey: string;
   // Not optional-with-undefined: the AWS clients are built with
   // `exactOptionalPropertyTypes`, and an explicit `undefined` is a different
   // thing to them than an absent key.
   sessionToken?: string;
}

export interface BedrockChatOptions {
   region: string;
   /** Omitted means the AWS default chain: a role, or a local profile. */
   credentials?: AwsCredentials | null;
   client?: BedrockRuntimeClient;
   timeoutMs?: number;
}

export class BedrockChat {
   readonly #client: BedrockRuntimeClient;
   readonly #timeoutMs: number;

   constructor(options: BedrockChatOptions) {
      this.#client =
         options.client ??
         new BedrockRuntimeClient({
            region: options.region,
            ...(options.credentials ? { credentials: options.credentials } : {}),
         });
      this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
   }

   /**
    * Asks for text.
    *
    * `json` asks the model to answer with JSON and nothing else. Bedrock has no
    * `response_format` across families the way an OpenAI-shaped API does, so
    * this is a prompt instruction rather than a guarantee — which is why every
    * caller still parses defensively, exactly as they did before.
    */
   async chat(input: {
      model: string;
      system: string;
      user: string;
      json?: boolean;
      maxTokens?: number;
      signal?: AbortSignal | undefined;
   }): Promise<ChatResult> {
      const started = Date.now();
      const system = input.json
         ? `${input.system}\n\nAnswer with JSON only. No prose, no code fence.`
         : input.system;

      const response = await this.#client
         .send(
            new ConverseCommand({
               modelId: input.model,
               system: [{ text: system }],
               messages: [{ role: 'user', content: [{ text: input.user }] }],
               inferenceConfig: { maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS },
            }),
            {
               abortSignal: (input.signal ??
                  AbortSignal.timeout(this.#timeoutMs)) as never,
            }
         )
         .catch((cause: unknown) => {
            // Throttling and a 5xx are worth another attempt; a validation
            // error on the model id will fail identically forever, and telling
            // a caller to retry it wastes a minute to reach the same place.
            const name = (cause as { name?: string })?.name ?? '';
            const retryable =
               name === 'ThrottlingException' ||
               name === 'ModelTimeoutException' ||
               name === 'ServiceUnavailableException' ||
               name === 'InternalServerException';
            throw new BedrockUnavailable(
               `bedrock ${input.model} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
               retryable
            );
         });

      const blocks: ContentBlock[] = response.output?.message?.content ?? [];
      const text = blocks
         .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
         .join('');

      return {
         text,
         inputTokens: response.usage?.inputTokens ?? 0,
         outputTokens: response.usage?.outputTokens ?? 0,
         durationMs: Date.now() - started,
      };
   }
}

/**
 * The first JSON value in a model's answer.
 *
 * Kept here rather than in each caller because every one of them needs it for
 * the same reason: a model asked for JSON may still wrap it in a fence or a
 * sentence, and a run should not fail over punctuation.
 */
export function readJson(text: string): unknown {
   const trimmed = text.trim();
   const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
   const body = fenced?.[1] ?? trimmed;
   try {
      return JSON.parse(body);
   } catch {
      // A model that added a sentence before the object: take the outermost
      // braces rather than giving up on an answer that is mostly right.
      const start = body.indexOf('{');
      const end = body.lastIndexOf('}');
      if (start === -1 || end <= start) return null;
      try {
         return JSON.parse(body.slice(start, end + 1));
      } catch {
         return null;
      }
   }
}
