package migrations

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/repository/core"
	runrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
)

// Migration 019 separates the two meanings outbox_events.workspace_id used to
// carry. This test seeds one row per writer lane the way each lane wrote it
// before 019, applies the migration, and checks that every row ends up with a
// real workspace in workspace_id and its board in board_id — and that the
// board replay, which now filters on board_id, finally returns comment.created.
func TestOutboxScopeBackfillMatrixAndBoardReplay(t *testing.T) {
	databaseURL := os.Getenv("BERRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BERRY_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open BERRY_TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(admin.Close)
	if err := admin.Ping(ctx); err != nil {
		t.Fatalf("ping BERRY_TEST_DATABASE_URL: %v", err)
	}

	schema := "berry_outbox_" + uuid.NewString()[:8]
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create isolated schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse BERRY_TEST_DATABASE_URL: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open isolated pool: %v", err)
	}
	t.Cleanup(pool.Close)

	all, err := List()
	if err != nil {
		t.Fatalf("list migrations: %v", err)
	}
	const scopeVersion = 19
	if all[scopeVersion].Name != "019_outbox_scope.up.sql" {
		t.Fatalf("migration %d = %q, want 019_outbox_scope.up.sql", scopeVersion, all[scopeVersion].Name)
	}
	for _, migration := range all[:scopeVersion] {
		if _, err := pool.Exec(ctx, migration.SQL); err != nil {
			t.Fatalf("apply prerequisite %s: %v", migration.Name, err)
		}
	}

	now := time.Date(2026, time.August, 25, 9, 0, 0, 0, time.UTC)
	userID := uuid.New()
	workspaceID := uuid.New()
	foreignWorkspaceID := uuid.New()
	boardID := uuid.New()
	issueID := uuid.New()
	commentID := uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, 'Outbox Scope', 'admin')`,
		userID, fmt.Sprintf("%s@berry.test", userID))
	exec(`INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Scope', $2, $3)`,
		workspaceID, "scope-"+workspaceID.String()[:8], userID)
	exec(`INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Elsewhere', $2, $3)`,
		foreignWorkspaceID, "else-"+foreignWorkspaceID.String()[:8], userID)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
		workspaceID, userID)
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by) VALUES ($1, $2, 'Scope', $3, $4)`,
		boardID, workspaceID, "b"+boardID.String()[:8], userID)
	exec(`INSERT INTO issues (id, board_id, number, title, status, priority, sort_order, created_by)
	      VALUES ($1, $2, 1, 'Scoped', 'todo', 'none', 1000, $3)`, issueID, boardID, userID)
	exec(`INSERT INTO comments (id, issue_id, author_type, author_id, body)
	      VALUES ($1, $2, 'user', $3, 'first')`, commentID, issueID, userID)

	// One row per lane, written exactly as that lane wrote it before 019.
	type seed struct {
		name          string
		topic         string
		aggregateType string
		aggregateID   uuid.UUID
		workspaceID   uuid.UUID // what the writer put in the column
		envelope      map[string]any
		wantWorkspace uuid.UUID
		wantBoard     *uuid.UUID
	}
	runID := uuid.New()
	attachmentID := uuid.New()
	seeds := []seed{
		{
			name: "run lane run row", topic: "run.started", aggregateType: "run",
			aggregateID: runID, workspaceID: boardID,
			envelope: map[string]any{
				"boardId": boardID, "issueId": issueID, "runId": runID, "sequence": 1,
				"payload": map[string]any{"startedAt": now.Format(time.RFC3339Nano)},
			},
			wantWorkspace: workspaceID, wantBoard: &boardID,
		},
		{
			name: "run lane issue row", topic: "issue.updated", aggregateType: "issue",
			aggregateID: issueID, workspaceID: boardID,
			envelope: map[string]any{
				"boardId": boardID, "issueId": issueID, "runId": runID, "sequence": nil,
				"payload": map[string]any{"changedFields": []string{"status"}},
			},
			wantWorkspace: workspaceID, wantBoard: &boardID,
		},
		{
			name: "comment lane", topic: "comment.created", aggregateType: "comment",
			aggregateID: commentID, workspaceID: workspaceID,
			envelope: map[string]any{
				"workspaceId": workspaceID, "aggregateType": "comment", "aggregateId": commentID,
				"payload": map[string]any{"comment": map[string]any{"id": commentID, "issueId": issueID}},
			},
			wantWorkspace: workspaceID, wantBoard: &boardID,
		},
		{
			name: "collaboration attachment", topic: "attachment.created", aggregateType: "attachment",
			aggregateID: attachmentID, workspaceID: workspaceID,
			envelope: map[string]any{
				"workspaceId": workspaceID, "aggregateType": "attachment", "aggregateId": attachmentID,
				"payload": map[string]any{"attachmentId": attachmentID, "issueId": issueID},
			},
			wantWorkspace: workspaceID, wantBoard: &boardID,
		},
		{
			name: "collaboration subscriber", topic: "issue.subscriber.added", aggregateType: "issue",
			aggregateID: issueID, workspaceID: workspaceID,
			envelope: map[string]any{
				"workspaceId": workspaceID, "aggregateType": "issue", "aggregateId": issueID,
				"payload": map[string]any{"issueId": issueID, "userId": userID},
			},
			wantWorkspace: workspaceID, wantBoard: &boardID,
		},
		{
			name: "board-less row in another workspace", topic: "comment.created", aggregateType: "comment",
			aggregateID: uuid.New(), workspaceID: foreignWorkspaceID,
			envelope: map[string]any{
				"workspaceId": foreignWorkspaceID, "aggregateType": "comment",
				"payload": map[string]any{},
			},
			wantWorkspace: foreignWorkspaceID, wantBoard: nil,
		},
	}
	ids := make([]uuid.UUID, len(seeds))
	for index, row := range seeds {
		ids[index] = uuid.New()
		row.envelope["id"] = ids[index]
		row.envelope["type"] = row.topic
		row.envelope["occurredAt"] = now.Add(time.Duration(index) * time.Second).Format(time.RFC3339Nano)
		encoded, err := json.Marshal(row.envelope)
		if err != nil {
			t.Fatalf("encode %s envelope: %v", row.name, err)
		}
		exec(`INSERT INTO outbox_events (
		        id, topic, aggregate_type, aggregate_id, workspace_id,
		        payload, occurred_at, available_at
		      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)`,
			ids[index], row.topic, row.aggregateType, row.aggregateID, row.workspaceID,
			string(encoded), now.Add(time.Duration(index)*time.Second))
	}

	if _, err := pool.Exec(ctx, all[scopeVersion].SQL); err != nil {
		t.Fatalf("apply %s: %v", all[scopeVersion].Name, err)
	}

	for index, row := range seeds {
		var (
			gotWorkspace *uuid.UUID
			gotBoard     *uuid.UUID
		)
		if err := pool.QueryRow(
			ctx,
			`SELECT workspace_id, board_id FROM outbox_events WHERE id = $1`,
			ids[index],
		).Scan(&gotWorkspace, &gotBoard); err != nil {
			t.Fatalf("read %s: %v", row.name, err)
		}
		if gotWorkspace == nil || *gotWorkspace != row.wantWorkspace {
			t.Errorf("%s: workspace_id = %v, want %s", row.name, gotWorkspace, row.wantWorkspace)
		}
		switch {
		case row.wantBoard == nil && gotBoard != nil:
			t.Errorf("%s: board_id = %s, want NULL", row.name, *gotBoard)
		case row.wantBoard != nil && (gotBoard == nil || *gotBoard != *row.wantBoard):
			t.Errorf("%s: board_id = %v, want %s", row.name, gotBoard, *row.wantBoard)
		}
	}
	for _, index := range []string{
		"outbox_events_board_replay_idx",
		"outbox_events_trigger_dispatch_order_idx",
		"outbox_events_inbox_projection_order_idx",
	} {
		var name string
		if err := pool.QueryRow(
			ctx,
			`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
			schema, index,
		).Scan(&name); err != nil {
			t.Errorf("index %s missing after 019: %v", index, err)
		}
	}

	// The board replay reads board_id now, so the backfilled comment is on it.
	replay := &runrepo.Repository{Pool: pool}
	events, err := replay.ListBoardEvents(ctx, boardID, nil, now.Add(-time.Hour), 50)
	if err != nil {
		t.Fatalf("ListBoardEvents() error = %v", err)
	}
	seen := make(map[string]runrepo.Event, len(events))
	for _, event := range events {
		seen[event.Type] = event
	}
	for _, topic := range []string{"run.started", "issue.updated", "comment.created"} {
		event, ok := seen[topic]
		if !ok {
			t.Errorf("board replay lacks %s; got %d events", topic, len(events))
			continue
		}
		if event.WorkspaceID != workspaceID || event.BoardID != boardID || event.IssueID != issueID {
			t.Errorf("%s scope = workspace %s board %s issue %s", topic, event.WorkspaceID, event.BoardID, event.IssueID)
		}
	}
	if _, ok := seen["attachment.created"]; ok {
		t.Error("board replay carries attachment.created, which is not a board stream topic")
	}

	// A comment written after 019 carries its board from the start.
	comments := &core.Repository{Pool: pool}
	freshID, freshEventID := uuid.New(), uuid.New()
	if _, event, err := comments.CreateComment(ctx, core.CreateCommentParams{
		ID:        freshID,
		IssueID:   issueID,
		AuthorID:  userID,
		Body:      "after the migration",
		CreatedAt: now.Add(time.Minute),
	}, freshEventID); err != nil {
		t.Fatalf("CreateComment() error = %v", err)
	} else if event.BoardID != boardID || event.WorkspaceID != workspaceID {
		t.Fatalf("fresh comment event scope = %#v", event)
	}
	var freshBoard *uuid.UUID
	if err := pool.QueryRow(
		ctx, `SELECT board_id FROM outbox_events WHERE id = $1`, freshEventID,
	).Scan(&freshBoard); err != nil || freshBoard == nil || *freshBoard != boardID {
		t.Fatalf("fresh comment board_id = %v (err %v), want %s", freshBoard, err, boardID)
	}
	events, err = replay.ListBoardEvents(ctx, boardID, nil, now.Add(-time.Hour), 50)
	if err != nil {
		t.Fatalf("ListBoardEvents() after fresh comment error = %v", err)
	}
	found := false
	for _, event := range events {
		if event.ID == freshEventID && event.Type == "comment.created" && event.IssueID == issueID {
			found = true
		}
	}
	if !found {
		t.Fatalf("fresh comment.created missing from board replay of %d events", len(events))
	}
}
