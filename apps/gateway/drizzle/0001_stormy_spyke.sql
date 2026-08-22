DROP INDEX IF EXISTS "users_email_key";--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "issue_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill issue_counter from the highest existing number per board. 0000 allowed
-- boards to already hold issues numbered 1..N; without this the DEFAULT 0 counter
-- re-hands out 1, which collides with issue #1 on issues_board_number_key and,
-- because the bump shares the insert's transaction, permanently wedges that board's
-- issue creation. No-op on greenfield boards (max() is NULL -> COALESCE 0 = default).
UPDATE "boards" AS "b" SET "issue_counter" = COALESCE(
  (SELECT max("i"."number") FROM "issues" "i" WHERE "i"."board_id" = "b"."id"),
  0
);--> statement-breakpoint
-- Backend PR Adversary re-review BLOCKER: 0001 must be applicable to a database
-- that already holds the data 0000 permitted. Each constraint added below forbids
-- a state that 0000 explicitly allowed, so remediate the pre-existing violations
-- first. Every remediation statement here is a no-op on clean data.
--
-- Dangling comment parents: 0000 let parent_id reference a row that never existed.
-- Null those out so the self-referencing FK can be added.
UPDATE "comments" AS "c" SET "parent_id" = NULL
WHERE "c"."parent_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "comments" "p" WHERE "p"."id" = "c"."parent_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_parent_id_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
-- Case-duplicate emails must NOT be silently merged: two distinct accounts may sit
-- behind them. Fail loudly and name the collisions so an operator resolves them by
-- hand before this migration is re-run. No-op when there are none.
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg("le", ', ' ORDER BY "le") INTO dupes
  FROM (
    SELECT lower("email") AS "le"
    FROM "users"
    GROUP BY lower("email")
    HAVING count(*) > 1
  ) "d";
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0001 cannot create the case-insensitive unique index on users.email: these addresses collide case-insensitively and must be merged or renamed by hand first: %', dupes;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
-- Non-array boards.columns: 0000 allowed any jsonb value. A non-array already
-- violates the BoardColumn[] contract, so reset it to the schema default before
-- adding the array CHECK.
UPDATE "boards" SET "columns" = '[]'::jsonb
WHERE jsonb_typeof("columns") IS DISTINCT FROM 'array';--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_columns_is_array" CHECK (jsonb_typeof("boards"."columns") = 'array');--> statement-breakpoint
-- Half-populated issue assignees: 0000 allowed exactly one of (type, id) to be set.
-- Coerce those rows to fully unassigned before adding the both-or-neither CHECK.
UPDATE "issues" SET "assignee_type" = NULL, "assignee_id" = NULL
WHERE ("assignee_type" IS NULL) <> ("assignee_id" IS NULL);--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_pair_ck" CHECK (("issues"."assignee_type" IS NULL AND "issues"."assignee_id" IS NULL) OR ("issues"."assignee_type" IS NOT NULL AND "issues"."assignee_id" IS NOT NULL));--> statement-breakpoint

-- Backend PR Adversary BLOCKER #3: updated_at only ever reflected INSERT time
-- because defaultNow() has no ON UPDATE equivalent in Postgres. Add a shared
-- trigger function and attach it to every table carrying updated_at.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS users_set_updated_at ON "users";--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS boards_set_updated_at ON "boards";--> statement-breakpoint
CREATE TRIGGER boards_set_updated_at BEFORE UPDATE ON "boards"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS issues_set_updated_at ON "issues";--> statement-breakpoint
CREATE TRIGGER issues_set_updated_at BEFORE UPDATE ON "issues"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS comments_set_updated_at ON "comments";--> statement-breakpoint
CREATE TRIGGER comments_set_updated_at BEFORE UPDATE ON "comments"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
