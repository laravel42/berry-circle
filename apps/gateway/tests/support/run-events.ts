// Shared fixtures + an SSE reader for the run-streaming tests. Kept out of the
// `*.test.ts` glob so bun:test does not treat it as a suite.

import { type RunEventEnvelope, type RunSnapshot, createEventId } from "~/runs/events";

export const BOARD_ID = "bb99372f-88c4-44f0-914f-a343bf30e6fb";
export const ISSUE_ID = "8138a662-f20f-41aa-bd5a-cf46e35ba952";
export const RUN_ID = "2020836b-a055-4980-b165-50664cf402c3";
export const AGENT_ID = "f8957903-6534-4ca3-a218-d95e537a5076";
const OCCURRED_AT = "2026-08-22T06:42:01.000Z";

interface EnvelopeOverrides {
  id?: string;
  occurredAt?: string;
  runId?: string;
  issueId?: string;
  boardId?: string;
}

function base(overrides: EnvelopeOverrides) {
  return {
    id: overrides.id ?? createEventId(),
    occurredAt: overrides.occurredAt ?? OCCURRED_AT,
    boardId: overrides.boardId ?? BOARD_ID,
    issueId: overrides.issueId ?? ISSUE_ID,
    runId: overrides.runId ?? RUN_ID,
  };
}

export function makeRunSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUN_ID,
    issueId: ISSUE_ID,
    agentId: AGENT_ID,
    status: "running",
    sequence: 0,
    summary: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: null, currency: null },
    failure: null,
    createdAt: "2026-08-22T06:42:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

// An object literal that matches exactly one member of the discriminated union
// is assignable to it with no cast, so these concrete builders stay type-safe.

export function runCreated(sequence: number, o: EnvelopeOverrides = {}): RunEventEnvelope {
  return {
    ...base(o),
    type: "run.created",
    sequence,
    payload: { run: makeRunSnapshot({ status: "queued", sequence }) },
  };
}

export function runOutputDelta(
  sequence: number,
  text: string,
  o: EnvelopeOverrides = {},
): RunEventEnvelope {
  return { ...base(o), type: "run.output.delta", sequence, payload: { channel: "progress", text } };
}

export function runCompleted(sequence: number, o: EnvelopeOverrides = {}): RunEventEnvelope {
  return {
    ...base(o),
    type: "run.completed",
    sequence,
    payload: {
      run: makeRunSnapshot({
        status: "succeeded",
        sequence,
        summary: "done",
        completedAt: "2026-08-22T06:48:22.000Z",
        startedAt: OCCURRED_AT,
      }),
    },
  };
}

export function runFailed(sequence: number, o: EnvelopeOverrides = {}): RunEventEnvelope {
  return {
    ...base(o),
    type: "run.failed",
    sequence,
    payload: {
      run: makeRunSnapshot({
        status: "failed",
        sequence,
        failure: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: "upstream unavailable",
          retryable: true,
        },
        completedAt: "2026-08-22T06:48:22.000Z",
      }),
    },
  };
}

export function runCancelled(sequence: number, o: EnvelopeOverrides = {}): RunEventEnvelope {
  return {
    ...base(o),
    type: "run.cancelled",
    sequence,
    payload: {
      run: makeRunSnapshot({
        status: "cancelled",
        sequence,
        completedAt: "2026-08-22T06:48:22.000Z",
      }),
    },
  };
}

// --- SSE parsing / reading -------------------------------------------------

export interface ParsedFrame {
  id: string | null;
  event: string | null;
  data: string | null;
  retry: number | null;
  comments: string[];
  raw: string;
}

/** Parse an accumulated SSE byte stream into complete frames (blocks). */
export function parseSseFrames(raw: string): ParsedFrame[] {
  return raw
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const frame: ParsedFrame = {
        id: null,
        event: null,
        data: null,
        retry: null,
        comments: [],
        raw: block,
      };
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) {
          frame.comments.push(line.slice(1).trim());
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "id") frame.id = value;
        else if (field === "event") frame.event = value;
        else if (field === "data")
          frame.data = frame.data === null ? value : `${frame.data}\n${value}`;
        else if (field === "retry") frame.retry = Number(value);
      }
      return frame;
    });
}

export interface SseStream {
  /** Poll frames until `predicate` holds or the timeout elapses (throws). */
  waitFor(
    predicate: (frames: ParsedFrame[]) => boolean,
    timeoutMs?: number,
  ): Promise<ParsedFrame[]>;
  readonly raw: string;
  cancel(): Promise<void>;
}

/**
 * Incrementally read an open SSE response without blocking forever on idle: one
 * in-flight `read()` is raced against a timeout, and any resolved-but-unconsumed
 * read is picked up on the next poll so no bytes are dropped.
 */
export function openSseStream(res: Response): SseStream {
  const stream = res.body;
  if (!stream) throw new Error("response body is not a readable stream");
  const reader = stream.getReader();
  type ReadResult = Awaited<ReturnType<typeof reader.read>>;
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  let inflight: Promise<ReadResult> | null = null;
  const timeoutMarker = Symbol("timeout");

  async function pump(timeoutMs: number): Promise<void> {
    if (done) return;
    if (!inflight) inflight = reader.read();
    const result = await Promise.race([
      inflight,
      new Promise<typeof timeoutMarker>((resolve) =>
        setTimeout(() => resolve(timeoutMarker), timeoutMs),
      ),
    ]);
    if (result === timeoutMarker) return;
    inflight = null;
    if (result.done) {
      done = true;
      return;
    }
    if (result.value) buffer += decoder.decode(result.value, { stream: true });
  }

  return {
    async waitFor(predicate, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frames = parseSseFrames(buffer);
        if (predicate(frames)) return frames;
        if (done) return frames;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`SSE waitFor timed out; buffer so far:\n${buffer}`);
        await pump(Math.min(remaining, 40));
      }
    },
    get raw() {
      return buffer;
    },
    async cancel() {
      await reader.cancel().catch(() => {});
    },
  };
}
