DROP INDEX IF EXISTS "users_email_key";--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "issue_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_parent_id_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_columns_is_array" CHECK (jsonb_typeof("boards"."columns") = 'array');--> statement-breakpoint
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