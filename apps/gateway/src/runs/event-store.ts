// Run event store — the seam between event *producers* (the dispatch path and
// the OpenFang adapter projection, which persist Berry events) and the SSE
// *consumer* (the run-streaming endpoint, which replays retained events then
// follows live ones). The contract requires that every event is persisted
// before delivery and that replay and live delivery use the identical shape, so
// producers only ever call `append` and the endpoint only ever calls `open`.
//
// This is a `RunEventStream` port with an in-process implementation suitable for
// the single-node Release 1 gateway. A Valkey/Postgres-backed implementation
// (durable, multi-node resumable replay) can drop in behind the same interface
// without touching the route.

import type { RunEventEnvelope } from "~/runs/events";
import { DEFAULT_RETENTION_MS } from "~/runs/events";

/** One pull from a subscription: the next event, an idle tick, or the end. */
export type NextResult =
  | { kind: "event"; event: RunEventEnvelope }
  | { kind: "idle" }
  | { kind: "closed" };

/**
 * A live cursor over one run's events. `open` pre-loads any replay backlog, then
 * live events arrive in order. The consumer pulls one at a time.
 */
export interface RunEventSubscription {
  /**
   * Resolve with the next buffered/live event, or `{ kind: "idle" }` if none
   * arrives within `timeoutMs` (drives heartbeats), or `{ kind: "closed" }`
   * once the subscription is closed.
   */
  next(timeoutMs: number): Promise<NextResult>;
  /** Idempotent; detaches from the store and unblocks a pending `next`. */
  close(): void;
}

export type OpenResult =
  | { ok: true; subscription: RunEventSubscription }
  | { ok: false; reason: "cursor_expired" };

export interface RunEventStream {
  /** Whether the run is known to the store (has been created or has events). */
  hasRun(runId: string): boolean;
  /** Register a run's existence before its first event (dispatch acceptance). */
  ensureRun(runId: string): void;
  /** Persist an event and fan it out to live subscribers. */
  append(event: RunEventEnvelope): void;
  /**
   * Begin replay+follow. When `afterCursor` is set, the backlog is every
   * retained event after the one with that id; an unresolvable cursor (pruned
   * past retention, or unknown) yields `cursor_expired`. Registers the live
   * listener synchronously so no event can slip between backlog and follow.
   */
  open(runId: string, opts?: { afterCursor?: string }): OpenResult;
}

interface StoredEvent {
  event: RunEventEnvelope;
  storedAtMs: number;
}

interface RunLog {
  events: StoredEvent[];
  subscriptions: Set<InMemorySubscription>;
}

class InMemorySubscription implements RunEventSubscription {
  private readonly buffer: RunEventEnvelope[];
  private waiter: ((result: NextResult) => void) | null = null;
  private waiterTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    backlog: readonly RunEventEnvelope[],
    private readonly onClose: () => void,
  ) {
    this.buffer = [...backlog];
  }

  /** Called by the store on every appended event. */
  deliver(event: RunEventEnvelope): void {
    if (this.closed) return;
    if (this.waiter) {
      this.settle({ kind: "event", event });
    } else {
      this.buffer.push(event);
    }
  }

  next(timeoutMs: number): Promise<NextResult> {
    if (this.closed) {
      return Promise.resolve({ kind: "closed" });
    }
    const buffered = this.buffer.shift();
    if (buffered) {
      return Promise.resolve({ kind: "event", event: buffered });
    }
    return new Promise<NextResult>((resolve) => {
      this.waiter = resolve;
      this.waiterTimer = setTimeout(() => this.settle({ kind: "idle" }), timeoutMs);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.settle({ kind: "closed" });
    this.onClose();
  }

  private settle(result: NextResult): void {
    const resolve = this.waiter;
    if (this.waiterTimer !== null) {
      clearTimeout(this.waiterTimer);
    }
    this.waiter = null;
    this.waiterTimer = null;
    if (resolve) {
      resolve(result);
    }
  }
}

export interface InMemoryRunEventStreamOptions {
  /** Retention window for resumable replay; defaults to the 24h contract floor. */
  retentionMs?: number;
  /** Injectable clock for deterministic retention tests. */
  now?: () => number;
}

export class InMemoryRunEventStream implements RunEventStream {
  private readonly runs = new Map<string, RunLog>();
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(options: InMemoryRunEventStreamOptions = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  ensureRun(runId: string): void {
    this.getOrCreate(runId);
  }

  append(event: RunEventEnvelope): void {
    const log = this.getOrCreate(event.runId);
    log.events.push({ event, storedAtMs: this.now() });
    this.prune(log);
    for (const subscription of log.subscriptions) {
      subscription.deliver(event);
    }
  }

  open(runId: string, opts: { afterCursor?: string } = {}): OpenResult {
    const log = this.getOrCreate(runId);
    this.prune(log);

    const afterCursor = opts.afterCursor;
    let backlog: RunEventEnvelope[];
    if (afterCursor !== undefined && afterCursor !== "") {
      const index = log.events.findIndex((stored) => stored.event.id === afterCursor);
      if (index === -1) {
        // The cursor's event is no longer retained (pruned) or was never seen;
        // either way we cannot guarantee a contiguous replay, so the client must
        // reconnect without a cursor and reconcile from the run resource.
        return { ok: false, reason: "cursor_expired" };
      }
      backlog = log.events.slice(index + 1).map((stored) => stored.event);
    } else {
      backlog = log.events.map((stored) => stored.event);
    }

    const subscription = new InMemorySubscription(backlog, () => {
      log.subscriptions.delete(subscription);
    });
    log.subscriptions.add(subscription);
    return { ok: true, subscription };
  }

  private getOrCreate(runId: string): RunLog {
    const existing = this.runs.get(runId);
    if (existing) {
      return existing;
    }
    const created: RunLog = { events: [], subscriptions: new Set() };
    this.runs.set(runId, created);
    return created;
  }

  /** Drop events older than the retention window (they lead the array). */
  private prune(log: RunLog): void {
    const cutoff = this.now() - this.retentionMs;
    let removeCount = 0;
    while (removeCount < log.events.length && log.events[removeCount].storedAtMs < cutoff) {
      removeCount += 1;
    }
    if (removeCount > 0) {
      log.events.splice(0, removeCount);
    }
  }
}

/**
 * Process-wide default store. The route uses this unless a store is injected;
 * tests build their own `InMemoryRunEventStream` for isolation.
 */
export const runEventStore: RunEventStream = new InMemoryRunEventStream();
