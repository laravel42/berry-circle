/**
 * SSE consumption for the OpenFang agent stream (BERR-20).
 *
 * `POST /api/agents/{agentId}/message/stream` returns `text/event-stream`. Each
 * frame carries an explicit `event` name and a JSON `data` payload; the pinned
 * stream emits no SSE `id` or retry hints, and non-projectable upstream events
 * arrive as SSE comments (which we drop). Per the consumption contract, the
 * consumer:
 *   - projects the five known events into a typed union;
 *   - preserves unknown *named* events as `raw` so nothing is silently lost;
 *   - drops comment/keep-alive frames;
 *   - treats malformed JSON, a read error, or EOF before a `done` event as an
 *     interruption (`STREAM_INTERRUPTED`) so the caller can persist partial
 *     events and mark the Berry run `interrupted` — never re-dispatching, since
 *     the route has no resume/replay contract.
 */

import { z } from "zod";
import { OpenFangError } from "~/openfang/errors";

export type OpenFangStreamEvent =
  | { type: "chunk"; content: string }
  | { type: "tool_use"; tool: string }
  | { type: "tool_result"; tool: string; input: Record<string, unknown> }
  | { type: "phase"; phase: string; detail: string | null }
  | { type: "done"; usage: { input_tokens: number; output_tokens: number } }
  | { type: "raw"; event: string; data: unknown };

const chunkDataSchema = z.object({ content: z.string() });
const toolUseDataSchema = z.object({ tool: z.string() });
const toolResultDataSchema = z.object({
  tool: z.string(),
  input: z.record(z.unknown()).default({}),
});
const phaseDataSchema = z.object({
  phase: z.string(),
  detail: z.string().nullable().default(null),
});
const doneDataSchema = z.object({
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

interface RawFrame {
  event: string;
  data: string;
}

/**
 * Consume an OpenFang SSE body, yielding typed events in arrival order. Returns
 * normally once a `done` event has been seen; throws `OpenFangError`
 * (`STREAM_INTERRUPTED`) if the stream ends, errors, or contains malformed JSON
 * before `done`.
 */
export async function* parseOpenFangStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenFangStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (cause) {
        throw new OpenFangError("STREAM_INTERRUPTED", "OpenFang stream read failed", { cause });
      }

      if (result.done) {
        buffer += decoder.decode();
        const trailing = buffer.trim();
        if (trailing.length > 0) {
          const event = projectFrame(parseFrame(buffer));
          if (event) {
            if (event.type === "done") sawDone = true;
            yield event;
          }
        }
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const block of parts) {
        const event = projectFrame(parseFrame(block));
        if (!event) continue;
        if (event.type === "done") {
          yield event;
          // `done` finalizes the run; release the connection and stop.
          await reader.cancel();
          return;
        }
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawDone) {
    throw new OpenFangError("STREAM_INTERRUPTED", "OpenFang stream ended before a done event");
  }
}

/**
 * Extract the `event` name and joined `data` from one SSE block. Per the SSE
 * spec, multiple `data:` lines are concatenated with `\n`; `:` comment lines and
 * other fields are ignored. Returns `undefined` for comment/keep-alive frames.
 */
export function parseFrame(block: string): RawFrame | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    // A leading space after the colon is part of the SSE framing, not the value.
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (event === undefined || dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

/** Parse a raw frame's JSON and project it into a typed event. */
function projectFrame(frame: RawFrame | undefined): OpenFangStreamEvent | undefined {
  if (!frame) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch (cause) {
    throw new OpenFangError(
      "STREAM_INTERRUPTED",
      `OpenFang stream ${frame.event} event contained malformed JSON`,
      { cause },
    );
  }

  switch (frame.event) {
    case "chunk": {
      const parsed = chunkDataSchema.safeParse(data);
      return parsed.success
        ? { type: "chunk", content: parsed.data.content }
        : { type: "raw", event: frame.event, data };
    }
    case "tool_use": {
      const parsed = toolUseDataSchema.safeParse(data);
      return parsed.success
        ? { type: "tool_use", tool: parsed.data.tool }
        : { type: "raw", event: frame.event, data };
    }
    case "tool_result": {
      const parsed = toolResultDataSchema.safeParse(data);
      return parsed.success
        ? { type: "tool_result", tool: parsed.data.tool, input: parsed.data.input }
        : { type: "raw", event: frame.event, data };
    }
    case "phase": {
      const parsed = phaseDataSchema.safeParse(data);
      return parsed.success
        ? { type: "phase", phase: parsed.data.phase, detail: parsed.data.detail }
        : { type: "raw", event: frame.event, data };
    }
    case "done": {
      const parsed = doneDataSchema.safeParse(data);
      return parsed.success
        ? { type: "done", usage: parsed.data.usage }
        : { type: "raw", event: frame.event, data };
    }
    default:
      return { type: "raw", event: frame.event, data };
  }
}
