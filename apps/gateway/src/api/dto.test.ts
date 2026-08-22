import { describe, expect, test } from "bun:test";
import type { ActorRef } from "~/api/actors";
import {
  createCommentSchema,
  createIssueSchema,
  serializeComment,
  serializeIssue,
  updateIssueSchema,
} from "~/api/dto";

const AT = new Date("2026-08-22T06:30:00.000Z");

const issueRow = {
  id: "8138a662-f20f-41aa-bd5a-cf46e35ba952",
  boardId: "bb99372f-88c4-44f0-914f-a343bf30e6fb",
  number: 42,
  title: "Wire the board to the gateway",
  description: "Replace fixtures.",
  status: "in_progress" as const,
  priority: "high" as const,
  sortOrder: 1200,
  dueDate: null,
  assigneeType: "agent" as const,
  assigneeId: "f8957903-6534-4ca3-a218-d95e537a5076",
  openfangRunId: "internal-run-id",
  createdBy: "782a0204-2868-437e-9be8-5b17ce7f13f7",
  createdAt: AT,
  updatedAt: AT,
};

const agentRef: ActorRef = {
  type: "agent",
  id: "f8957903-6534-4ca3-a218-d95e537a5076",
  name: "Builder",
  avatarUrl: null,
};

describe("serializeIssue", () => {
  const issue = serializeIssue(issueRow, "berry", agentRef, null);

  test("builds the uppercase identifier from the board slug and number", () => {
    expect(issue.identifier).toBe("BERRY-42");
  });

  test("maps the status to its camelCase API value", () => {
    expect(issue.status).toBe("inProgress");
  });

  test("never leaks the internal openfang run id; activeRunId stays null", () => {
    expect(issue.activeRunId).toBeNull();
    expect(JSON.stringify(issue)).not.toContain("internal-run-id");
  });

  test("emits ISO timestamps and a null dueDate", () => {
    expect(issue.createdAt).toBe("2026-08-22T06:30:00.000Z");
    expect(issue.dueDate).toBeNull();
  });

  test("passes actor refs through and allows a null creator", () => {
    expect(issue.assignee).toEqual(agentRef);
    expect(issue.createdBy).toBeNull();
  });
});

describe("serializeComment", () => {
  test("shapes the comment with its author ref and null parentId", () => {
    const comment = serializeComment(
      {
        id: "3299af16-2bc9-4d2d-b8b7-b76d284ec40d",
        issueId: issueRow.id,
        authorType: "agent",
        authorId: agentRef.id,
        body: "Ready for review.",
        parentId: null,
        createdAt: AT,
        updatedAt: AT,
      },
      agentRef,
    );
    expect(comment).toEqual({
      id: "3299af16-2bc9-4d2d-b8b7-b76d284ec40d",
      issueId: issueRow.id,
      body: "Ready for review.",
      author: agentRef,
      parentId: null,
      createdAt: "2026-08-22T06:30:00.000Z",
      updatedAt: "2026-08-22T06:30:00.000Z",
    });
  });
});

describe("request schemas", () => {
  test("createIssueSchema requires a non-empty, bounded title", () => {
    expect(createIssueSchema.safeParse({ boardId: issueRow.boardId }).success).toBe(false);
    expect(createIssueSchema.safeParse({ boardId: issueRow.boardId, title: "" }).success).toBe(
      false,
    );
    expect(
      createIssueSchema.safeParse({ boardId: issueRow.boardId, title: "x".repeat(501) }).success,
    ).toBe(false);
  });

  test("createIssueSchema accepts a full valid payload", () => {
    const parsed = createIssueSchema.safeParse({
      boardId: issueRow.boardId,
      title: "New issue",
      status: "inProgress",
      priority: "urgent",
      assignee: { type: "user", id: issueRow.createdBy },
      dueDate: "2026-08-22T06:30:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  test("createIssueSchema rejects an unknown status", () => {
    const parsed = createIssueSchema.safeParse({
      boardId: issueRow.boardId,
      title: "x",
      status: "in_progress",
    });
    expect(parsed.success).toBe(false);
  });

  test("updateIssueSchema rejects an empty patch", () => {
    expect(updateIssueSchema.safeParse({}).success).toBe(false);
    expect(updateIssueSchema.safeParse({ title: "changed" }).success).toBe(true);
  });

  test("updateIssueSchema accepts a null assignee (unassign) and null dueDate", () => {
    expect(updateIssueSchema.safeParse({ assignee: null, dueDate: null }).success).toBe(true);
  });

  test("createCommentSchema requires a non-empty body", () => {
    expect(createCommentSchema.safeParse({ body: "" }).success).toBe(false);
    expect(createCommentSchema.safeParse({ body: "hi" }).success).toBe(true);
  });
});
