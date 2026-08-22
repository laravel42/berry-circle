import { afterAll, describe, expect, test } from "bun:test";
import { issues } from "~/db/schema";
import {
  DATABASE_URL,
  type ErrorEnvelope,
  type IssueConnection,
  type IssueResource,
  makeTestContext,
  readJson,
  tamperCursorKey,
} from "./testkit";

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("issue routes", () => {
  const ctx = makeTestContext();
  afterAll(() => ctx.cleanup());

  const post = (headers: Record<string, string>, body: unknown) =>
    ctx.app.request("/api/v1/issues", { method: "POST", headers, body: JSON.stringify(body) });

  const createIssue = async (headers: Record<string, string>, body: unknown) =>
    readJson<IssueResource>(await post(headers, body));

  test("POST creates an issue, allocates a number, and returns the full resource", async () => {
    const board = await ctx.seedBoard();
    const user = await ctx.seedUser("Andrea");

    const res = await post(ctx.userHeaders(user.id), { boardId: board.id, title: "First issue" });
    expect(res.status).toBe(201);
    const body = await readJson<IssueResource>(res);
    expect(body.number).toBe(1);
    expect(body.identifier).toBe(`${board.slug.toUpperCase()}-1`);
    expect(body.status).toBe("backlog");
    expect(body.priority).toBe("none");
    expect(body.assignee).toBeNull();
    expect(body.activeRunId).toBeNull();
    expect(body.createdBy).toEqual({ type: "user", id: user.id, name: "Andrea", avatarUrl: null });
    expect(res.headers.get("Location")).toBe(`/api/v1/issues/${body.id}`);

    // Second issue on the same board gets the next number, no collision.
    const second = await createIssue(ctx.userHeaders(user.id), {
      boardId: board.id,
      title: "Second issue",
    });
    expect(second.number).toBe(2);
  });

  test("POST records an assignee and reflects status/priority", async () => {
    const board = await ctx.seedBoard();
    const author = await ctx.seedUser("Author");
    const assignee = await ctx.seedUser("Assignee");

    const body = await createIssue(ctx.userHeaders(author.id), {
      boardId: board.id,
      title: "Assigned",
      assignee: { type: "user", id: assignee.id },
      priority: "high",
      status: "todo",
    });
    expect(body.status).toBe("todo");
    expect(body.priority).toBe("high");
    expect(body.assignee).toEqual({
      type: "user",
      id: assignee.id,
      name: "Assignee",
      avatarUrl: null,
    });
  });

  test("POST requires an authenticated actor", async () => {
    const board = await ctx.seedBoard();
    const res = await ctx.app.request("/api/v1/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId: board.id, title: "x" }),
    });
    expect(res.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe("UNAUTHENTICATED");
  });

  test("POST returns 422 with field details for an invalid body", async () => {
    const board = await ctx.seedBoard();
    const user = await ctx.seedUser();
    const res = await post(ctx.userHeaders(user.id), { boardId: board.id, title: "" });
    expect(res.status).toBe(422);
    const body = await readJson<ErrorEnvelope>(res);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.requestId).toBeString();
    expect((body.error.details as { fields: { path: string }[] }).fields[0].path).toBe("/title");
  });

  test("POST returns 404 for a missing board and a missing assignee", async () => {
    const user = await ctx.seedUser();
    const board = await ctx.seedBoard();

    const missingBoard = await post(ctx.userHeaders(user.id), {
      boardId: crypto.randomUUID(),
      title: "x",
    });
    expect(missingBoard.status).toBe(404);

    const missingAssignee = await post(ctx.userHeaders(user.id), {
      boardId: board.id,
      title: "x",
      assignee: { type: "user", id: crypto.randomUUID() },
    });
    expect(missingAssignee.status).toBe(404);
  });

  test("GET resolves an issue by UUID and by case-insensitive identifier", async () => {
    const board = await ctx.seedBoard();
    const user = await ctx.seedUser();
    const created = await createIssue(ctx.userHeaders(user.id), {
      boardId: board.id,
      title: "Findable",
    });

    const byUuid = await ctx.app.request(`/api/v1/issues/${created.id}`);
    expect(byUuid.status).toBe(200);
    expect((await readJson<IssueResource>(byUuid)).id).toBe(created.id);

    const byLowerIdentifier = await ctx.app.request(
      `/api/v1/issues/${created.identifier.toLowerCase()}`,
    );
    expect(byLowerIdentifier.status).toBe(200);
    expect((await readJson<IssueResource>(byLowerIdentifier)).id).toBe(created.id);

    const missing = await ctx.app.request(`/api/v1/issues/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  test("GET lists issues with status filtering and stable cursor pagination", async () => {
    const board = await ctx.seedBoard();
    const user = await ctx.seedUser();
    for (const title of ["A", "B", "C"]) {
      await createIssue(ctx.userHeaders(user.id), { boardId: board.id, title, status: "todo" });
    }
    // A different-status issue that the filter must exclude.
    await createIssue(ctx.userHeaders(user.id), {
      boardId: board.id,
      title: "D",
      status: "backlog",
    });

    const page1 = await readJson<IssueConnection>(
      await ctx.app.request(`/api/v1/issues?boardId=${board.id}&status=todo&first=2`),
    );
    expect(page1.nodes).toHaveLength(2);
    expect(page1.pageInfo.hasNextPage).toBe(true);

    const page2 = await readJson<IssueConnection>(
      await ctx.app.request(
        `/api/v1/issues?boardId=${board.id}&status=todo&first=2&after=${encodeURIComponent(page1.pageInfo.endCursor ?? "")}`,
      ),
    );
    expect(page2.nodes).toHaveLength(1);
    expect(page2.pageInfo.hasNextPage).toBe(false);

    const ids = [...page1.nodes, ...page2.nodes].map((n) => n.id);
    expect(new Set(ids).size).toBe(3); // no duplicates across pages
    for (const node of [...page1.nodes, ...page2.nodes]) {
      expect(node.status).toBe("todo");
    }
  });

  test("GET list rejects a malformed cursor and a missing board", async () => {
    const board = await ctx.seedBoard();
    const badCursor = await ctx.app.request(
      `/api/v1/issues?boardId=${board.id}&after=not-a-cursor`,
    );
    expect(badCursor.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(badCursor)).error.code).toBe("INVALID_CURSOR");

    const missingBoard = await ctx.app.request(`/api/v1/issues?boardId=${crypto.randomUUID()}`);
    expect(missingBoard.status).toBe(404);
  });

  test("GET list rejects a cursor minted for a different filter scope", async () => {
    const board = await ctx.seedBoard();
    const user = await ctx.seedUser();
    await createIssue(ctx.userHeaders(user.id), {
      boardId: board.id,
      title: "Scoped",
      status: "todo",
    });
    const todoPage = await readJson<IssueConnection>(
      await ctx.app.request(`/api/v1/issues?boardId=${board.id}&status=todo&first=1`),
    );

    // Same endpoint, different filter set → the cursor must not be honored.
    const crossScope = await ctx.app.request(
      `/api/v1/issues?boardId=${board.id}&status=backlog&first=1&after=${encodeURIComponent(todoPage.pageInfo.endCursor ?? "")}`,
    );
    expect(crossScope.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(crossScope)).error.code).toBe("INVALID_CURSOR");
  });

  test("GET list rejects a correctly-scoped cursor with malformed SQL keys", async () => {
    const board = await ctx.seedBoard();
    const user = await ctx.seedUser();
    await createIssue(ctx.userHeaders(user.id), { boardId: board.id, title: "One" });
    await createIssue(ctx.userHeaders(user.id), { boardId: board.id, title: "Two" });
    const page = await readJson<IssueConnection>(
      await ctx.app.request(`/api/v1/issues?boardId=${board.id}&first=1`),
    );
    const malformed = tamperCursorKey(page.pageInfo.endCursor ?? "", ["not-a-date", "not-a-uuid"]);

    const response = await ctx.app.request(
      `/api/v1/issues?boardId=${board.id}&first=1&after=${encodeURIComponent(malformed)}`,
    );
    expect(response.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(response)).error.code).toBe("INVALID_CURSOR");
  });

  test("PATCH enforces the status workflow and applies valid changes", async () => {
    const board = await ctx.seedBoard();
    const user = await ctx.seedUser();
    const issue = await createIssue(ctx.userHeaders(user.id), {
      boardId: board.id,
      title: "Movable",
    });

    const illegal = await ctx.app.request(`/api/v1/issues/${issue.id}`, {
      method: "PATCH",
      headers: ctx.userHeaders(user.id),
      body: JSON.stringify({ status: "done" }),
    });
    expect(illegal.status).toBe(409);
    const illegalBody = await readJson<ErrorEnvelope>(illegal);
    expect(illegalBody.error.code).toBe("INVALID_STATE_TRANSITION");
    expect(illegalBody.error.details).toEqual({ from: "backlog", to: "done" });

    const legal = await ctx.app.request(`/api/v1/issues/${issue.id}`, {
      method: "PATCH",
      headers: ctx.userHeaders(user.id),
      body: JSON.stringify({ status: "todo", title: "Renamed" }),
    });
    expect(legal.status).toBe(200);
    const legalBody = await readJson<IssueResource>(legal);
    expect(legalBody.status).toBe("todo");
    expect(legalBody.title).toBe("Renamed");
  });

  test("cursor pagination is exhaustive when many issues share a timestamp", async () => {
    const board = await ctx.seedBoard();
    // Insert directly with one identical updatedAt across all rows, forcing the
    // id tiebreak — the case that a millisecond-truncated cursor would corrupt.
    const stamp = new Date("2026-08-22T06:30:00.000Z");
    const seeded = await ctx.db
      .insert(issues)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          boardId: board.id,
          number: i + 1,
          title: `Tie ${i + 1}`,
          createdAt: stamp,
          updatedAt: stamp,
        })),
      )
      .returning({ id: issues.id });
    const expectedOrder = seeded
      .map((r) => r.id)
      .sort()
      .reverse(); // (updatedAt, id) DESC

    const collected: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url = `/api/v1/issues?boardId=${board.id}&first=2${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const page: IssueConnection = await readJson<IssueConnection>(await ctx.app.request(url));
      collected.push(...page.nodes.map((n) => n.id));
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }

    expect(collected).toEqual(expectedOrder); // all five, in order, no dupes/drops
  });

  test("PATCH can assign and unassign an issue", async () => {
    const board = await ctx.seedBoard();
    const user = await ctx.seedUser();
    const assignee = await ctx.seedUser("Pat");
    const issue = await createIssue(ctx.userHeaders(user.id), {
      boardId: board.id,
      title: "Assignable",
    });

    const assigned = await readJson<IssueResource>(
      await ctx.app.request(`/api/v1/issues/${issue.id}`, {
        method: "PATCH",
        headers: ctx.userHeaders(user.id),
        body: JSON.stringify({ assignee: { type: "user", id: assignee.id } }),
      }),
    );
    expect(assigned.assignee?.id).toBe(assignee.id);

    const unassigned = await readJson<IssueResource>(
      await ctx.app.request(`/api/v1/issues/${issue.id}`, {
        method: "PATCH",
        headers: ctx.userHeaders(user.id),
        body: JSON.stringify({ assignee: null }),
      }),
    );
    expect(unassigned.assignee).toBeNull();
  });
});
