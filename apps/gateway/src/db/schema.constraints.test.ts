import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { boards, comments, issues, users } from "./schema";

/**
 * Integration tests for the schema's data-integrity constraints
 * (Backend PR Adversary findings on PR #1 — BERR-21). Requires a reachable
 * Postgres with migrations already applied; skipped otherwise so `bun test`
 * stays green with no DATABASE_URL configured (e.g. plain `bun install &&
 * bun test` on a fresh checkout).
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

/** Asserts a value is defined and returns it narrowed, without `!`. */
function must<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) {
		throw new Error("Expected value to be defined");
	}
	return value;
}

/** Awaits a drizzle query builder and asserts it rejects (query builders are
 * thenables, not real Promises, which `expect().rejects` doesn't accept). */
async function expectRejects(query: PromiseLike<unknown>): Promise<void> {
	let threw = false;
	try {
		await query;
	} catch {
		threw = true;
	}
	expect(threw).toBe(true);
}

describeIfDb("schema constraints", () => {
	const client = postgres(databaseUrl ?? "", { max: 1 });
	const db = drizzle(client);

	afterAll(async () => {
		await client.end();
	});

	test("issues.number is allocated via boards.issue_counter without collisions", async () => {
		const [board] = await db
			.insert(boards)
			.values({
				name: "Counter test",
				slug: `counter-test-${crypto.randomUUID()}`,
			})
			.returning();
		const boardId = must(board).id;

		const allocate = () =>
			db.execute(
				sql`UPDATE ${boards} SET issue_counter = issue_counter + 1 WHERE id = ${boardId} RETURNING issue_counter`,
			);

		const [a, b] = await Promise.all([allocate(), allocate()]);
		const numbers = [a[0]?.issue_counter, b[0]?.issue_counter].sort();
		expect(numbers).toEqual([1, 2]);
	});

	test("comments.parent_id rejects a dangling reference", async () => {
		const [board] = await db
			.insert(boards)
			.values({ name: "FK test", slug: `fk-test-${crypto.randomUUID()}` })
			.returning();
		const [issue] = await db
			.insert(issues)
			.values({ boardId: must(board).id, number: 1, title: "issue" })
			.returning();

		await expectRejects(
			db.insert(comments).values({
				issueId: must(issue).id,
				authorType: "user",
				authorId: crypto.randomUUID(),
				body: "dangling reply",
				parentId: crypto.randomUUID(),
			}),
		);
	});

	test("updated_at advances on UPDATE via trigger", async () => {
		const [board] = await db
			.insert(boards)
			.values({
				name: "Trigger test",
				slug: `trigger-test-${crypto.randomUUID()}`,
			})
			.returning();
		const boardId = must(board).id;

		await new Promise((resolve) => setTimeout(resolve, 10));
		const [updated] = await db
			.update(boards)
			.set({ name: "Trigger test (renamed)" })
			.where(sql`${boards.id} = ${boardId}`)
			.returning();

		expect(must(updated).updatedAt.getTime()).toBeGreaterThan(
			must(board).createdAt.getTime(),
		);
	});

	test("issues.assignee_type/assignee_id must be both-or-neither", async () => {
		const [board] = await db
			.insert(boards)
			.values({
				name: "Assignee test",
				slug: `assignee-test-${crypto.randomUUID()}`,
			})
			.returning();

		await expectRejects(
			db.insert(issues).values({
				boardId: must(board).id,
				number: 1,
				title: "half assigned",
				assigneeType: "agent",
				assigneeId: null,
			}),
		);
	});

	test("users.email uniqueness is case-insensitive", async () => {
		const email = `Case-Test-${crypto.randomUUID()}@Berry.dev`;
		await db.insert(users).values({ email, name: "Case Test" });

		await expectRejects(
			db.insert(users).values({ email: email.toLowerCase(), name: "Dup" }),
		);
	});

	test("boards.columns rejects non-array JSON", async () => {
		await expectRejects(
			db.execute(
				sql`INSERT INTO ${boards} (name, slug, columns) VALUES ('Junk', ${`junk-${crypto.randomUUID()}`}, '{"not":"an array"}'::jsonb)`,
			),
		);
	});
});
