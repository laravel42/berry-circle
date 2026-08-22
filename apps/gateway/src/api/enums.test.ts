import { describe, expect, test } from "bun:test";
import { ISSUE_STATUSES, statusToApi, statusToDb } from "~/api/enums";

describe("issue status enum mapping", () => {
  test("maps multi-word API values to snake_case storage values", () => {
    expect(statusToDb("inProgress")).toBe("in_progress");
    expect(statusToDb("inReview")).toBe("in_review");
    expect(statusToApi("in_progress")).toBe("inProgress");
    expect(statusToApi("in_review")).toBe("inReview");
  });

  test("round-trips every API status through storage and back", () => {
    for (const status of ISSUE_STATUSES) {
      expect(statusToApi(statusToDb(status))).toBe(status);
    }
  });
});
