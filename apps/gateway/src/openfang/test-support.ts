/**
 * Shared test helpers for the OpenFang adapter (BERR-20). Not a test file
 * itself (no `.test.` in the name) so `bun test` never runs it directly; it is
 * still typechecked and linted as part of `src`.
 */

import type { FetchLike } from "~/openfang/http";

const encoder = new TextEncoder();

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

export type FetchResponder = (ctx: {
  url: string;
  init: RequestInit;
  index: number;
}) => Response | Promise<Response>;

/** A `fetch` stand-in that records every call and delegates to a responder. */
export function recordingFetch(responder: FetchResponder): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (input, init = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const index = calls.length;
    calls.push({ url, init });
    // Always resolve to a promise, mirroring real fetch — a responder that
    // throws (a simulated transport failure) becomes a rejected promise.
    try {
      return Promise.resolve(responder({ url, init, index }));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return { fetch: fetchImpl, calls };
}

/**
 * Build a responder that returns queued items in order. An `Error` item is
 * thrown (to simulate a transport failure). Calling past the queue throws, so
 * over-calling surfaces instead of silently reusing the last response.
 */
export function queue(...items: Array<Response | Error>): FetchResponder {
  return ({ index }) => {
    if (index >= items.length) throw new Error(`unexpected fetch call #${index + 1}`);
    const item = items[index];
    if (item instanceof Error) throw item;
    return item;
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function textResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, { status, headers });
}

/** A `ReadableStream` that emits the given string chunks, UTF-8 encoded. */
export function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A `200` SSE response whose body streams the given chunks. */
export function sseResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  return new Response(streamFromChunks(chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

/**
 * A `200` SSE response whose body is left OPEN (never closed) and records
 * whether its underlying source was cancelled. Simulates an upstream that keeps
 * the `text/event-stream` socket open, so a leak on abnormal exit is observable
 * as `cancelled() === false`.
 */
export function sseResponseWithCancelSpy(chunks: string[]): {
  response: Response;
  cancelled: () => boolean;
} {
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      // Deliberately not closed — the socket stays open until the consumer
      // cancels it, which is exactly what the leak-on-abnormal-exit test checks.
    },
    cancel() {
      wasCancelled = true;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return { response, cancelled: () => wasCancelled };
}

/** A sleep stub that records requested delays instead of waiting. */
export function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}
