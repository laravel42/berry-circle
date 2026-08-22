import { describe, expect, it } from "bun:test";
import {
  DEFAULT_BOARD_COLUMNS,
  actorRefSchema,
  agentSchema,
  boardSchema,
  boardSlugSchema,
  commaSeparated,
  commentSchema,
  connectionSchema,
  createBoardRequestSchema,
  createCommentRequestSchema,
  createIssueRequestSchema,
  createRunRequestSchema,
  errorEnvelopeSchema,
  eventEnvelopeSchema,
  eventSchema,
  isActiveRunStatus,
  isTerminalRunStatus,
  issueListQuerySchema,
  issueSchema,
  issueStatusSchema,
  paginationQuerySchema,
  runSchema,
  runUsageSchema,
  timestampSchema,
  updateBoardRequestSchema,
  updateIssueRequestSchema,
  uuidSchema,
} from "~/schemas";

// Fixtures lifted verbatim from docs/api/gateway-v1.md so the DTOs stay pinned
// to the normative contract examples.
const AGENT_REF = {
  type: "agent",
  id: "f8957903-6534-4ca3-a218-d95e537a5076",
  name: "Builder",
  avatarUrl: null,
} as const;

describe("common primitives", () => {
  it("validates UUIDs and timestamps", () => {
    expect(uuidSchema.safeParse("bb99372f-88c4-44f0-914f-a343bf30e6fb").success).toBe(true);
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);

    expect(timestampSchema.safeParse("2026-08-22T06:30:00.000Z").success).toBe(true);
    expect(timestampSchema.safeParse("2026-08-22").success).toBe(false);
    // The contract requires UTC (`...Z`); a local offset must be rejected.
    expect(timestampSchema.safeParse("2026-08-22T06:30:00+02:00").success).toBe(false);
  });

  it("requires actorRef.avatarUrl to be present (nullable, not optional)", () => {
    expect(actorRefSchema.safeParse(AGENT_REF).success).toBe(true);
    const { avatarUrl: _omit, ...withoutAvatar } = AGENT_REF;
    expect(actorRefSchema.safeParse(withoutAvatar).success).toBe(false);
  });
});

describe("pagination", () => {
  it("defaults first to 50 and coerces string query values", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ first: 50 });
    expect(paginationQuerySchema.parse({ first: "30", after: "cur_1" })).toEqual({
      first: 30,
      after: "cur_1",
    });
  });

  it("bounds first to 1..100", () => {
    expect(paginationQuerySchema.safeParse({ first: "0" }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ first: "101" }).success).toBe(false);
  });

  it("builds a connection schema with the empty-page example", () => {
    const conn = connectionSchema(issueSchema);
    expect(
      conn.safeParse({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }).success,
    ).toBe(true);
  });

  it("parses comma-separated enum lists and rejects unknown or empty values", () => {
    const status = commaSeparated(issueStatusSchema);
    expect(status.parse("todo,inProgress")).toEqual(["todo", "inProgress"]);
    expect(status.parse("todo, ")).toEqual(["todo"]);
    expect(status.safeParse("todo,bogus").success).toBe(false);
    expect(status.safeParse("").success).toBe(false);
  });
});

