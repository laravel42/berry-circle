import { describe, expect, test } from "bun:test";
import { assertTransition, canTransition } from "~/api/workflow";
import type { ApiError } from "~/http/errors";

describe("issue status workflow", () => {
  test("allows the documented forward path to done via review", () => {
    expect(canTransition("backlog", "todo")).toBe(true);
    expect(canTransition("todo", "inProgress")).toBe(true);
    expect(canTransition("inProgress", "inReview")).toBe(true);
    expect(canTransition("inReview", "done")).toBe(true);
  });

  test("treats a same-status write as a no-op, not a transition", () => {
    expect(canTransition("inProgress", "inProgress")).toBe(true);
  });

  test("forbids jumping straight to done (review gate)", () => {
    expect(canTransition("backlog", "done")).toBe(false);
    expect(canTransition("todo", "done")).toBe(false);
    expect(canTransition("inProgress", "done")).toBe(false);
  });

  test("allows cancelling from any active state and reopening", () => {
    expect(canTransition("todo", "cancelled")).toBe(true);
    expect(canTransition("inReview", "cancelled")).toBe(true);
    expect(canTransition("cancelled", "todo")).toBe(true);
    expect(canTransition("done", "inReview")).toBe(true);
  });

  test("assertTransition throws INVALID_STATE_TRANSITION with from/to details", () => {
    let error: ApiError | undefined;
    try {
      assertTransition("backlog", "done");
    } catch (err) {
      error = err as ApiError;
    }
    expect(error?.code).toBe("INVALID_STATE_TRANSITION");
    expect(error?.status).toBe(409);
    expect(error?.details).toEqual({ from: "backlog", to: "done" });
  });

  test("assertTransition is silent for a permitted change", () => {
    expect(() => assertTransition("inReview", "done")).not.toThrow();
  });
});
