import { describe, expect, it } from "bun:test";
import { OpenFangError } from "~/openfang/errors";
import { type OpenFangStreamEvent, parseFrame, parseOpenFangStream } from "~/openfang/sse";
import { streamFromChunks } from "~/openfang/test-support";

async function collect(chunks: string[]): Promise<OpenFangStreamEvent[]> {
  const events: OpenFangStreamEvent[] = [];
  for await (const event of parseOpenFangStream(streamFromChunks(chunks))) {
    events.push(event);
  }
  return events;
}

describe("parseFrame", () => {
  it("joins multiple data lines and strips the leading space", () => {
    const frame = parseFrame("event: chunk\ndata: line1\ndata: line2");
    expect(frame).toEqual({ event: "chunk", data: "line1\nline2" });
  });

  it("ignores comment lines and returns undefined for a keep-alive frame", () => {
    expect(parseFrame(": keep-alive")).toBeUndefined();
    expect(parseFrame("data: only-data-no-event")).toBeUndefined();
  });
});

describe("parseOpenFangStream", () => {
  it("projects the five known events into the typed union", async () => {
    const events = await collect([
      'event: phase\ndata: {"phase":"start","detail":null}\n\n',
      'event: chunk\ndata: {"content":"Hello ","done":false}\n\n',
      'event: tool_use\ndata: {"tool":"file_read"}\n\n',
      'event: tool_result\ndata: {"tool":"file_read","input":{"path":"a.ts"}}\n\n',
      'event: chunk\ndata: {"content":"world"}\n\n',
      'event: done\ndata: {"done":true,"usage":{"input_tokens":12,"output_tokens":3}}\n\n',
    ]);

    expect(events).toEqual([
      { type: "phase", phase: "start", detail: null },
      { type: "chunk", content: "Hello " },
      { type: "tool_use", tool: "file_read" },
      { type: "tool_result", tool: "file_read", input: { path: "a.ts" } },
      { type: "chunk", content: "world" },
      { type: "done", usage: { input_tokens: 12, output_tokens: 3 } },
    ]);
  });

  it("reassembles events split across chunk boundaries", async () => {
    const events = await collect([
      "event: chu",
      'nk\ndata: {"con',
      'tent":"hi"}\n\nevent: done\ndata: {"usage":{"input_tokens":1,"output_tokens":1}}\n\n',
    ]);
    expect(events).toEqual([
      { type: "chunk", content: "hi" },
      { type: "done", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
  });

  it("drops comment/keep-alive frames between events", async () => {
    const events = await collect([
      ": keep-alive\n\n",
      'event: chunk\ndata: {"content":"x"}\n\n',
      ": another comment\n\n",
      'event: done\ndata: {"usage":{"input_tokens":0,"output_tokens":0}}\n\n',
    ]);
    expect(events.map((e) => e.type)).toEqual(["chunk", "done"]);
  });

  it("preserves unknown named events as raw", async () => {
    const events = await collect([
      'event: heartbeat\ndata: {"beat":1}\n\n',
      'event: done\ndata: {"usage":{"input_tokens":0,"output_tokens":0}}\n\n',
    ]);
    expect(events[0]).toEqual({ type: "raw", event: "heartbeat", data: { beat: 1 } });
  });

  it("keeps reading after done and returns when the body ends", async () => {
    // The pinned upstream emits one `done` per model turn on the same
    // connection; hanging up at the first one lost the agent's final report.
    const events = await collect([
      'event: chunk\ndata: {"content":"I will look into it"}\n\n',
      'event: done\ndata: {"usage":{"input_tokens":10,"output_tokens":1}}\n\n',
      'event: phase\ndata: {"phase":"tool_loop","detail":null}\n\n',
      'event: tool_use\ndata: {"tool":"file_read"}\n\n',
      'event: tool_result\ndata: {"tool":"file_read","input":{}}\n\n',
      'event: done\ndata: {"usage":{"input_tokens":20,"output_tokens":2}}\n\n',
      'event: chunk\ndata: {"content":"Final report"}\n\n',
      'event: done\ndata: {"usage":{"input_tokens":30,"output_tokens":3}}\n\n',
      'event: phase\ndata: {"phase":"done","detail":null}\n\n',
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "chunk",
      "done",
      "phase",
      "tool_use",
      "tool_result",
      "done",
      "chunk",
      "done",
      "phase",
    ]);
    expect(events[6]).toEqual({ type: "chunk", content: "Final report" });
    expect(events[7]).toEqual({ type: "done", usage: { input_tokens: 30, output_tokens: 3 } });
  });

  it("delivers text that follows a done instead of dropping it", async () => {
    // A trailing turn that never got its own `done` is still the last thing
    // the agent said; the consumer decides what to make of it.
    const events = await collect([
      'event: done\ndata: {"usage":{"input_tokens":1,"output_tokens":1}}\n\n',
      'event: chunk\ndata: {"content":"late"}\n\n',
    ]);
    expect(events).toEqual([
      { type: "done", usage: { input_tokens: 1, output_tokens: 1 } },
      { type: "chunk", content: "late" },
    ]);
  });

  it("marks the stream interrupted when it ends before any done event", async () => {
    const stream = parseOpenFangStream(
      streamFromChunks(['event: chunk\ndata: {"content":"partial"}\n\n']),
    );
    const seen: OpenFangStreamEvent[] = [];
    let error: unknown;
    try {
      for await (const event of stream) seen.push(event);
    } catch (caught) {
      error = caught;
    }
    expect(seen).toEqual([{ type: "chunk", content: "partial" }]);
    expect(error).toBeInstanceOf(OpenFangError);
    expect((error as OpenFangError).code).toBe("STREAM_INTERRUPTED");
  });

  it("marks the stream interrupted on malformed JSON, after prior events", async () => {
    const stream = parseOpenFangStream(
      streamFromChunks([
        'event: chunk\ndata: {"content":"ok"}\n\n',
        "event: chunk\ndata: {not json}\n\n",
      ]),
    );
    const seen: OpenFangStreamEvent[] = [];
    let error: unknown;
    try {
      for await (const event of stream) seen.push(event);
    } catch (caught) {
      error = caught;
    }
    expect(seen).toEqual([{ type: "chunk", content: "ok" }]);
    expect((error as OpenFangError).code).toBe("STREAM_INTERRUPTED");
  });
});
