import { describe, expect, it } from "bun:test";
import { InMemoryRunEventStream } from "~/runs/event-store";
import { isTerminalRunEventType } from "~/runs/events";
import { RUN_ID, runCompleted, runCreated, runOutputDelta } from "./support/run-events";

describe("InMemoryRunEventStream — existence", () => {
  it("reports a run only after it is created or has an event", () => {
    const store = new InMemoryRunEventStream();
    expect(store.hasRun(RUN_ID)).toBe(false);

    store.ensureRun(RUN_ID);
    expect(store.hasRun(RUN_ID)).toBe(true);
  });

  it("auto-registers a run on its first appended event", () => {
    const store = new InMemoryRunEventStream();
    store.append(runCreated(0));
    expect(store.hasRun(RUN_ID)).toBe(true);
  });
});

describe("InMemoryRunEventStream — replay", () => {
  it("replays every retained event when no cursor is supplied", () => {
    const store = new InMemoryRunEventStream();
    store.append(runCreated(0));
    store.append(runOutputDelta(1, "hello"));

    const opened = store.open(RUN_ID);
    if (!opened.ok) throw new Error("expected open to succeed");
    return drain(opened.subscription, 2).then((events) => {
      expect(events.map((e) => e.sequence)).toEqual([0, 1]);
    });
  });

  it("replays only events after the cursor", () => {
    const store = new InMemoryRunEventStream();
    const created = runCreated(0);
    store.append(created);
    store.append(runOutputDelta(1, "one"));
    store.append(runOutputDelta(2, "two"));

    const opened = store.open(RUN_ID, { afterCursor: created.id });
    if (!opened.ok) throw new Error("expected open to succeed");
    return drain(opened.subscription, 2).then((events) => {
      expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    });
  });

  it("rejects an unknown cursor as expired", () => {
    const store = new InMemoryRunEventStream();
    store.append(runCreated(0));

    const opened = store.open(RUN_ID, { afterCursor: "evt_does_not_exist" });
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("unreachable");
    expect(opened.reason).toBe("cursor_expired");
  });
});

describe("InMemoryRunEventStream — retention", () => {
  it("prunes events past the retention window and expires cursors into them", () => {
    let now = 1_000_000;
    const store = new InMemoryRunEventStream({ retentionMs: 1000, now: () => now });

    const created = runCreated(0);
    store.append(created); // stored at 1_000_000
    now += 2000; // advance beyond the 1s window
    store.append(runOutputDelta(1, "later")); // append prunes the created event

    const withoutCursor = store.open(RUN_ID);
    if (!withoutCursor.ok) throw new Error("expected open to succeed");
    return drain(withoutCursor.subscription, 1).then((events) => {
      expect(events.map((e) => e.sequence)).toEqual([1]);

      const withCursor = store.open(RUN_ID, { afterCursor: created.id });
      expect(withCursor.ok).toBe(false);
    });
  });

  it("evicts a terminal run after all retained events expire", () => {
    let now = 1_000_000;
    const store = new InMemoryRunEventStream({ retentionMs: 1000, now: () => now });
    store.append(runCompleted(0));
    expect(store.hasRun(RUN_ID)).toBe(true);

    now += 2000;
    expect(store.hasRun(RUN_ID)).toBe(false);
    expect(store.open(RUN_ID)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("InMemoryRunEventStream — live follow", () => {
  it("does not materialize an unknown run when opened", () => {
    const store = new InMemoryRunEventStream();
    expect(store.open(RUN_ID)).toEqual({ ok: false, reason: "not_found" });
    expect(store.hasRun(RUN_ID)).toBe(false);
  });

  it("closes a terminal subscription after its buffered events are drained", async () => {
    const store = new InMemoryRunEventStream();
    store.append(runCreated(0));
    const completed = runCompleted(1);
    store.append(completed);
    const opened = store.open(RUN_ID, { afterCursor: completed.id });
    if (!opened.ok) throw new Error("expected open to succeed");
    expect((await opened.subscription.next(1000)).kind).toBe("closed");
  });

  it("disconnects a subscriber whose live buffer reaches its bound", async () => {
    const store = new InMemoryRunEventStream({ maxBufferedEvents: 2 });
    store.ensureRun(RUN_ID);
    const opened = store.open(RUN_ID);
    if (!opened.ok) throw new Error("expected open to succeed");

    store.append(runOutputDelta(0, "one"));
    store.append(runOutputDelta(1, "two"));
    store.append(runOutputDelta(2, "overflow"));
    expect((await opened.subscription.next(10)).kind).toBe("closed");
  });
  it("delivers events appended after open, in order after any backlog", async () => {
    const store = new InMemoryRunEventStream();
    const created = runCreated(0);
    store.append(created);

    const opened = store.open(RUN_ID);
    if (!opened.ok) throw new Error("expected open to succeed");
    const sub = opened.subscription;

    // Backlog first.
    expect((await sub.next(50)).kind).toBe("event");

    // Then a live append resolves a pending pull.
    const pending = sub.next(1000);
    store.append(runOutputDelta(1, "live"));
    const result = await pending;
    expect(result.kind).toBe("event");
    if (result.kind === "event") expect(result.event.sequence).toBe(1);

    sub.close();
  });

  it("returns an idle tick when no event arrives within the timeout", async () => {
    const store = new InMemoryRunEventStream();
    store.ensureRun(RUN_ID);
    const opened = store.open(RUN_ID);
    if (!opened.ok) throw new Error("expected open to succeed");

    const result = await opened.subscription.next(10);
    expect(result.kind).toBe("idle");
    opened.subscription.close();
  });

  it("stops delivering to a closed subscription", async () => {
    const store = new InMemoryRunEventStream();
    store.ensureRun(RUN_ID);
    const opened = store.open(RUN_ID);
    if (!opened.ok) throw new Error("expected open to succeed");

    opened.subscription.close();
    expect((await opened.subscription.next(10)).kind).toBe("closed");

    // A later append must not throw or resurrect the subscription.
    store.append(runOutputDelta(1, "ignored"));
    expect((await opened.subscription.next(10)).kind).toBe("closed");
  });

  it("fans one event out to multiple concurrent subscribers", async () => {
    const store = new InMemoryRunEventStream();
    store.ensureRun(RUN_ID);
    const a = store.open(RUN_ID);
    const b = store.open(RUN_ID);
    if (!a.ok || !b.ok) throw new Error("expected open to succeed");

    const pendingA = a.subscription.next(1000);
    const pendingB = b.subscription.next(1000);
    store.append(runCompleted(0));

    const [ra, rb] = await Promise.all([pendingA, pendingB]);
    expect(ra.kind).toBe("event");
    expect(rb.kind).toBe("event");
    a.subscription.close();
    b.subscription.close();
  });
});

describe("isTerminalRunEventType", () => {
  it("classifies terminal vs non-terminal event types", () => {
    expect(isTerminalRunEventType("run.completed")).toBe(true);
    expect(isTerminalRunEventType("run.failed")).toBe(true);
    expect(isTerminalRunEventType("run.cancelled")).toBe(true);
    expect(isTerminalRunEventType("run.output.delta")).toBe(false);
    expect(isTerminalRunEventType("run.created")).toBe(false);
  });
});

// Pull `count` buffered events from a subscription (used for replay assertions).
async function drain(
  sub: { next(ms: number): Promise<{ kind: string; event?: { sequence: number } }> },
  count: number,
): Promise<Array<{ sequence: number }>> {
  const out: Array<{ sequence: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const result = await sub.next(50);
    if (result.kind === "event" && result.event) out.push(result.event);
  }
  return out;
}
