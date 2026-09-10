import { z } from 'zod';
import type { Sql } from '../db/pool.ts';
import { enqueueTask } from '../runs/queue.ts';
import type { TranscriptMessage } from './envelope.ts';
import type { CompletionSpec } from './envelope-builder.ts';

/**
 * One model call for the parts of Berry that are not an agent, executed as a
 * `kind: 'completion'` task on the runtime — the only place Bedrock is called
 * from (ADR-0014). It runs as the workspace's protected Orchestrator, so its
 * usage is billed to the workspace like any other task.
 */

export interface CompletionDeps {
   sql: Sql;
   /** Asks the dispatcher to look now rather than at its next poll. */
   nudge?: () => void;
   timeoutMs?: number;
   pollMs?: number;
   defaultModel?: string;
}

export interface CompletionResult<T> {
   value: T;
   text: string;
   inputTokens: number;
   outputTokens: number;
   durationMs: number;
}

export class CompletionFailed extends Error {
   override readonly name = 'CompletionFailed';
   readonly code: string;
   readonly retryable: boolean;
   constructor(failure: { code: string; message: string; retryable: boolean }) {
      super(failure.message);
      this.code = failure.code;
      this.retryable = failure.retryable;
   }
}

export class CompletionInvalid extends Error {
   override readonly name = 'CompletionInvalid';
   readonly raw: string;
   constructor(message: string, raw: string) {
      super(message);
      this.raw = raw;
   }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 200;

export async function runCompletion<T>(
   deps: CompletionDeps,
   input: {
      workspaceId: string;
      purpose: string;
      system: string;
      prompt: string;
      schema: z.ZodType<T>;
      model?: string;
      transcript?: TranscriptMessage[];
      signal?: AbortSignal;
   }
): Promise<T> {
   const result = await runCompletionTask(deps, input);
   return result.value as T;
}

export async function runCompletionTask(
   deps: CompletionDeps,
   input: {
      workspaceId: string;
      purpose: string;
      system: string;
      prompt: string;
      schema: z.ZodType | null;
      model?: string;
      transcript?: TranscriptMessage[];
      signal?: AbortSignal;
   }
): Promise<CompletionResult<unknown>> {
   const started = Date.now();
   const [orchestrator] = await deps.sql`
      SELECT id FROM agents WHERE workspace_id = ${input.workspaceId} AND protected AND archived_at IS NULL`;
   if (!orchestrator) throw new CompletionFailed({ code: 'NO_ORCHESTRATOR', message: 'this workspace has no orchestrator', retryable: false });

   const spec: CompletionSpec = {
      purpose: input.purpose,
      system: input.system,
      jsonSchema: input.schema ? (z.toJSONSchema(input.schema) as Record<string, unknown>) : null,
      model: input.model ?? deps.defaultModel ?? null,
      ...(input.transcript ? { transcript: input.transcript } : {}),
   };
   let runId = '';
   await deps.sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      ({ runId } = await enqueueTask(tx, {
         workspaceId: input.workspaceId,
         agentId: orchestrator.id as string,
         kind: 'completion',
         source: 'completion',
         prompt: input.prompt,
         priority: 10,
      }));
      await tx`UPDATE runs SET completion_spec = ${tx.json(spec as never)} WHERE id = ${runId}`;
   });
   deps.nudge?.();

   const deadline = started + (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
   while (true) {
      const [row] = await deps.sql`
         SELECT status::text AS status, result, input_tokens, output_tokens,
                failure_code, failure_message, failure_retryable
           FROM runs WHERE id = ${runId}`;
      const status = row?.status as string | undefined;
      if (status === 'succeeded') {
         const result = (row!.result ?? {}) as { text?: string; structured?: unknown };
         const text = result.text ?? '';
         let value: unknown = text;
         if (input.schema) {
            const parsed = input.schema.safeParse(result.structured);
            if (!parsed.success) throw new CompletionInvalid('the model did not answer in the shape it was asked for', text);
            value = parsed.data;
         }
         return {
            value,
            text,
            inputTokens: Number(row!.input_tokens),
            outputTokens: Number(row!.output_tokens),
            durationMs: Date.now() - started,
         };
      }
      if (status === 'failed') {
         const failure = {
            code: row!.failure_code as string,
            message: (row!.failure_message as string | null) ?? '',
            retryable: Boolean(row!.failure_retryable),
         };
         if (failure.code === 'COMPLETION_INVALID') throw new CompletionInvalid(failure.message, failure.message);
         throw new CompletionFailed(failure);
      }
      if (status === 'cancelled' || input.signal?.aborted || Date.now() > deadline) {
         // Cancelled on the row, so the dispatcher's heartbeat aborts the
         // invoke and stops the runtime session rather than paying for it.
         await deps.sql`
            UPDATE runs SET status = 'cancelled', dispatch_state = 'cancelled', completed_at = now(), updated_at = now()
             WHERE id = ${runId} AND status IN ('queued', 'running')`;
         throw new CompletionFailed({
            code: input.signal?.aborted ? 'COMPLETION_CANCELLED' : 'COMPLETION_TIMEOUT',
            message: 'the completion did not finish in time',
            retryable: !input.signal?.aborted,
         });
      }
      await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? DEFAULT_POLL_MS));
   }
}

type Call = { workspaceId: string; model: string; system: string; purpose?: string; signal?: AbortSignal | undefined };

/** The old `Completion` surface, so callers change their import and add a workspace. */
export class RuntimeCompletion {
   readonly #deps: CompletionDeps;

   constructor(deps: CompletionDeps) {
      this.#deps = deps;
   }

   async text(input: Call & { user: string }): Promise<CompletionResult<string>> {
      const result = await this.#run(input, input.user, null);
      return { ...result, value: result.text };
   }

   async json(input: Call & { user: string }): Promise<CompletionResult<unknown>> {
      return this.structured({ ...input, schema: z.looseObject({}) });
   }

   async structured<S extends z.ZodType>(input: Call & { user: string; schema: S }): Promise<CompletionResult<z.output<S>>> {
      const result = await this.#run(input, input.user, input.schema);
      return result as CompletionResult<z.output<S>>;
   }

   /** A multi-turn exchange ending on the user turn to answer. */
   async converse(input: Call & { messages: TranscriptMessage[] }): Promise<CompletionResult<string>> {
      const last = input.messages.at(-1);
      if (!last || last.role !== 'user') throw new CompletionInvalid('a conversation must end on the user turn to answer', '');
      const result = await this.#run(input, last.text, null, input.messages.slice(0, -1));
      return { ...result, value: result.text };
   }

   #run(input: Call, prompt: string, schema: z.ZodType | null, transcript?: TranscriptMessage[]) {
      return runCompletionTask(this.#deps, {
         workspaceId: input.workspaceId,
         purpose: input.purpose ?? 'completion',
         system: input.system,
         prompt,
         schema,
         model: input.model,
         ...(transcript ? { transcript } : {}),
         ...(input.signal ? { signal: input.signal } : {}),
      });
   }
}