describe("error envelope", () => {
  it("parses the contract validation-failure example", () => {
    const envelope = {
      error: {
        code: "VALIDATION_FAILED",
        message: "The request is invalid.",
        requestId: "req_01J5VWDY4JF6QM6BS48Y7C8H7F",
        details: {
          fields: [
            {
              path: "/title",
              code: "too_small",
              message: "Title must contain at least 1 character.",
            },
          ],
        },
      },
    };
    expect(errorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("tolerates domain detail keys and a null details object", () => {
    const stateConflict = {
      error: {
        code: "INVALID_STATE_TRANSITION",
        message: "Illegal transition.",
        requestId: "req_x",
        details: { from: "done", to: "todo" },
      },
    };
    expect(errorEnvelopeSchema.safeParse(stateConflict).success).toBe(true);
    expect(
      errorEnvelopeSchema.safeParse({
        error: { code: "INTERNAL", message: "boom", requestId: "req_y", details: null },
      }).success,
    ).toBe(true);
  });
});

describe("enums", () => {
  it("uses the camelCase contract spelling, not the DB spelling", () => {
    expect(issueStatusSchema.safeParse("inProgress").success).toBe(true);
    expect(issueStatusSchema.safeParse("in_progress").success).toBe(false);
  });

  it("classifies active vs terminal run statuses", () => {
    expect(isActiveRunStatus("queued")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("succeeded")).toBe(false);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
  });
});

describe("board", () => {
  it("parses the contract Board example", () => {
    const board = {
      id: "bb99372f-88c4-44f0-914f-a343bf30e6fb",
      name: "Berry",
      slug: "berry",
      description: "Release 1 workspace",
      columns: [
        { id: "backlog", name: "Backlog" },
        { id: "todo", name: "Todo" },
        { id: "inProgress", name: "In progress" },
        { id: "inReview", name: "In review" },
        { id: "done", name: "Done" },
      ],
      createdAt: "2026-08-22T06:30:00.000Z",
      updatedAt: "2026-08-22T06:30:00.000Z",
    };
    expect(boardSchema.safeParse(board).success).toBe(true);
  });

  it("enforces the slug format", () => {
    expect(boardSlugSchema.safeParse("berry").success).toBe(true);
    expect(boardSlugSchema.safeParse("Berry").success).toBe(false);
    expect(boardSlugSchema.safeParse("b").success).toBe(false);
    expect(boardSlugSchema.safeParse("thisistoolong").success).toBe(false);
  });

  it("applies the five default columns when columns are omitted", () => {
    const parsed = createBoardRequestSchema.parse({ name: "Berry", slug: "berry" });
    expect(parsed.columns).toEqual([...DEFAULT_BOARD_COLUMNS]);
    expect(parsed.columns).toHaveLength(5);
  });

  it("rejects an empty PATCH body but accepts a single field", () => {
    expect(updateBoardRequestSchema.safeParse({}).success).toBe(false);
    expect(updateBoardRequestSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });
});

describe("issue", () => {
  it("parses the contract Issue example", () => {
    const issue = {
      id: "8138a662-f20f-41aa-bd5a-cf46e35ba952",
      boardId: "bb99372f-88c4-44f0-914f-a343bf30e6fb",
      number: 42,
      identifier: "BERRY-42",
      title: "Wire the board to the gateway",
      description: "Replace fixture data with API resources.",
      status: "inProgress",
      priority: "high",
      sortOrder: 1200,
      dueDate: null,
      assignee: AGENT_REF,
      activeRunId: "2020836b-a055-4980-b165-50664cf402c3",
      createdBy: {
        type: "user",
        id: "782a0204-2868-437e-9be8-5b17ce7f13f7",
        name: "Andrea",
        avatarUrl: null,
      },
      createdAt: "2026-08-22T06:30:00.000Z",
      updatedAt: "2026-08-22T06:42:00.000Z",
    };
    expect(issueSchema.safeParse(issue).success).toBe(true);
  });

  it("applies documented create defaults", () => {
    const parsed = createIssueRequestSchema.parse({
      boardId: "bb99372f-88c4-44f0-914f-a343bf30e6fb",
      title: "New issue",
    });
    expect(parsed).toMatchObject({
      status: "backlog",
      priority: "none",
      sortOrder: 0,
      description: null,
      dueDate: null,
      assignee: null,
    });
  });

  it("allows unassigning via assignee:null on PATCH but rejects an empty body", () => {
    expect(updateIssueRequestSchema.safeParse({ assignee: null }).success).toBe(true);
    expect(updateIssueRequestSchema.safeParse({}).success).toBe(false);
  });

  it("requires boardId and pairs assigneeType with assigneeId", () => {
    expect(issueListQuerySchema.safeParse({}).success).toBe(false);

    const base = { boardId: "bb99372f-88c4-44f0-914f-a343bf30e6fb" };
    expect(issueListQuerySchema.safeParse(base).success).toBe(true);
    expect(issueListQuerySchema.safeParse({ ...base, assigneeType: "agent" }).success).toBe(false);
    expect(
      issueListQuerySchema.safeParse({
        ...base,
        assigneeType: "agent",
        assigneeId: "f8957903-6534-4ca3-a218-d95e537a5076",
      }).success,
    ).toBe(true);

    const parsed = issueListQuerySchema.parse({ ...base, status: "todo,inProgress" });
    expect(parsed).toMatchObject({ status: ["todo", "inProgress"], first: 50 });
  });
});

describe("comment", () => {
  it("parses the contract Comment example and defaults parentId", () => {
    const comment = {
      id: "3299af16-2bc9-4d2d-b8b7-b76d284ec40d",
      issueId: "8138a662-f20f-41aa-bd5a-cf46e35ba952",
      body: "The gateway contract is ready for review.",
      author: AGENT_REF,
      parentId: null,
      createdAt: "2026-08-22T06:45:00.000Z",
      updatedAt: "2026-08-22T06:45:00.000Z",
    };
    expect(commentSchema.safeParse(comment).success).toBe(true);
    expect(createCommentRequestSchema.parse({ body: "hi" })).toEqual({
      body: "hi",
      parentId: null,
    });
  });
});

describe("agent", () => {
  it("parses the contract Agent example", () => {
    const agent = {
      id: "f8957903-6534-4ca3-a218-d95e537a5076",
      name: "Builder",
      description: "Implements scoped engineering tasks.",
      avatarUrl: null,
      status: "busy",
      capabilities: ["code", "git", "tests"],
      createdAt: "2026-08-20T15:00:00.000Z",
      updatedAt: "2026-08-22T06:42:01.000Z",
    };
    expect(agentSchema.safeParse(agent).success).toBe(true);
  });
});

describe("run", () => {
  it("parses the contract Run example", () => {
    const run = {
      id: "2020836b-a055-4980-b165-50664cf402c3",
      issueId: "8138a662-f20f-41aa-bd5a-cf46e35ba952",
      agentId: "f8957903-6534-4ca3-a218-d95e537a5076",
      status: "running",
      sequence: 8,
      summary: null,
      usage: {
        inputTokens: 2140,
        outputTokens: 318,
        totalTokens: 2458,
        costMicros: null,
        currency: null,
      },
      failure: null,
      createdAt: "2026-08-22T06:42:00.000Z",
      startedAt: "2026-08-22T06:42:01.000Z",
      completedAt: null,
    };
    expect(runSchema.safeParse(run).success).toBe(true);
  });

  it("validates the currency as an ISO 4217 uppercase code", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costMicros: 1000,
      currency: "USD",
    };
    expect(runUsageSchema.safeParse(usage).success).toBe(true);
    expect(runUsageSchema.safeParse({ ...usage, currency: "usd" }).success).toBe(false);
    expect(runUsageSchema.safeParse({ ...usage, currency: "US" }).success).toBe(false);
  });

  it("accepts an empty dispatch body", () => {
    expect(createRunRequestSchema.parse({})).toEqual({ agentId: null, instructions: null });
  });
});

describe("events", () => {
  const RUN_STARTED = {
    id: "evt_01J5VXZ6J93DPTW7XEF27MS7SB",
    type: "run.started",
    occurredAt: "2026-08-22T06:42:01.000Z",
    boardId: "bb99372f-88c4-44f0-914f-a343bf30e6fb",
    issueId: "8138a662-f20f-41aa-bd5a-cf46e35ba952",
    runId: "2020836b-a055-4980-b165-50664cf402c3",
    sequence: 1,
    payload: { startedAt: "2026-08-22T06:42:01.000Z" },
  };

  it("parses and narrows a run.started frame via the discriminated union", () => {
    const parsed = eventSchema.parse(RUN_STARTED);
    expect(parsed.type).toBe("run.started");
    if (parsed.type === "run.started") {
      expect(parsed.payload.startedAt).toBe("2026-08-22T06:42:01.000Z");
    }
  });

  it("parses a run.completed frame carrying a terminal run snapshot", () => {
    const runCompleted = {
      id: "evt_01J5W0BBZM6S8G8P7XYAHQHN2C",
      type: "run.completed",
      occurredAt: "2026-08-22T06:48:22.000Z",
      boardId: "bb99372f-88c4-44f0-914f-a343bf30e6fb",
      issueId: "8138a662-f20f-41aa-bd5a-cf46e35ba952",
      runId: "2020836b-a055-4980-b165-50664cf402c3",
      sequence: 19,
      payload: {
        run: {
          id: "2020836b-a055-4980-b165-50664cf402c3",
          issueId: "8138a662-f20f-41aa-bd5a-cf46e35ba952",
          agentId: "f8957903-6534-4ca3-a218-d95e537a5076",
          status: "succeeded",
          sequence: 19,
          summary: "Gateway wiring completed and tests passed.",
          usage: {
            inputTokens: 2140,
            outputTokens: 901,
            totalTokens: 3041,
            costMicros: null,
            currency: null,
          },
          failure: null,
          createdAt: "2026-08-22T06:42:00.000Z",
          startedAt: "2026-08-22T06:42:01.000Z",
          completedAt: "2026-08-22T06:48:22.000Z",
        },
      },
    };
    expect(eventSchema.safeParse(runCompleted).success).toBe(true);
  });

  it("rejects an unknown event type in the strict union", () => {
    expect(eventSchema.safeParse({ ...RUN_STARTED, type: "run.bogus" }).success).toBe(false);
  });

  it("tolerates an unknown event type in the forward-compatible envelope", () => {
    const future = {
      id: "evt_future",
      type: "run.something.new",
      occurredAt: "2026-08-22T06:42:01.000Z",
      boardId: "bb99372f-88c4-44f0-914f-a343bf30e6fb",
      issueId: "8138a662-f20f-41aa-bd5a-cf46e35ba952",
      runId: null,
      sequence: null,
      payload: { anything: true },
    };
    expect(eventEnvelopeSchema.safeParse(future).success).toBe(true);
  });
});
