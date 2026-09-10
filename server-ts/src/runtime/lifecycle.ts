import { z } from 'zod';

/**
 * What a runtime says back about one task, as an SSE stream.
 *
 * Shipped in the runtime image beside the loop, so it imports nothing but zod:
 * the image carries `src/agents/runtime/**` and these two contract files, and a
 * wider import here would drag the server into the container.
 *
 * `task.message` carries exactly what the ledger records today — output text,
 * tool start/stop, command start/output/stop, repository readiness and the
 * verification report — so the server maps each kind onto one ledger method.
 */

export const taskUsageSchema = z.object({
   model: z.string(),
   inputTokens: z.number().int().nonnegative(),
   outputTokens: z.number().int().nonnegative(),
   cacheReadTokens: z.number().int().nonnegative(),
   cacheWriteTokens: z.number().int().nonnegative(),
});

export const taskMessageSchema = z.discriminatedUnion('kind', [
   z.object({ kind: z.literal('output'), channel: z.string(), text: z.string() }),
   z.object({ kind: z.literal('tool.started'), toolCallId: z.string(), name: z.string() }),
   z.object({ kind: z.literal('tool.completed'), toolCallId: z.string(), succeeded: z.boolean() }),
   z.object({
      kind: z.literal('command.started'),
      commandId: z.string(),
      command: z.string(),
      cwd: z.string().nullable(),
   }),
   z.object({
      kind: z.literal('command.output'),
      commandId: z.string(),
      stream: z.enum(['stdout', 'stderr']),
      text: z.string(),
   }),
   z.object({
      kind: z.literal('command.completed'),
      commandId: z.string(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().nonnegative(),
      truncated: z.boolean(),
   }),
   z.object({
      kind: z.literal('repository.ready'),
      repository: z.string(),
      branch: z.string(),
      baseCommit: z.string(),
   }),
   z.object({
      kind: z.literal('verified'),
      passed: z.boolean(),
      complete: z.boolean(),
      durationMs: z.number().nonnegative(),
      results: z.array(
         z.object({
            command: z.string(),
            exitCode: z.number().int().nullable(),
            passed: z.boolean(),
            durationMs: z.number().nonnegative(),
            error: z.string().nullable(),
         })
      ),
   }),
]);

export const taskDeliverySchema = z.object({
   committed: z.boolean(),
   commit: z.string().nullable(),
   branch: z.string(),
   filesChanged: z.number().int().nonnegative(),
   insertions: z.number().int().nonnegative(),
   deletions: z.number().int().nonnegative(),
   files: z.array(z.string()),
});

export const taskResultSchema = z.object({
   text: z.string(),
   truncated: z.boolean(),
   /** The structured answer of a completion task, already validated by the model's schema. */
   structured: z.unknown().optional(),
   delivery: taskDeliverySchema.nullable(),
});

export const taskFailureSchema = z.object({
   code: z.string().min(1),
   message: z.string(),
   retryable: z.boolean(),
});

export const lifecycleEventSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('task.started') }),
   z.object({ type: z.literal('task.message'), message: taskMessageSchema }),
   z.object({ type: z.literal('task.usage'), usage: taskUsageSchema }),
   z.object({ type: z.literal('task.completed'), result: taskResultSchema }),
   z.object({ type: z.literal('task.failed'), failure: taskFailureSchema }),
]);

export type TaskUsage = z.infer<typeof taskUsageSchema>;
export type TaskMessage = z.infer<typeof taskMessageSchema>;
export type TaskDelivery = z.infer<typeof taskDeliverySchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type TaskFailure = z.infer<typeof taskFailureSchema>;
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

export class LifecycleStreamError extends Error {
   override readonly name = 'LifecycleStreamError';
}

/** One SSE frame. The payload is the whole event, so a frame stands alone. */
export function encodeLifecycle(event: LifecycleEvent): string {
   return `data: ${JSON.stringify(event)}\n\n`;
}

export function isTerminal(event: LifecycleEvent): boolean {
   return event.type === 'task.completed' || event.type === 'task.failed';
}

/**
 * Frames out of a byte stream, in order.
 *
 * A malformed frame throws rather than being skipped: a lost `task.completed`
 * would turn a finished run into `RUNTIME_STREAM_ENDED`, and a lost usage frame
 * would under-bill quietly. Comment frames (`: ping`) are keepalives.
 */
export async function* parseLifecycleStream(
   chunks: AsyncIterable<Uint8Array | string>
): AsyncGenerator<LifecycleEvent> {
   const decoder = new TextDecoder();
   let buffer = '';
   for await (const chunk of chunks) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      buffer = buffer.replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
         const frame = buffer.slice(0, boundary);
         buffer = buffer.slice(boundary + 2);
         const event = decodeFrame(frame);
         if (event) yield event;
         boundary = buffer.indexOf('\n\n');
      }
   }
   buffer = (buffer + decoder.decode()).replaceAll('\r\n', '\n');
   if (buffer.trim() !== '') {
      const event = decodeFrame(buffer);
      if (event) yield event;
   }
}

function decodeFrame(frame: string): LifecycleEvent | null {
   const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
   if (data === '') return null;
   let parsed: unknown;
   try {
      parsed = JSON.parse(data);
   } catch {
      throw new LifecycleStreamError('the runtime sent a lifecycle frame that is not JSON');
   }
   const result = lifecycleEventSchema.safeParse(parsed);
   if (!result.success) {
      throw new LifecycleStreamError(
         `the runtime sent an unrecognised lifecycle frame: ${result.error.issues
            .map((issue) => issue.path.join('.') || issue.message)
            .join(', ')}`
      );
   }
   return result.data;
}
