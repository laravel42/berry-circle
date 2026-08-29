import { z } from 'zod';
import { apiStream } from './api';

/**
 * Workspace event stream: the envelope every SSE frame shares, a parser for
 * one frame, and an async generator over `GET /api/v1/events?workspaceId=`.
 *
 * Every scope id is optional because the workspace stream carries facts that
 * belong to no board, no issue and no run — a goal was created, a plan was
 * compiled, an approval was requested — and a frame missing an id must still
 * reach the listener that refreshes the store behind it.
 */
export const eventEnvelopeSchema = z.object({
   id: z.string(),
   type: z.string(),
   occurredAt: z.string(),
   workspaceId: z.string().nullish(),
   boardId: z.string().nullish(),
   issueId: z.string().nullish(),
   runId: z.string().nullish(),
   goalId: z.string().nullish(),
   approvalId: z.string().nullish(),
   planId: z.string().nullish(),
   stepId: z.string().nullish(),
   sequence: z.number().nullish(),
   payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** One `event:`/`data:` block of an SSE body, or undefined for heartbeats and noise. */
export function parseSseFrame(block: string): EventEnvelope | undefined {
   let eventName = '';
   const dataLines: string[] = [];
   for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
         eventName = line.slice(6).trim();
         continue;
      }
      if (line.startsWith('data:')) {
         dataLines.push(line.slice(5).trimStart());
      }
   }
   if (!eventName || dataLines.length === 0) return undefined;
   try {
      const parsed = eventEnvelopeSchema.safeParse(JSON.parse(dataLines.join('\n')));
      return parsed.success ? parsed.data : undefined;
   } catch {
      return undefined;
   }
}

/** Reads an SSE response body frame by frame until it ends or the signal aborts. */
export async function* readSseFrames(
   response: Response,
   label: string
): AsyncGenerator<EventEnvelope> {
   if (!response.body) {
      throw new Error(`${label} stream had no body`);
   }
   const reader = response.body.getReader();
   const decoder = new TextDecoder();
   let buffer = '';
   try {
      while (true) {
         const { done, value } = await reader.read();
         if (done) break;
         buffer += decoder.decode(value, { stream: true });
         const blocks = buffer.split('\n\n');
         buffer = blocks.pop() ?? '';
         for (const block of blocks) {
            const event = parseSseFrame(block);
            if (event) yield event;
         }
      }
      const tail = parseSseFrame(buffer);
      if (tail) yield tail;
   } finally {
      reader.releaseLock();
   }
}

export interface StreamOptions {
   /** Resume after this event id; the server replays what came after it. */
   after?: string;
   signal?: AbortSignal;
}

/**
 * Every product change in a workspace, as it happens: goals, approvals,
 * plans, and the workspace-wide issue and agent moments. The caller keeps
 * the last id it saw and passes it back as `after` on reconnect, so a
 * dropped connection loses nothing.
 */
export async function* streamWorkspaceEvents(
   workspaceId: string,
   options: StreamOptions = {}
): AsyncGenerator<EventEnvelope> {
   const params = new URLSearchParams({ workspaceId });
   if (options.after) params.set('after', options.after);
   const response = await apiStream(`/api/v1/events?${params.toString()}`, undefined, {
      signal: options.signal,
   });
   yield* readSseFrames(response, 'Workspace event');
}

/** The id inside a `plan.*`, `goal.*`, `approval.*` or `run.*` payload, when present. */
export function payloadEntityId(
   event: EventEnvelope,
   key: 'plan' | 'goal' | 'approval' | 'run'
): string | undefined {
   const payload = event.payload;
   if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
   const entity = (payload as Record<string, unknown>)[key];
   if (typeof entity !== 'object' || entity === null) return undefined;
   const id = (entity as { id?: unknown }).id;
   return typeof id === 'string' ? id : undefined;
}

// ---------------------------------------------------------------------------
// In-page fan-out

type Listener = (event: EventEnvelope) => void;

const listeners = new Set<Listener>();

/**
 * Subscribe to the frames the workspace stream hook receives. One
 * connection per page feeds every interested component; a plan page, for
 * instance, refetches its record on `plan.updated` without opening a stream
 * of its own.
 */
export function subscribeWorkspaceEvents(listener: Listener): () => void {
   listeners.add(listener);
   return () => {
      listeners.delete(listener);
   };
}

export function publishWorkspaceEvent(event: EventEnvelope): void {
   for (const listener of listeners) {
      try {
         listener(event);
      } catch {
         // One listener's bug must not stop the others from seeing the frame.
      }
   }
}
