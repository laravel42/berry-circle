import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Upgrade-path test for migration 0001 (Backend PR Adversary re-review BLOCKER on
 * PR #1 — BERR-21). The constraint tests assert the new invariants hold once 0001
 * is applied; this asserts 0001 *can be applied* to a database that already holds
 * the data 0000 permitted — the case that a fresh-DB test can never catch and that
 * every future constraint-adding migration inherits.
 *
 * Each test provisions a throwaway database (so it never disturbs the migrated
 * DATABASE_URL database the constraint tests use), applies 0000 alone, seeds the
 * pre-fix rows, then runs the real migrator to apply 0001. Requires a Postgres
 * role that can CREATE/DROP databases; the whole suite skips cleanly otherwise, so
 * `bun test` stays green on a fresh checkout with no DATABASE_URL.
 */
const databaseUrl = process.env.DATABASE_URL;
const realDir = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Same connection, different database name. */
function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** Probes CREATE/DROP DATABASE so the suite skips (not fails) on a role that
 * lacks the privilege, mirroring the DATABASE_URL skip in the constraint tests. */
async function canProvisionDatabases(url: string): Promise<boolean> {
  const admin = postgres(withDatabase(url, "postgres"), { max: 1 });
  const probe = `berry_probe_${crypto.randomUUID().replace(/-/g, "")}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${probe}"`);
    await admin.unsafe(`DROP DATABASE "${probe}"`);
    return true;
  } catch {
    return false;
  } finally {
    await admin.end();
  }
}

const canRun = databaseUrl ? await canProvisionDatabases(databaseUrl) : false;
const describeIf = canRun ? describe : describe.skip;

/** A drizzle migrations folder containing only 0000, so the migrator applies it
 * alone; a later run against the real folder then applies only 0001. */
function folderWith0000Only(): string {
  const dir = mkdtempSync(join(tmpdir(), "berry-mig-"));
  mkdirSync(join(dir, "meta"), { recursive: true });
  cpSync(join(realDir, "0000_init.sql"), join(dir, "0000_init.sql"));
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: 1787364221223,
          tag: "0000_init",
          breakpoints: true,
        },
      ],
    }),
  );
  return dir;
}

describeIf("migration 0001 upgrade path (pre-fix data)", () => {
  const adminUrl = withDatabase(databaseUrl ?? "", "postgres");

  async function createDatabase(): Promise<string> {
    const name = `berry_upgrade_${crypto.randomUUID().replace(/-/g, "")}`;
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    return name;
  }

  async function dropDatabase(name: string): Promise<void> {
    const admin = postgres(adminUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }

  test("0001 applies over pre-fix data and remediates each violation", async () => {
    const dbName = await createDatabase();
    const client = postgres(withDatabase(databaseUrl ?? "", dbName), {
      max: 1,
    });
    const db = drizzle(client);
    try {
      await migrate(db, { migrationsFolder: folderWith0000Only() });

      // Rows 0000 allowed but the 0001 constraints forbid — no email dupes,
      // which are the one violation 0001 deliberately refuses to auto-fix.
      const boardId = crypto.randomUUID();
      const parentIssue = crypto.randomUUID();
      const danglingComment = crypto.randomUUID();
      await client.unsafe(
        `INSERT INTO boards (id, name, slug, columns) VALUES ('${boardId}', 'B', 'b', '{"not":"an array"}'::jsonb)`,
      );
      await client.unsafe(
        `INSERT INTO issues (board_id, number, title, assignee_type, assignee_id) VALUES ('${boardId}', 1, 'half', 'agent', NULL)`,
      );
      await client.unsafe(
        `INSERT INTO issues (id, board_id, number, title) VALUES ('${parentIssue}', '${boardId}', 2, 'host')`,
      );
      await client.unsafe(
        `INSERT INTO comments (id, issue_id, author_type, author_id, body, parent_id) VALUES ('${danglingComment}', '${parentIssue}', 'user', '${crypto.randomUUID()}', 'orphan', 'ffffffff-ffff-ffff-ffff-ffffffffffff')`,
      );

      // The migration under test: applies 0001 on top of the legacy data.
      await migrate(db, { migrationsFolder: realDir });

      const [comment] = await client`SELECT parent_id FROM comments WHERE id = ${danglingComment}`;
      expect(comment?.parent_id).toBeNull();

      const [issue] =
        await client`SELECT assignee_type, assignee_id FROM issues WHERE board_id = ${boardId} AND number = 1`;
      expect(issue?.assignee_type).toBeNull();
      expect(issue?.assignee_id).toBeNull();

      const [board] = await client`SELECT columns FROM boards WHERE id = ${boardId}`;
      expect(board?.columns).toEqual([]);

      // And the constraints that forced the remediation are now in place.
      const constraints =
        await client`SELECT conname FROM pg_constraint WHERE conname IN ('comments_parent_id_comments_id_fk', 'issues_assignee_pair_ck', 'boards_columns_is_array')`;
      expect(constraints.length).toBe(3);
    } finally {
      await client.end();
      await dropDatabase(dbName);
    }
  });

  test("0001 refuses case-duplicate emails and rolls back atomically", async () => {
    const dbName = await createDatabase();
    const client = postgres(withDatabase(databaseUrl ?? "", dbName), {
      max: 1,
    });
    const db = drizzle(client);
    try {
      await migrate(db, { migrationsFolder: folderWith0000Only() });
      await client`INSERT INTO users (email, name) VALUES ('Ann@Berry.dev', 'A'), ('ann@berry.dev', 'B')`;

      let raised: unknown;
      try {
        await migrate(db, { migrationsFolder: realDir });
      } catch (err) {
        raised = err;
      }
      // Fails loudly, naming the colliding address rather than silently merging.
      expect(String(raised)).toContain("ann@berry.dev");

      // Atomic: nothing from 0001 partially applied.
      const counterCol =
        await client`SELECT 1 FROM information_schema.columns WHERE table_name = 'boards' AND column_name = 'issue_counter'`;
      expect(counterCol.length).toBe(0);
      const applied = await client`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      expect(applied[0]?.n).toBe(1);
    } finally {
      await client.end();
      await dropDatabase(dbName);
    }
  });
});
