import { z } from 'zod';
import type { ExecEvent } from './driver.ts';

/**
 * The wire format between Berry and an execution driver that speaks HTTP.
 *
 * Server-sent events carrying one JSON object per frame. The frame's `data` is
 * the whole event including its `type`, rather than splitting the type into an
 * `event:` line — self-describing frames survive being logged, replayed and
 * pasted into a bug report, and there is only one thing to parse.
 *
 * `protocol.ts` in the runtime service is the shared description. The schema
 * below is the enforcement, and the two have to agree.
 */

const execEvent: z.ZodType<ExecEvent> = z.discriminatedUnion('type', [
   z.object({ type: z.literal('start'), seq: z.number().int().nonnegative(), command: z.string() }),
   z.object({ type: z.literal('stdout'), seq: z.number().int().nonnegative(), data: z.string() }),
   z.object({ type: z.literal('stderr'), seq: z.number().int().nonnegative(), data: z.string() }),
   z.object({
      type: z.literal('exit'),
      seq: z.number().int().nonnegative(),
      exitCode: z.number().int(),
   }),
   z.object({ type: z.literal('error'), seq: z.number().int().nonnegative(), message: z.string() }),
]);

/** True once the stream has said how the command ended. */
export function isTerminal(event: ExecEvent): boolean {
   return event.type === 'exit' || event.type === 'error';
}

/**
 * Yields the frames of an SSE body.
 *
 * Comment lines (`:` heartbeats) are skipped, `data:` lines within one frame
 * are joined with a newline as the specification requires, and `\r\n` is
 * tolerated because a proxy may rewrite line endings.
 *
 * A trailing frame with no closing blank line is dispatched rather than
 * dropped. The specification says to discard it; here the last frame is the
 * one that carries the exit code, and silently losing it would turn a finished
 * command into one that appears to hang.
 */
export async function* readFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
   // Decoded by hand rather than through TextDecoderStream: the stream types
   // disagree about whether the writable side takes a BufferSource or a
   // Uint8Array, and a decoder with `stream: true` does the same job while
   // handling a multi-byte character split across two chunks.
   const reader = stream.getReader();
   const decoder = new TextDecoder();
   let buffer = '';
   const data: string[] = [];

   const frame = (): string | null => {
      if (data.length === 0) return null;
      const joined = data.join('\n');
      data.length = 0;
      return joined;
   };

   try {
      for (;;) {
         const { done, value } = await reader.read();
         if (done) break;
         buffer += decoder.decode(value, { stream: true });

         for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline === -1) break;
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);

            if (line === '') {
               const complete = frame();
               if (complete !== null) yield complete;
               continue;
            }
            if (line.startsWith(':')) continue;
            if (line.startsWith('data:')) {
               // One optional space after the colon is part of the framing,
               // not of the payload.
               data.push(line.slice(5).replace(/^ /, ''));
            }
            // Any other field (event:, id:, retry:) is not used by this
            // protocol and is ignored rather than rejected, so the format can
            // gain one without breaking older readers.
         }
      }

      // Flush any bytes the decoder is still holding for a split character.
      buffer += decoder.decode();

      // Whatever the last chunk left behind, without a newline to close it.
      if (buffer !== '') {
         const line = buffer.replace(/\r$/, '');
         if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      const trailing = frame();
      if (trailing !== null) yield trailing;
   } finally {
      reader.releaseLock();
   }
}

/** Parses one frame, or throws with the payload that failed. */
export function decodeEvent(payload: string): ExecEvent {
   let json: unknown;
   try {
      json = JSON.parse(payload);
   } catch (cause) {
      throw new Error(`execution stream sent a frame that is not JSON: ${clip(payload)}`, {
         cause,
      });
   }
   const parsed = execEvent.safeParse(json);
   if (!parsed.success) {
      throw new Error(`execution stream sent an unrecognised event: ${clip(payload)}`);
   }
   return parsed.data;
}

/** Frames to events, in order. */
export async function* decodeEvents(
   stream: ReadableStream<Uint8Array>
): AsyncGenerator<ExecEvent> {
   for await (const payload of readFrames(stream)) {
      yield decodeEvent(payload);
   }
}

/** Bounded, because a malformed frame can be a megabyte of HTML. */
function clip(value: string): string {
   return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

/** Serializes an event as an SSE frame. The worker writes these; tests read them. */
export function encodeFrame(event: ExecEvent): string {
   return `data: ${JSON.stringify(event)}\n\n`;
}
