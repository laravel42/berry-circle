import { afterAll, describe, expect, test } from "bun:test";
import { boards, issues } from "~/db/schema";
import { DEFAULT_BOARD_COLUMNS } from "~/schemas/board";
import {
  type Board,
  type BoardConnection,
  DATABASE_URL,
  type ErrorEnvelope,
  makeTestContext,
  readJson,
  tamperCursorKey,
} from "./testkit";

const describeIfDb = DATABASE_URL ? describe : describe.skip;

function uniqueSlug(): string {
  return `b${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

describeIfDb("board routes", () => {
  const ctx = makeTestContext();
  afterAll(() => ctx.cleanup());

  const post = (headers: Record<string, string>, body: unknown) =>
    ctx.app.request("/api/v1/boards", { method: "POST", headers, body: JSON.stringify(body) });

  const createBoard = async (
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ res: Response; board: Board }> => {
    const res = await post(headers, body);
    const board = await readJson<Board>(res);
    if (res.status === 201) ctx.rememberBoard(board.id);
    return { res, board };
  };

  test("POST creates a board with default columns, Location, and the full resource", async () => {
    const { headers } = await ctx.seedSession("Andrea");
    const slug = uniqueSlug();
    const { res, board } = await createBoard(headers, {
      name: "Berry",
      slug,
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe(`/api/v1/boards/${board.id}`);
    expect(board.name).toBe("Berry");
    expect(board.slug).toBe(slug);
    expect(board.description).toBeNull();
    expect(board.columns).toEqual([...DEFAULT_BOARD_COLUMNS]);
    expect(board.id).toBeString();
    expect(board.createdAt).toBeString();
    expect(board.updatedAt).toBeString();
  });

  test("POST persists explicit columns and a description", async () => {
    const { headers } = await ctx.seedSession();
    const columns = [
      { id: "todo" as const, name: "Ready" },
      { id: "inProgress" as const, name: "Doing" },
    ];
    const { res, board } = await createBoard(headers, {
      name: "Custom",
      slug: uniqueSlug(),
      description: "A focused board",
      columns,
    });
    expect(res.status).toBe(201);
    expect(board.description).toBe("A focused board");
    expect(board.columns).toEqual(columns);
  });

  test("board routes require an authenticated session", async () => {
    const get = await ctx.app.request("/api/v1/boards");
    expect(get.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(get)).error.code).toBe("UNAUTHENTICATED");

    const post = await ctx.app.request("/api/v1/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", slug: uniqueSlug() }),
    });
    expect(post.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(post)).error.code).toBe("UNAUTHENTICATED");
  });

  test("POST returns 422 with field details for an invalid body", async () => {
    const { headers } = await ctx.seedSession();
    const res = await post(headers, { name: "", slug: "Berry" });
    expect(res.status).toBe(422);
    const body = await readJson<ErrorEnvelope>(res);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.requestId).toBeString();
    const paths = (body.error.details as { fields: { path: string }[] }).fields.map((f) => f.path);
    expect(paths).toContain("/name");
    expect(paths).toContain("/slug");
  });

  test("POST returns 409 CONFLICT for a duplicate slug", async () => {
    const { headers } = await ctx.seedSession();
    const slug = uniqueSlug();
    const first = await createBoard(headers, { name: "One", slug });
    expect(first.res.status).toBe(201);

    const second = await post(headers, { name: "Two", slug });
    expect(second.status).toBe(409);
    expect((await readJson<ErrorEnvelope>(second)).error.code).toBe("CONFLICT");
  });

  test("GET returns a board by UUID and 404s for missing or malformed ids", async () => {
    const { headers } = await ctx.seedSession();
    const { board } = await createBoard(headers, {
      name: "Findable",
      slug: uniqueSlug(),
    });

    const byUuid = await ctx.app.request(`/api/v1/boards/${board.id}`, { headers });
    expect(byUuid.status).toBe(200);
    expect((await readJson<Board>(byUuid)).id).toBe(board.id);

    const missing = await ctx.app.request(`/api/v1/boards/${crypto.randomUUID()}`, { headers });
    expect(missing.status).toBe(404);

    const malformed = await ctx.app.request("/api/v1/boards/not-a-uuid", { headers });
    expect(malformed.status).toBe(404);
  });

  test("GET lists boards with stable cursor pagination", async () => {
    const { headers } = await ctx.seedSession();
    // Far-future stamps keep this group at the head of the workspace-wide list
    // so leftover boards from other suites cannot steal the first pages.
    const stamp = new Date("2099-08-22T06:30:00.000Z");
    const seeded = await ctx.db
      .insert(boards)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          name: `Page ${i + 1}`,
          slug: uniqueSlug(),
          columns: [...DEFAULT_BOARD_COLUMNS],
          createdAt: stamp,
          updatedAt: stamp,
        })),
      )
      .returning({ id: boards.id });
    for (const row of seeded) ctx.rememberBoard(row.id);

    const expectedOrder = seeded
      .map((r) => r.id)
      .sort()
      .reverse(); // (createdAt, id) DESC

    const collected: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url = `/api/v1/boards?first=2${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const page: BoardConnection = await readJson<BoardConnection>(
        await ctx.app.request(url, { headers }),
      );
      collected.push(...page.nodes.map((n) => n.id).filter((id) => expectedOrder.includes(id)));
      if (collected.length >= 5 || !page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    expect(collected).toEqual(expectedOrder);
  });

  test("GET list rejects a malformed cursor and a tampered key", async () => {
    const { headers } = await ctx.seedSession();
    const stamp = new Date("2099-08-22T06:31:00.000Z");
    const seeded = await ctx.db
      .insert(boards)
      .values([
        { name: "Cursor A", slug: uniqueSlug(), createdAt: stamp, updatedAt: stamp },
        { name: "Cursor B", slug: uniqueSlug(), createdAt: stamp, updatedAt: stamp },
      ])
      .returning({ id: boards.id });
    for (const row of seeded) ctx.rememberBoard(row.id);

    const badCursor = await ctx.app.request("/api/v1/boards?after=not-a-cursor", { headers });
    expect(badCursor.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(badCursor)).error.code).toBe("INVALID_CURSOR");

    const page = await readJson<BoardConnection>(
      await ctx.app.request("/api/v1/boards?first=1", { headers }),
    );
    const malformed = tamperCursorKey(page.pageInfo.endCursor ?? "", ["not-a-date", "not-a-uuid"]);
    const response = await ctx.app.request(
      `/api/v1/boards?first=1&after=${encodeURIComponent(malformed)}`,
      { headers },
    );
    expect(response.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(response)).error.code).toBe("INVALID_CURSOR");
  });

  test("GET list rejects a cursor minted for a different endpoint", async () => {
    const board = await ctx.seedBoard();
    const { headers } = await ctx.seedSession();
    await ctx.app.request("/api/v1/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ boardId: board.id, title: "Scoped" }),
    });
    const issuePage = await readJson<{ pageInfo: { endCursor: string | null } }>(
      await ctx.app.request(`/api/v1/issues?boardId=${board.id}&first=1`, { headers }),
    );
    const cross = await ctx.app.request(
      `/api/v1/boards?first=1&after=${encodeURIComponent(issuePage.pageInfo.endCursor ?? "")}`,
      { headers },
    );
    expect(cross.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(cross)).error.code).toBe("INVALID_CURSOR");
  });

  test("PATCH applies a non-empty subset and rejects an empty body", async () => {
    const { headers } = await ctx.seedSession();
    const { board } = await createBoard(headers, {
      name: "Original",
      slug: uniqueSlug(),
      description: "before",
    });

    const empty = await ctx.app.request(`/api/v1/boards/${board.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(422);
    expect((await readJson<ErrorEnvelope>(empty)).error.code).toBe("VALIDATION_FAILED");

    const renamed = await ctx.app.request(`/api/v1/boards/${board.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Renamed", description: null }),
    });
    expect(renamed.status).toBe(200);
    const body = await readJson<Board>(renamed);
    expect(body.name).toBe("Renamed");
    expect(body.description).toBeNull();
    expect(body.slug).toBe(board.slug);
    expect(body.columns).toEqual([...DEFAULT_BOARD_COLUMNS]);
  });

  test("PATCH requires an authenticated session and 404s a missing board", async () => {
    const { headers } = await ctx.seedSession();
    const { board } = await createBoard(headers, {
      name: "Locked",
      slug: uniqueSlug(),
    });

    const unauth = await ctx.app.request(`/api/v1/boards/${board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(unauth.status).toBe(401);

    const missing = await ctx.app.request(`/api/v1/boards/${crypto.randomUUID()}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(missing.status).toBe(404);
  });

  test("PATCH returns 409 CONFLICT for a duplicate slug", async () => {
    const { headers } = await ctx.seedSession();
    const { board: first } = await createBoard(headers, {
      name: "First",
      slug: uniqueSlug(),
    });
    const { board: second } = await createBoard(headers, {
      name: "Second",
      slug: uniqueSlug(),
    });

    const res = await ctx.app.request(`/api/v1/boards/${second.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ slug: first.slug }),
    });
    expect(res.status).toBe(409);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe("CONFLICT");
  });

  test("PATCH refuses to drop a column used by a non-terminal issue", async () => {
    const { headers } = await ctx.seedSession();
    const { board } = await createBoard(headers, {
      name: "Busy",
      slug: uniqueSlug(),
    });
    const issueRes = await ctx.app.request("/api/v1/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ boardId: board.id, title: "In todo", status: "todo" }),
    });
    expect(issueRes.status).toBe(201);

    const withoutTodo = DEFAULT_BOARD_COLUMNS.filter((column) => column.id !== "todo");
    const res = await ctx.app.request(`/api/v1/boards/${board.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ columns: withoutTodo }),
    });
    expect(res.status).toBe(409);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe("CONFLICT");
  });

  test("PATCH allows dropping a column used only by terminal issues, and renaming in-use columns", async () => {
    const { headers } = await ctx.seedSession();
    const { board } = await createBoard(headers, {
      name: "Flexible",
      slug: uniqueSlug(),
    });
    await ctx.db.insert(issues).values({
      boardId: board.id,
      number: 1,
      title: "Finished",
      status: "done",
    });

    const withoutDone = DEFAULT_BOARD_COLUMNS.filter((column) => column.id !== "done");
    const dropped = await ctx.app.request(`/api/v1/boards/${board.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ columns: withoutDone }),
    });
    expect(dropped.status).toBe(200);
    expect((await readJson<Board>(dropped)).columns.map((c) => c.id)).not.toContain("done");

    const { board: named } = await createBoard(headers, {
      name: "Rename cols",
      slug: uniqueSlug(),
    });
    await ctx.app.request("/api/v1/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ boardId: named.id, title: "Still todo", status: "todo" }),
    });
    const relabeled = DEFAULT_BOARD_COLUMNS.map((column) =>
      column.id === "todo" ? { ...column, name: "Ready" } : column,
    );
    const renamed = await ctx.app.request(`/api/v1/boards/${named.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ columns: relabeled }),
    });
    expect(renamed.status).toBe(200);
    const renamedBody = await readJson<Board>(renamed);
    expect(renamedBody.columns.find((c) => c.id === "todo")?.name).toBe("Ready");
  });
});
