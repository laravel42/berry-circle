// Berry run event contract — the SSE `EventEnvelope` shape and run-scoped event
// types defined by the gateway v1 contract (`docs/api/gateway-v1.md`, "SSE
// contracts"). These are the *public* Berry events; the OpenFang adapter
// projects raw upstream stream frames into these envelopes before they reach a
// client, so nothing provider-shaped is ever relayed here.
//
// Only run-scoped events are modelled: the run-streaming endpoint (BERR-26)
// follows one run. Board-level events (`issue.updated`, `comment.created`) ride
// the same envelope but belong to the separate `/api/v1/events` stream and are
// added when that endpoint lands.

/** Cumulative, normalized token/cost usage for a run. Never a delta. */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number | null;
  currency: string | null;
}

/** Present only on a failed run. Redacted — no provider body or credentials. */
export interface RunFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * A run snapshot embedded in lifecycle events. This mirrors the `Run` resource
 * in the gateway contract; the canonical Zod DTO is owned by the DTO layer
 * (BERR-22) and this structural type is reconciled with it when that lands.
 */
export interface RunSnapshot {
  id: string;
  issueId: string;
  agentId: string;
  status: RunStatus;
  sequence: number;
  summary: string | null;
  usage: RunUsage;
  failure: RunFailure | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Payload shape keyed by run event type — the `data.payload` of each frame. */
export interface RunEventPayloads {
  "run.created": { run: RunSnapshot };
  "run.started": { startedAt: string };
  "run.output.delta": { channel: "progress" | "final"; text: string };
  "run.tool.started": {
    toolCallId: string;
    name: string;
    inputSummary: string | null;
  };
  "run.tool.completed": {
    toolCallId: string;
    status: "succeeded" | "failed";
    outputSummary: string | null;
  };
  "run.usage.updated": { usage: RunUsage };
  "run.completed": { run: RunSnapshot };
  "run.failed": { run: RunSnapshot };
  "run.cancelled": { run: RunSnapshot };
}

export type RunEventType = keyof RunEventPayloads;

export const RUN_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.output.delta",
  "run.tool.started",
  "run.tool.completed",
  "run.usage.updated",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly RunEventType[];

/**
 * A single persisted run event. The SSE `id` line equals `id`, the SSE `event`
 * line equals `type`, and `data` is this whole object serialized as one compact
 * JSON line (see `formatEventFrame`).
 */
export type RunEventEnvelope = {
  [K in RunEventType]: {
    id: string;
    type: K;
    occurredAt: string;
    boardId: string;
    issueId: string;
    runId: string;
    sequence: number;
    payload: RunEventPayloads[K];
  };
}[RunEventType];

/** Terminal run events; a run-specific stream closes after emitting one. */
export const TERMINAL_RUN_EVENT_TYPES = ["run.completed", "run.failed", "run.cancelled"] as const;
type TerminalRunEventType = (typeof TERMINAL_RUN_EVENT_TYPES)[number];

export function isTerminalRunEventType(type: RunEventType): type is TerminalRunEventType {
  return (TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(type);
}

// --- SSE framing -----------------------------------------------------------

/** Reconnect backoff advertised once at connection start, per the contract. */
export const SSE_RETRY_MS = 3000;
export const RETRY_DIRECTIVE = `retry: ${SSE_RETRY_MS}\n\n`;

/**
 * Idle keep-alive. An SSE comment line carries no event id or JSON payload, so
 * it never advances a client's cursor. The contract requires one at least every
 * 15s of inactivity; we default the interval comfortably under that.
 */
export const HEARTBEAT_FRAME = ": heartbeat\n\n";
export const DEFAULT_HEARTBEAT_MS = 10_000;

/** Resumable events are retained for at least 24h (contract minimum). */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Compact single-line JSON for the `data:` field. */
export function serializeEvent(event: RunEventEnvelope): string {
  return JSON.stringify(event);
}

/**
 * Render one SSE frame. `id`/`event` mirror the envelope's `id`/`type` exactly,
 * and `JSON.stringify` escapes any embedded newline so `data:` stays one line.
 */
export function formatEventFrame(event: RunEventEnvelope): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${serializeEvent(event)}\n\n`;
}

// Monotonic-ish, unique event id used by producers (dispatch / adapter
// projection). Doubles as the opaque SSE cursor: a client's `Last-Event-ID` is
// one of these strings and the store resolves replay by exact match.
let idCounter = 0;

export function createEventId(now: () => number = Date.now): string {
  idCounter = (idCounter + 1) % 0xffffff;
  const time = now().toString(36).padStart(9, "0");
  const seq = idCounter.toString(36).padStart(5, "0");
  return `evt_${time}${seq}`;
}
