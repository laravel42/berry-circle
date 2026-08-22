import { describe, expect, it } from "bun:test";
import { createApp } from "~/app";
import { InMemoryRunEventStream } from "~/runs/event-store";
import {
  type ParsedFrame,
  RUN_ID,
  openSseStream,
  parseSseFrames,
  runCancelled,
  runCompleted,
  runCreated,
  runFailed,
  runOutputDelta,
} from "./support/run-events";

function setup(seed?: (store: InMemoryRunEventStream) => void, sse?: { heartbeatMs?: number }) {
  const store = new InMemoryRunEventStream();
  seed?.(store);
  const app = createApp({ runEventStore: store, sse });
  return { store, app };
}

function eventNames(frames: ParsedFrame[]): (string | null)[] {
  return frames.filter((f) => f.event !== null).map((f) => f.event);
}

function dataOf(frame: ParsedFrame): Record<string, unknown> {
  if (frame.data === null) throw new Error("frame has no data line");
  return JSON.parse(frame.data) as Record<string, unknown>;
}

const path = `/api/v1/runs/${RUN_ID}/events`;

describe("GET /api/v1/runs/:runId/events — preflight errors", () => {
  it("returns 404 for an unknown run", async () => {
    const { app } = setup();
    const res = await app.request(path);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; requestId: string | null } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.requestId).toBe("string");
  });

  it("returns 400 when both Last-Event-ID and after are supplied", async () => {
    const { app } = setup((s) => s.append(runCreated(0)));
    const res = await app.request(`${path}?after=evt_x`, {
      headers: { "Last-Event-ID": "evt_y" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 400 for a malformed (over-long) cursor", async () => {
    const { app } = setup((s) => s.append(runCreated(0)));
    const res = await app.request(`${path}?after=${"e".repeat(600)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 409 CURSOR_EXPIRED for an unresolvable cursor", async () => {
    const { app } = setup((s) => s.append(runCreated(0)));
    const res = await app.request(path, { headers: { "Last-Event-ID": "evt_pruned" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CURSOR_EXPIRED");
  });
});

describe("GET /api/v1/runs/:runId/events — stream framing", () => {
  it("streams the contract headers, a retry directive, then replayed events", async () => {
    const { app } = setup((s) => {
      s.append(runCreated(0));
      s.append(runOutputDelta(1, "hello\nworld")); // newline must survive as one data line
      s.append(runCompleted(2)); // terminal → the stream closes and text() resolves
    });

    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");

    const frames = parseSseFrames(await res.text());
    expect(frames[0]?.retry).toBe(3000); // advertised before any event
    expect(eventNames(frames)).toEqual(["run.created", "run.output.delta", "run.completed"]);

    // Each event frame carries one compact JSON data line whose embedded newline
    // was escaped, and the SSE id/event lines mirror the payload exactly.
    for (const frame of frames.filter((f) => f.event !== null)) {
      const data = dataOf(frame);
      expect(frame.data?.includes("\n")).toBe(false);
      expect(frame.id).toBe(data.id as string);
      expect(frame.event).toBe(data.type as string);
    }

    const delta = frames.find((f) => f.event === "run.output.delta");
    expect((dataOf(delta as ParsedFrame).payload as { text: string }).text).toBe("hello\nworld");
  });

  // Every terminal event type must end a run-specific stream, not just success.
  const terminals: Array<[string, (seq: number) => ReturnType<typeof runFailed>]> = [
    ["run.failed", runFailed],
    ["run.cancelled", runCancelled],
  ];
  for (const [name, build] of terminals) {
    it(`closes the stream after a terminal ${name} event`, async () => {
      const { app } = setup((s) => {
        s.append(runCreated(0));
        s.append(build(1));
      });
      const res = await app.request(path);
      const frames = parseSseFrames(await res.text());
      expect(eventNames(frames)).toEqual(["run.created", name]);
    });
  }
});

describe("GET /api/v1/runs/:runId/events — resume", () => {
  it("replays only events after a Last-Event-ID cursor", async () => {
    const created = runCreated(0);
    const { app } = setup((s) => {
      s.append(created);
      s.append(runOutputDelta(1, "one"));
      s.append(runCompleted(2));
    });
    const res = await app.request(path, { headers: { "Last-Event-ID": created.id } });
    const frames = parseSseFrames(await res.text());
    expect(eventNames(frames)).toEqual(["run.output.delta", "run.completed"]);
  });

  it("replays only events after an ?after= cursor", async () => {
    const created = runCreated(0);
    const { app } = setup((s) => {
      s.append(created);
      s.append(runOutputDelta(1, "one"));
      s.append(runCompleted(2));
    });
    const res = await app.request(`${path}?after=${created.id}`);
    const frames = parseSseFrames(await res.text());
    expect(eventNames(frames)).toEqual(["run.output.delta", "run.completed"]);
  });
});

describe("GET /api/v1/runs/:runId/events — live follow", () => {
  it("delivers events appended after the client connects", async () => {
    const { store, app } = setup((s) => s.ensureRun(RUN_ID));
    const res = await app.request(path);
    // `open` subscribed synchronously while handling the request, so these
    // appends are captured and delivered when the body is read.
    store.append(runCreated(0));
    store.append(runCompleted(1));
    const frames = parseSseFrames(await res.text());
    expect(eventNames(frames)).toEqual(["run.created", "run.completed"]);
  });

  it("replays the backlog, then follows live until a terminal event closes it", async () => {
    const created = runCreated(0);
    const delta = runOutputDelta(1, "streaming");
    const { store, app } = setup(
      (s) => {
        s.append(created);
        s.append(delta);
      },
      { heartbeatMs: 1000 },
    );
    const controller = new AbortController();
    const res = await app.request(path, { signal: controller.signal });
    const sse = openSseStream(res);

    await sse.waitFor((fs) => fs.filter((f) => f.event !== null).length >= 2, 1000);
    store.append(runCompleted(2)); // live terminal event
    const frames = await sse.waitFor((fs) => fs.some((f) => f.event === "run.completed"), 1000);

    expect(eventNames(frames)).toEqual(["run.created", "run.output.delta", "run.completed"]);
    controller.abort();
    await sse.cancel();
  });
});

describe("GET /api/v1/runs/:runId/events — keep-alive & disconnect", () => {
  it("emits a heartbeat comment while idle", async () => {
    const { app } = setup((s) => s.ensureRun(RUN_ID), { heartbeatMs: 30 });
    const controller = new AbortController();
    const res = await app.request(path, { signal: controller.signal });
    const sse = openSseStream(res);

    const frames = await sse.waitFor(
      (fs) => fs.some((f) => f.comments.includes("heartbeat")),
      2000,
    );
    expect(frames.some((f) => f.retry === 3000)).toBe(true);
    expect(frames.some((f) => f.comments.includes("heartbeat"))).toBe(true);

    controller.abort();
    await sse.cancel();
  });

  it("tears down gracefully when the client disconnects mid-stream", async () => {
    const { app } = setup((s) => s.ensureRun(RUN_ID), { heartbeatMs: 1000 });
    const controller = new AbortController();
    const res = await app.request(path, { signal: controller.signal });
    const sse = openSseStream(res);
    await sse.waitFor((fs) => fs.some((f) => f.retry === 3000), 1000);

    controller.abort();
    await sse.cancel(); // resolves without hanging or throwing
    expect(true).toBe(true);
  });
});
