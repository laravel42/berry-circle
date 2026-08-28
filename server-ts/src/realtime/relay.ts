import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { MAX_EVENT_PAYLOAD_BYTES, normalizeEvent, validateEvent, type Event } from './event.ts';
import type { Observer } from './hub.ts';

/**
 * The cross-process relay.
 *
 * One Berry node publishes a fact; every other node's subscribers need to hear
 * it. The relay is a Valkey stream carrying those invalidations — bounded,
 * expiring, and deliberately not durable: the fact itself is in PostgreSQL,
 * and this stream only tells other nodes to look.
 *
 * That is also why the stream is trimmed and given a TTL. A relay that fell
 * behind and retained everything would eventually cost more than the database
 * it is protecting, to deliver events whose subject has already changed.
 */

const KEY_PREFIX = 'berry:realtime:v1:';
const DEFAULT_STREAM_MAX_LEN = 10_000;
const DEFAULT_STREAM_TTL_MS = 15 * 60 * 1000;
const DEFAULT_READ_BLOCK_MS = 5_000;
const MAX_ENVELOPE_BYTES = MAX_EVENT_PAYLOAD_BYTES + 2048;

/**
 * XADD then PEXPIRE in one round trip.
 *
 * Scripted so the two cannot separate: an XADD whose PEXPIRE never ran leaves
 * a stream that outlives its usefulness and is never cleaned up.
 */
const PUBLISH_SCRIPT = `
local id = redis.call(
  "XADD", KEYS[1], "MAXLEN", "~", ARGV[1], "*", "event", ARGV[3]
)
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return id
`;

export interface RelayConfig {
   nodeId?: string;
   namespace?: string;
   streamMaxLen?: number;
   streamTtlMs?: number;
   readBlockMs?: number;
   observer?: Observer;
}

export interface Relay {
   publish(event: Event): Promise<void>;
   run(receive: (event: Event) => Promise<void>, signal: AbortSignal): Promise<void>;
   ping(): Promise<void>;
   prepare(): Promise<void>;
   close(): Promise<void>;
   readonly nodeId: string;
}

/** For a single-process deployment, where there is nothing to relay to. */
export class NoopRelay implements Relay {
   readonly nodeId = randomUUID();
   async publish(): Promise<void> {}
   async run(_receive: unknown, signal: AbortSignal): Promise<void> {
      await new Promise<void>((resolve) => {
         if (signal.aborted) return resolve();
         signal.addEventListener('abort', () => resolve(), { once: true });
      });
   }
   async ping(): Promise<void> {}
   async prepare(): Promise<void> {}
   async close(): Promise<void> {}
}

export class ValkeyRelay implements Relay {
   readonly nodeId: string;
   private readonly client: Redis;
   private readonly streamKey: string;
   private readonly streamMaxLen: number;
   private readonly streamTtlMs: number;
   private readonly readBlockMs: number;
   private readonly observer: Observer | undefined;
   private readonly ownClient: boolean;
   private lastId = '';
   private closed = false;

   constructor(client: Redis, config: RelayConfig = {}, ownClient = false) {
      this.client = client;
      this.ownClient = ownClient;
      this.nodeId = config.nodeId?.trim() || randomUUID();
      this.observer = config.observer;
      this.streamMaxLen = config.streamMaxLen ?? DEFAULT_STREAM_MAX_LEN;
      this.streamTtlMs = config.streamTtlMs ?? DEFAULT_STREAM_TTL_MS;
      this.readBlockMs = config.readBlockMs ?? DEFAULT_READ_BLOCK_MS;
      if (this.readBlockMs < 10 || this.readBlockMs >= this.streamTtlMs) {
         throw new Error('realtime relay read block is invalid');
      }
      // The namespace is part of the key, so two deployments sharing one
      // Valkey do not deliver each other's events.
      this.streamKey = config.namespace
         ? `${KEY_PREFIX}${config.namespace}:events`
         : `${KEY_PREFIX}events`;
   }

   /** `valkey://` is the same protocol under a different name. */
   static open(url: string, config: RelayConfig = {}): ValkeyRelay {
      const normalized = url.startsWith('valkey://')
         ? `redis://${url.slice('valkey://'.length)}`
         : url;
      return new ValkeyRelay(new Redis(normalized, { lazyConnect: true }), config, true);
   }

   async ping(): Promise<void> {
      await this.client.ping();
   }

