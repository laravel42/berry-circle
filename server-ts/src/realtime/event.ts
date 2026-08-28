import { randomUUID } from 'node:crypto';

/**
 * Realtime events.
 *
 * An event is an ephemeral projection of a fact already written to PostgreSQL.
 * Losing one is survivable — the client refetches — which is what lets the hub
 * drop a slow subscriber rather than buffer for it.
 */

export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const MAX_WORKSPACE_ID_BYTES = 128;
const MAX_EVENT_ID_BYTES = 128;
const MAX_EVENT_TYPE_BYTES = 128;

export interface Event {
   id: string;
   workspaceId: string;
   /**
    * A second delivery scope.
    *
    * Board streams subscribe on the board id while workspace-wide consumers
    * subscribe on the workspace id, and one fact must reach both without being
    * published twice — so the hub fans an event out to every subscriber of
    * either scope. Empty for facts belonging to no board.
    */
   boardId?: string;
   type: string;
   payload: string;
   occurredAt: Date;
   /** Relay metadata. Never sent to a browser. */
   originNodeId?: string;
}

export class InvalidEvent extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'InvalidEvent';
   }
}

/**
 * Fills in what a publisher may omit, then validates the whole event.
 *
 * An absent id becomes a fresh UUID and an absent payload becomes the JSON
 * literal `null` rather than an empty string, because a consumer parses the
 * payload unconditionally.
 */
export function normalizeEvent(event: Event): Event {
   const normalized: Event = {
      ...event,
      id: event.id?.trim() === '' || event.id === undefined ? randomUUID() : event.id,
      payload: event.payload ?? 'null',
      occurredAt: event.occurredAt ?? new Date(),
   };
   validateEvent(normalized);
   return normalized;
}

export function validateEvent(event: Event): void {
   if (!validIdentifier(event.id, MAX_EVENT_ID_BYTES)) {
      throw new InvalidEvent('realtime event requires a valid id');
   }
   if (!validIdentifier(event.workspaceId, MAX_WORKSPACE_ID_BYTES)) {
      throw new InvalidEvent('realtime event requires a valid workspaceId');
   }
   if (
      event.boardId !== undefined &&
      event.boardId !== '' &&
      !validIdentifier(event.boardId, MAX_WORKSPACE_ID_BYTES)
   ) {
      throw new InvalidEvent('realtime event boardId is invalid');
   }
   if (!validEventType(event.type)) {
      throw new InvalidEvent('realtime event requires a valid type');
   }
   if (Buffer.byteLength(event.payload, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
      throw new InvalidEvent(`realtime event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`);
   }
   try {
      JSON.parse(event.payload);
   } catch {
      throw new InvalidEvent('realtime event payload must be valid JSON');
   }
   if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) {
      throw new InvalidEvent('realtime event requires occurredAt');
   }
}

/**
 * The subscription keys one event is delivered to.
 *
 * The board is listed once even when a caller passes the same id for both
 * fields, so a subscriber on that scope does not receive the event twice.
 */
export function eventScopes(event: Event): string[] {
   if (!event.boardId || event.boardId === event.workspaceId) return [event.workspaceId];
   return [event.workspaceId, event.boardId];
}

/**
 * An identifier safe to use as a channel key.
 *
 * Deliberately narrow — these become Valkey stream names and subscription
 * keys, so anything outside this alphabet is refused rather than escaped.
 */
function validIdentifier(value: string | undefined, maxBytes: number): boolean {
   if (!value || Buffer.byteLength(value, 'utf8') > maxBytes || value.trim() !== value) {
      return false;
   }
   return /^[A-Za-z0-9\-_.]+$/.test(value);
}

/** Lowercase, starting with a letter: `issue.created`, never `Issue.Created`. */
function validEventType(value: string | undefined): boolean {
   if (!value || Buffer.byteLength(value, 'utf8') > MAX_EVENT_TYPE_BYTES || value.trim() !== value) {
      return false;
   }
   return /^[a-z][a-z0-9._-]*$/.test(value);
}
