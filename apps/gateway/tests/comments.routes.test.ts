import { afterAll, describe, expect, test } from "bun:test";
import {
  type CommentConnection,
  type CommentResource,
  DATABASE_URL,
  type ErrorEnvelope,
  type IssueResource,
  makeTestContext,
  readJson,
  tamperCursorKey,
} from "./testkit";

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("comment routes", () => {
  const ctx = makeTestContext();
  afterAll(() => ctx.cleanup());

  /** Seeds a board + user and creates an issue, returning what the tests need. */
  async function seedIssue() {
    const board = await ctx.seedBoard();
    const user = await ctx.seedUser("Author");
    const issue = await readJson<IssueResource>(
      await ctx.app.request("/api/v1/issues", {
        method: "POST",
        headers: ctx.userHeaders(user.id),
        body: JSON.stringify({ boardId: board.id, title: "Discussable" }),
      }),
    );
    return { board, user, issue };
  }

  const postComment = (issueId: string, headers: Record<string, string>, body: unknown) =>
    ctx.app.request(`/api/v1/issues/${issueId}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  const createComment = async (issueId: string, headers: Record<string, string>, body: unknown) =>
    readJson<CommentResource>(await postComment(issueId, headers, body));

  test("POST creates a comment authored by the acting user", async () => {
    const { user, issue } = await seedIssue();
    const res = await postComment(issue.id, ctx.userHeaders(user.id), { body: "First!" });

    expect(res.status).toBe(201);
    const body = await readJson<CommentResource>(res);
    expect(body.body).toBe("First!");
    expect(body.parentId).toBeNull();
    expect(body.author).toEqual({ type: "user", id: user.id, name: "Author", avatarUrl: null });
    expect(res.headers.get("Location")).toBe(`/api/v1/comments/${body.id}`);
  });

  test("an agent actor can author a comment", async () => {
    const { issue } = await seedIssue();
    const agentId = crypto.randomUUID();
    const body = await createComment(issue.id, ctx.agentHeaders(agentId), {
      body: "From an agent",
    });
    expect(body.author).toEqual({ type: "agent", id: agentId, name: "Agent", avatarUrl: null });
  });

  test("POST requires an authenticated actor", async () => {
    const { issue } = await seedIssue();
    const res = await ctx.app.request(`/api/v1/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "anon" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST on a nonexistent issue returns 404", async () => {
    const user = await ctx.seedUser();
    const res = await postComment(crypto.randomUUID(), ctx.userHeaders(user.id), { body: "x" });
    expect(res.status).toBe(404);
  });

  test("replies are one level deep and must share the parent's issue", async () => {
    const { user, issue } = await seedIssue();
    const root = await createComment(issue.id, ctx.userHeaders(user.id), { body: "root" });

    const reply = await postComment(issue.id, ctx.userHeaders(user.id), {
      body: "reply",
      parentId: root.id,
    });
    expect(reply.status).toBe(201);
    const replyBody = await readJson<CommentResource>(reply);
    expect(replyBody.parentId).toBe(root.id);

    // A reply to a reply is rejected (one-level threading).
    const nested = await postComment(issue.id, ctx.userHeaders(user.id), {
      body: "nested",
      parentId: replyBody.id,
    });
    expect(nested.status).toBe(422);
    const nestedBody = await readJson<ErrorEnvelope>(nested);
    expect((nestedBody.error.details as { fields: { path: string }[] }).fields[0].path).toBe(
      "/parentId",
    );

    // A parent that belongs to another issue is not found.
    const other = await seedIssue();
    const crossIssue = await postComment(other.issue.id, ctx.userHeaders(other.user.id), {
      body: "cross",
      parentId: root.id,
    });
    expect(crossIssue.status).toBe(404);
  });

  test("GET lists comments oldest-first with cursor pagination", async () => {
    const { user, issue } = await seedIssue();
    for (const body of ["one", "two", "three"]) {
      await createComment(issue.id, ctx.userHeaders(user.id), { body });
    }

    const page1 = await readJson<CommentConnection>(
      await ctx.app.request(`/api/v1/issues/${issue.id}/comments?first=2`),
    );
    expect(page1.nodes).toHaveLength(2);
    expect(page1.pageInfo.hasNextPage).toBe(true);

    const page2 = await readJson<CommentConnection>(
      await ctx.app.request(
        `/api/v1/issues/${issue.id}/comments?first=2&after=${encodeURIComponent(page1.pageInfo.endCursor ?? "")}`,
      ),
    );
    expect(page2.nodes).toHaveLength(1);
    expect(page2.pageInfo.hasNextPage).toBe(false);

    // Every comment appears exactly once across the two pages...
    const all = [...page1.nodes, ...page2.nodes];
    expect(new Set(all.map((n) => n.id)).size).toBe(3);
    expect(new Set(all.map((n) => n.body))).toEqual(new Set(["one", "two", "three"]));
    // ...in non-decreasing createdAt order (the documented sort).
    const times = all.map((n) => Date.parse(n.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("GET list rejects a correctly-scoped cursor with malformed SQL keys", async () => {
    const { user, issue } = await seedIssue();
    await createComment(issue.id, ctx.userHeaders(user.id), { body: "one" });
    await createComment(issue.id, ctx.userHeaders(user.id), { body: "two" });
    const page = await readJson<CommentConnection>(
      await ctx.app.request(`/api/v1/issues/${issue.id}/comments?first=1`),
    );
    const malformed = tamperCursorKey(page.pageInfo.endCursor ?? "", ["not-a-date", "not-a-uuid"]);

    const response = await ctx.app.request(
      `/api/v1/issues/${issue.id}/comments?first=1&after=${encodeURIComponent(malformed)}`,
    );
    expect(response.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(response)).error.code).toBe("INVALID_CURSOR");
  });

  test("GET a comment by id, or 404 when absent", async () => {
    const { user, issue } = await seedIssue();
    const created = await createComment(issue.id, ctx.userHeaders(user.id), { body: "fetch me" });

    const found = await ctx.app.request(`/api/v1/comments/${created.id}`);
    expect(found.status).toBe(200);
    expect((await readJson<CommentResource>(found)).body).toBe("fetch me");

    const missing = await ctx.app.request(`/api/v1/comments/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  test("PATCH is limited to the author, with an admin override", async () => {
    const { user, issue } = await seedIssue();
    const other = await ctx.seedUser("Intruder");
    const comment = await createComment(issue.id, ctx.userHeaders(user.id), { body: "original" });

    const forbidden = await ctx.app.request(`/api/v1/comments/${comment.id}`, {
      method: "PATCH",
      headers: ctx.userHeaders(other.id),
      body: JSON.stringify({ body: "hijacked" }),
    });
    expect(forbidden.status).toBe(403);

    const byAuthor = await ctx.app.request(`/api/v1/comments/${comment.id}`, {
      method: "PATCH",
      headers: ctx.userHeaders(user.id),
      body: JSON.stringify({ body: "edited" }),
    });
    expect(byAuthor.status).toBe(200);
    expect((await readJson<CommentResource>(byAuthor)).body).toBe("edited");

    const byAdmin = await ctx.app.request(`/api/v1/comments/${comment.id}`, {
      method: "PATCH",
      headers: ctx.userHeaders(other.id, true),
      body: JSON.stringify({ body: "admin edit" }),
    });
    expect(byAdmin.status).toBe(200);
    expect((await readJson<CommentResource>(byAdmin)).body).toBe("admin edit");
  });

  test("DELETE removes a root comment and cascades to its replies", async () => {
    const { user, issue } = await seedIssue();
    const root = await createComment(issue.id, ctx.userHeaders(user.id), { body: "root" });
    const reply = await createComment(issue.id, ctx.userHeaders(user.id), {
      body: "reply",
      parentId: root.id,
    });

    const nonAuthor = await ctx.seedUser("Nope");
    const denied = await ctx.app.request(`/api/v1/comments/${root.id}`, {
      method: "DELETE",
      headers: ctx.userHeaders(nonAuthor.id),
    });
    expect(denied.status).toBe(403);

    const deleted = await ctx.app.request(`/api/v1/comments/${root.id}`, {
      method: "DELETE",
      headers: ctx.userHeaders(user.id),
    });
    expect(deleted.status).toBe(204);

    expect((await ctx.app.request(`/api/v1/comments/${root.id}`)).status).toBe(404);
    expect((await ctx.app.request(`/api/v1/comments/${reply.id}`)).status).toBe(404);
  });
});