   async publish(event: Event): Promise<void> {
      if (this.closed) throw new Error('realtime relay is closed');
      const normalized = normalizeEvent(event);
      const body = encodeEnvelope(this.nodeId, normalized);
      if (Buffer.byteLength(body, 'utf8') > MAX_ENVELOPE_BYTES) {
         throw new Error(`realtime relay event exceeds ${MAX_ENVELOPE_BYTES} bytes`);
      }
      await this.client.eval(
         PUBLISH_SCRIPT,
         1,
         this.streamKey,
         String(this.streamMaxLen),
         String(this.streamTtlMs),
         body
      );
   }

   /**
    * Starts reading from the stream's current end, not its beginning.
    *
    * A node joining an existing deployment has no business replaying fifteen
    * minutes of invalidations for state it is about to read fresh anyway.
    */
   async prepare(): Promise<void> {
      if (this.lastId !== '') return;
      try {
         const info = (await this.client.xinfo('STREAM', this.streamKey)) as unknown[];
         this.lastId = lastGeneratedId(info) ?? '0-0';
      } catch (error) {
         // A stream nobody has published to yet is not an error.
         if (!isMissingStream(error)) throw error;
         this.lastId = '0-0';
      }
   }

   async run(receive: (event: Event) => Promise<void>, signal: AbortSignal): Promise<void> {
      await this.ping();
      await this.prepare();

      while (!signal.aborted && !this.closed) {
         const streams = (await this.client.xread(
            'COUNT',
            128,
            'BLOCK',
            this.readBlockMs,
            'STREAMS',
            this.streamKey,
            this.lastId || '0-0'
         )) as Array<[string, Array<[string, string[]]>]> | null;
         if (!streams) continue;

         for (const [, messages] of streams) {
            for (const [id, fields] of messages) {
               this.lastId = id;
               const decoded = decodeEnvelope(fields);
               if (decoded === null) {
                  this.observer?.({ kind: 'relayEventRejected' });
                  continue;
               }
               // Our own publish comes back on the stream; delivering it would
               // double every local event.
               if (decoded.nodeId === this.nodeId) continue;
               await receive({ ...decoded.event, originNodeId: decoded.nodeId });
            }
         }
      }
   }

   async close(): Promise<void> {
      if (this.closed) return;
      this.closed = true;
      if (this.ownClient) await this.client.quit().catch(() => undefined);
   }
}

interface Envelope {
   nodeId: string;
   event: Event;
}

/**
 * The envelope every node publishes into the shared stream.
 *
 * Field order, names and the RFC 3339 `occurredAt` are fixed: every process on
 * the stream has to read what the others write, so an envelope one node cannot
 * decode is an event that node's clients never see. `boardId` is omitted when
 * empty rather than sent as an empty string.
 */
export function encodeEnvelope(nodeId: string, event: Event): string {
   const wire: Record<string, unknown> = {
      version: 1,
      nodeId,
      event: {
         id: event.id,
         workspaceId: event.workspaceId,
         ...(event.boardId ? { boardId: event.boardId } : {}),
         type: event.type,
         payload: JSON.parse(event.payload),
         occurredAt: event.occurredAt.toISOString(),
      },
   };
   return JSON.stringify(wire);
}

export function decodeEnvelope(fields: string[]): Envelope | null {
   // XADD wrote a single `event` field; anything else is not ours.
   const index = fields.indexOf('event');
   if (index < 0 || index + 1 >= fields.length) return null;

   let parsed: {
      version?: number;
      nodeId?: string;
      event?: Record<string, unknown>;
   };
   try {
      parsed = JSON.parse(fields[index + 1]!);
   } catch {
      return null;
   }
   if (parsed.version !== 1 || !parsed.event) return null;

   const raw = parsed.event;
   const event: Event = {
      id: String(raw.id ?? ''),
      workspaceId: String(raw.workspaceId ?? ''),
      // Absent rather than empty, so it round-trips through omitempty.
      ...(raw.boardId === undefined ? {} : { boardId: String(raw.boardId) }),
      type: String(raw.type ?? ''),
      payload: JSON.stringify(raw.payload ?? null),
      occurredAt: new Date(String(raw.occurredAt ?? '')),
   };
   try {
      validateEvent(event);
   } catch {
      return null;
   }
   return { nodeId: String(parsed.nodeId ?? ''), event };
}

/** XINFO STREAM returns a flat key/value array. */
function lastGeneratedId(info: unknown[]): string | null {
   for (let index = 0; index + 1 < info.length; index += 2) {
      if (info[index] === 'last-generated-id') return String(info[index + 1]);
   }
   return null;
}

function isMissingStream(error: unknown): boolean {
   return error instanceof Error && /no such key/i.test(error.message);
}

/** Named for tests, so the wire format can be pinned without a live Valkey. */
export { encodeEnvelope as encodeEnvelopeForTest, decodeEnvelope as decodeEnvelopeForTest };
