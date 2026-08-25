/**
 * SSE consumption for the OpenFang agent stream (BERR-20).
 *
 * `POST /api/agents/{agentId}/message/stream` returns `text/event-stream`. Each
 * frame carries an explicit `event` name and a JSON `data` payload; the pinned
 * stream emits no SSE `id` or retry hints, and non-projectable upstream events
 * arrive as SSE comments (which we drop). This is the compatibility oracle for
 * the Go adapter (`server/internal/openfang/sse.go`), which is the product
 * implementation; both follow the consumption contract:
 *   - projects the five known events into a typed union;
 *   - preserves unknown *named* events as `raw` so nothing is silently lost;
 *   - drops comment/keep-alive frames;
 *   - treats `done` as the end of one model turn, not of the run: the pinned
 *     upstream emits one per turn on the same connection and starts the next
 *     turn whenever the agent called a tool, so the body is read to its end
 *     and nothing is cancelled at `done`;
 *   - treats malformed JSON, a read error, or EOF before any `done` as an
 *     interruption (`STREAM_INTERRUPTED`) so the caller can persist partial
 *     events and mark the Berry run `interrupted` — never re-dispatching, since
 *     the route has no resume/replay contract. EOF after at least one `done`
 *     is the clean end of the run.
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
 * Consume an OpenFang SSE body, yielding typed events in arrival order until
 * the body ends. Returns normally when the body ends after at least one `done`
 * (each `done` closes a turn; EOF follows the last one); throws `OpenFangError`
 * (`STREAM_INTERRUPTED`) if the stream ends before any `done`, errors, or
 * contains malformed JSON.
 */
export async function* parseOpenFangStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenFangStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Counts `done` events. It decides what the end of the body means: after at
  // least one turn it is the run finishing, before any it is the connection
  // dropping mid-work.
  let turns = 0;

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
            if (event.type === "done") turns++;
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
        // `done` closes a turn; the next turn arrives on this same connection,
        // so keep reading. Hanging up here left the agent working into a socket
        // nobody read, and its final report never reached Berry.
        if (event.type === "done") turns++;
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (turns === 0) {
    throw new OpenFangError("STREAM_INTERRUPTED", "OpenFang stream ended before any done event");
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
