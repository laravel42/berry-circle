-- name: Ping :one
SELECT 1::integer;

-- name: NextIssueNumber :one
UPDATE boards
SET issue_counter = issue_counter + 1
WHERE id = sqlc.arg(board_id)
RETURNING issue_counter;

-- name: GetMigrationChecksum :one
SELECT checksum
FROM berry_schema_migrations
WHERE version = sqlc.arg(version);
