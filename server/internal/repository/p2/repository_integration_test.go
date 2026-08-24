package p2

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/migrations"
)

func TestP2MigrationQueriesAndProjectorAgainstPostgres(t *testing.T) {
	pool := openP2TestDatabase(t, false)
	ctx := context.Background()
	repository, err := New(pool)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	repository.StatementTimeout = 5 * time.Second

	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	userID, otherUserID := uuid.New(), uuid.New()
	workspaceID, boardID := uuid.New(), uuid.New()
	seedP2Workspace(
		t,
		pool,
		now,
		userID,
		otherUserID,
		workspaceID,
		boardID,
	)

	issueIDs := verifyThousandAndOneIssuePagination(
		t,
		repository,
		pool,
		now,
		userID,
		workspaceID,
		boardID,
	)
	verifySavedViewsAndPins(
		t,
		repository,
		now,
		userID,
		otherUserID,
		workspaceID,
		issueIDs,
	)
	verifyProjectorIdempotency(
		t,
		repository,
		pool,
		now,
		userID,
		otherUserID,
		workspaceID,
		issueIDs[0],
	)
	verifyBatchIssueSeams(
		t,
		repository,
		now,
		workspaceID,
		issueIDs[0],
		issueIDs[len(issueIDs)-1],
	)

	var invalidCategoryAccepted bool
	err = pool.QueryRow(
		ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM pg_constraint
			WHERE conrelid = 'inbox_items'::regclass
			  AND pg_get_constraintdef(oid) LIKE '%agentActivity%'
		)`,
	).Scan(&invalidCategoryAccepted)
	if err != nil {
		t.Fatalf("inspect inbox category constraint: %v", err)
	}
	if !invalidCategoryAccepted {
		t.Fatal("inbox category constraint was not installed")
	}
}

func TestP2MigrationAppliesAfterParallelP2Migrations(t *testing.T) {
	pool := openP2TestDatabase(t, true)
	var tableName string
	if err := pool.QueryRow(
		context.Background(),
		"SELECT 'saved_issue_views'::regclass::text",
	).Scan(&tableName); err != nil {
		t.Fatalf("resolve saved_issue_views after full migration order: %v", err)
	}
	if tableName != "saved_issue_views" {
		t.Fatalf("table name = %q", tableName)
	}
}

func verifyBatchIssueSeams(
	t *testing.T,
	repository *Repository,
	now time.Time,
	workspaceID, updateID, deleteID uuid.UUID,
) {
	t.Helper()
	ctx := context.Background()
	status, priority := "inProgress", "high"
	missingUpdateID := uuid.New()
	updated, err := repository.BatchUpdateIssues(
		ctx,
		workspaceID,
		[]uuid.UUID{updateID, missingUpdateID},
		BatchIssuePatch{Status: &status, Priority: &priority},
		now.Add(time.Minute),
	)
	if err != nil {
		t.Fatalf("BatchUpdateIssues() error = %v", err)
	}
	if len(updated) != 2 || updated[0].Outcome != "updated" ||
		updated[1].ID != missingUpdateID || updated[1].Outcome != "notFound" {
		t.Fatalf("BatchUpdateIssues() results = %#v", updated)
	}
	missingDeleteID := uuid.New()
	deleted, err := repository.BatchDeleteIssues(
		ctx,
		workspaceID,
		[]uuid.UUID{deleteID, missingDeleteID},
	)
	if err != nil {
		t.Fatalf("BatchDeleteIssues() error = %v", err)
	}
	if len(deleted) != 2 || deleted[0].Outcome != "deleted" ||
		deleted[1].ID != missingDeleteID || deleted[1].Outcome != "notFound" {
		t.Fatalf("BatchDeleteIssues() results = %#v", deleted)
	}
}

func verifyThousandAndOneIssuePagination(
	t *testing.T,
	repository *Repository,
	pool *pgxpool.Pool,
	now time.Time,
	userID, workspaceID, boardID uuid.UUID,
) []uuid.UUID {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO issues (
			id, board_id, number, title, status, priority,
			assignee_type, assignee_id, created_by, created_at, updated_at
		 )
		 SELECT gen_random_uuid(), $1, value,
		        'P2 issue ' || lpad(value::text, 4, '0'),
		        'todo', 'medium', 'user', $2, $2, $3, $3
		   FROM generate_series(1, 1001) AS value`,
		boardID,
		userID,
		now,
	); err != nil {
		t.Fatalf("seed 1,001 issues: %v", err)
	}

	filter := IssueFilter{AssignedToMe: true, UserID: userID}
	seen := make(map[uuid.UUID]struct{}, 1001)
	ordered := make([]uuid.UUID, 0, 1001)
	var after *IssueRowCursor
	for {
		rows, err := repository.ListIssueRows(
			ctx,
			workspaceID,
			filter,
			"none",
			"",
			after,
			100,
		)
		if err != nil {
			t.Fatalf("ListIssueRows() error = %v", err)
		}
		for _, row := range rows {
			if _, exists := seen[row.ID]; exists {
				t.Fatalf("duplicate paginated issue %s", row.ID)
			}
			seen[row.ID] = struct{}{}
			ordered = append(ordered, row.ID)
		}
		if len(rows) < 100 {
			break
		}
		last := rows[len(rows)-1]
		after = &IssueRowCursor{UpdatedAt: last.UpdatedAt, ID: last.ID}
	}
	if len(ordered) != 1001 {
		t.Fatalf("paginated issue count = %d, want 1001", len(ordered))
	}

	groups, err := repository.ListIssueGroups(
		ctx,
		workspaceID,
		filter,
		"status",
		nil,
		10,
	)
	if err != nil {
		t.Fatalf("ListIssueGroups() error = %v", err)
	}
	if len(groups) != 1 || groups[0].Key != "todo" || groups[0].Count != 1001 {
		t.Fatalf("groups = %#v", groups)
	}
	facets, err := repository.ListIssueFacets(ctx, workspaceID, filter)
	if err != nil {
		t.Fatalf("ListIssueFacets() error = %v", err)
	}
	if len(facets) == 0 {
		t.Fatal("ListIssueFacets() returned no facets")
	}
	results, err := repository.Search(ctx, workspaceID, SearchFilter{
		Query: "P2 issue 0001",
		Types: []string{"issue", "board"},
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(results) == 0 || results[0].Type != "issue" {
		t.Fatalf("search results = %#v", results)
	}
	verifyIssueGroupCursorPagination(
		t,
		repository,
		pool,
		workspaceID,
		boardID,
		filter,
	)
	return ordered
}

func verifyIssueGroupCursorPagination(
	t *testing.T,
	repository *Repository,
	pool *pgxpool.Pool,
	workspaceID, boardID uuid.UUID,
	filter IssueFilter,
) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(
		ctx,
		`UPDATE issues
		    SET status = CASE
		        WHEN number <= 333 THEN 'in_progress'::issue_status
		        WHEN number <= 666 THEN 'in_review'::issue_status
		        ELSE 'backlog'::issue_status
		    END
		  WHERE board_id = $1`,
		boardID,
	); err != nil {
		t.Fatalf("seed grouped issue statuses: %v", err)
	}
	keys := make([]string, 0, 3)
	var after *IssueGroupCursor
	for len(keys) < 3 {
		groups, err := repository.ListIssueGroups(
			ctx,
			workspaceID,
			filter,
			"status",
			after,
			1,
		)
		if err != nil {
			t.Fatalf("ListIssueGroups(cursor) error = %v", err)
		}
		if len(groups) != 1 {
			t.Fatalf("group page %d = %#v", len(keys)+1, groups)
		}
		keys = append(keys, groups[0].Key)
		after = &IssueGroupCursor{Count: groups[0].Count, Key: groups[0].Key}
	}
	want := []string{"backlog", "inProgress", "inReview"}
	for index := range want {
		if keys[index] != want[index] {
			t.Fatalf("group keys = %#v, want %#v", keys, want)
		}
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE issues SET status = 'todo' WHERE board_id = $1",
		boardID,
	); err != nil {
		t.Fatalf("restore issue statuses: %v", err)
	}
}

func verifySavedViewsAndPins(
	t *testing.T,
	repository *Repository,
	now time.Time,
	userID, otherUserID, workspaceID uuid.UUID,
	issueIDs []uuid.UUID,
) {
	t.Helper()
	ctx := context.Background()
	view, err := repository.CreateSavedView(ctx, CreateSavedViewParams{
		ID:                uuid.New(),
		WorkspaceID:       workspaceID,
		OwnerID:           userID,
		Name:              "Assigned to me",
		Visibility:        "private",
		DefinitionVersion: 1,
		Query:             json.RawMessage(`{"assignedToMe":true}`),
		Display:           json.RawMessage(`{"groupBy":"status"}`),
		CreatedAt:         now,
	})
	if err != nil {
		t.Fatalf("CreateSavedView() error = %v", err)
	}
	if _, err := repository.GetSavedView(
		ctx,
		workspaceID,
		otherUserID,
		view.ID,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user private GetSavedView() error = %v", err)
	}
	if _, err := repository.PutViewPreference(
		ctx,
		workspaceID,
		userID,
		&view.ID,
		json.RawMessage(`{"density":"compact"}`),
		now,
	); err != nil {
		t.Fatalf("PutViewPreference() error = %v", err)
	}
	firstPin, _, err := repository.CreatePin(
		ctx,
		uuid.New(),
		workspaceID,
		userID,
		"view",
		view.ID,
		now,
	)
	if err != nil {
		t.Fatalf("CreatePin(view) error = %v", err)
	}
	secondPin, _, err := repository.CreatePin(
		ctx,
		uuid.New(),
		workspaceID,
		userID,
		"issue",
		issueIDs[0],
		now,
	)
	if err != nil {
		t.Fatalf("CreatePin(issue) error = %v", err)
	}
	if err := repository.ReorderPins(
		ctx,
		workspaceID,
		userID,
		[]uuid.UUID{secondPin.ID, firstPin.ID},
	); err != nil {
		t.Fatalf("ReorderPins() error = %v", err)
	}
	if err := repository.DeleteSavedView(ctx, workspaceID, userID, view.ID); err != nil {
		t.Fatalf("DeleteSavedView() error = %v", err)
	}
	thirdPin, replayed, err := repository.CreatePin(
		ctx,
		uuid.New(),
		workspaceID,
		userID,
		"issue",
		issueIDs[1],
		now,
	)
	if err != nil {
		t.Fatalf("CreatePin(after view deletion) error = %v", err)
	}
	if replayed || thirdPin.Position != 1 {
		t.Fatalf("pin replayed=%t position=%d, want false/1", replayed, thirdPin.Position)
	}
	pins, err := repository.ListPins(ctx, workspaceID, userID)
	if err != nil {
		t.Fatalf("ListPins() error = %v", err)
	}
	if len(pins) != 2 || pins[0].Position != 0 || pins[1].Position != 1 {
		t.Fatalf("pins after compaction = %#v", pins)
	}
	otherPins, err := repository.ListPins(ctx, workspaceID, otherUserID)
	if err != nil {
		t.Fatalf("ListPins(other) error = %v", err)
	}
	if len(otherPins) != 0 {
		t.Fatalf("other user's pins = %#v", otherPins)
	}
}

func verifyProjectorIdempotency(
	t *testing.T,
	repository *Repository,
	pool *pgxpool.Pool,
	now time.Time,
	userID, otherUserID, workspaceID, issueID uuid.UUID,
) {
	t.Helper()
	ctx := context.Background()
	preferences := json.RawMessage(
		`{"inApp":{"assignments":true,"statusChanges":true,"comments":false,` +
			`"mentions":true,"updates":true,"agentActivity":true}}`,
	)
	if _, err := repository.PutNotificationPreferences(
		ctx,
		workspaceID,
		userID,
		preferences,
		now,
	); err != nil {
		t.Fatalf("PutNotificationPreferences() error = %v", err)
	}
	storedPreferences, err := repository.GetNotificationPreferences(
		ctx,
		workspaceID,
		userID,
	)
	if err != nil || !json.Valid(storedPreferences.Preferences) {
		t.Fatalf(
			"GetNotificationPreferences() = %s, %v",
			storedPreferences.Preferences,
			err,
		)
	}
	eventID, actorID := uuid.New(), uuid.New()
	payload, err := json.Marshal(map[string]any{
		"payload": map[string]any{
			"actor": map[string]any{
				"type": "agent",
				"id":   actorID,
			},
			"changedFields": []string{"status"},
		},
	})
	if err != nil {
		t.Fatalf("encode projection payload: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO outbox_events (
			id, topic, aggregate_type, aggregate_id, workspace_id,
			payload, occurred_at, available_at
		 ) VALUES ($1, 'issue.updated', 'issue', $2, $3, $4::jsonb, $5, $5)`,
		eventID,
		issueID,
		workspaceID,
		string(payload),
		now,
	); err != nil {
		t.Fatalf("seed outbox event: %v", err)
	}
	first, err := repository.ProjectInboxBatch(ctx, uuid.New, func() time.Time {
		return now.Add(time.Second)
	}, 10)
	if err != nil {
		t.Fatalf("ProjectInboxBatch(first) error = %v", err)
	}
	second, err := repository.ProjectInboxBatch(ctx, uuid.New, func() time.Time {
		return now.Add(2 * time.Second)
	}, 10)
	if err != nil {
		t.Fatalf("ProjectInboxBatch(second) error = %v", err)
	}
	if first.Events != 1 || first.Items != 1 ||
		second.Events != 0 || second.Items != 0 {
		t.Fatalf("projection results first=%#v second=%#v", first, second)
	}
	commentID, commentEventID := uuid.New(), uuid.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO comments (
			id, issue_id, author_type, author_id, body, created_at, updated_at
		 ) VALUES ($1, $2, 'agent', $3, 'Suppressed comment', $4, $4)`,
		commentID,
		issueID,
		actorID,
		now,
	); err != nil {
		t.Fatalf("seed projected comment: %v", err)
	}
	commentPayload, err := json.Marshal(map[string]any{
		"payload": map[string]any{
			"comment": map[string]any{
				"author": map[string]any{
					"type": "agent",
					"id":   actorID,
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("encode comment projection payload: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO outbox_events (
			id, topic, aggregate_type, aggregate_id, workspace_id,
			payload, occurred_at, available_at
		 ) VALUES ($1, 'comment.created', 'comment', $2, $3, $4::jsonb, $5, $5)`,
		commentEventID,
		commentID,
		workspaceID,
		string(commentPayload),
		now.Add(time.Second),
	); err != nil {
		t.Fatalf("seed comment outbox event: %v", err)
	}
	suppressed, err := repository.ProjectInboxBatch(ctx, uuid.New, func() time.Time {
		return now.Add(2 * time.Second)
	}, 10)
	if err != nil {
		t.Fatalf("ProjectInboxBatch(suppressed) error = %v", err)
	}
	suppressedReplay, err := repository.ProjectInboxBatch(ctx, uuid.New, func() time.Time {
		return now.Add(3 * time.Second)
	}, 10)
	if err != nil {
		t.Fatalf("ProjectInboxBatch(suppressed replay) error = %v", err)
	}
	if suppressed.Events != 1 || suppressed.Items != 0 ||
		suppressedReplay.Events != 0 {
		t.Fatalf(
			"suppressed projections first=%#v replay=%#v",
			suppressed,
			suppressedReplay,
		)
	}
	items, err := repository.ListInbox(ctx, workspaceID, userID, InboxFilter{
		State: "active",
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListInbox(recipient) error = %v", err)
	}
	if len(items) != 1 || items[0].SourceEventID == nil ||
		*items[0].SourceEventID != eventID {
		t.Fatalf("recipient items = %#v", items)
	}
	itemID := items[0].ID
	unread, err := repository.CountUnreadInbox(ctx, workspaceID, userID)
	if err != nil || unread != 1 {
		t.Fatalf("CountUnreadInbox() = %d, %v, want 1", unread, err)
	}
	if _, err := repository.UpdateInboxItem(
		ctx,
		workspaceID,
		otherUserID,
		itemID,
		"read",
		now,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other recipient UpdateInboxItem() error = %v", err)
	}
	if _, err := repository.UpdateInboxItem(
		ctx,
		workspaceID,
		userID,
		itemID,
		"read",
		now,
	); err != nil {
		t.Fatalf("UpdateInboxItem(read) error = %v", err)
	}
	unread, err = repository.CountUnreadInbox(ctx, workspaceID, userID)
	if err != nil || unread != 0 {
		t.Fatalf("read CountUnreadInbox() = %d, %v, want 0", unread, err)
	}
	if updated, err := repository.BulkUpdateInbox(
		ctx,
		workspaceID,
		userID,
		[]uuid.UUID{itemID},
		"unread",
		now,
	); err != nil || len(updated) != 1 || updated[0] != itemID {
		t.Fatalf("BulkUpdateInbox(unread) = %#v, %v", updated, err)
	}
	if _, err := repository.BulkUpdateInbox(
		ctx,
		workspaceID,
		userID,
		[]uuid.UUID{itemID},
		"archive",
		now,
	); err != nil {
		t.Fatalf("BulkUpdateInbox(archive) error = %v", err)
	}
	archived, err := repository.ListInbox(ctx, workspaceID, userID, InboxFilter{
		State: "archived",
		Limit: 10,
	})
	if err != nil || len(archived) != 1 || archived[0].ID != itemID {
		t.Fatalf("archived inbox = %#v, %v", archived, err)
	}
	otherItems, err := repository.ListInbox(ctx, workspaceID, otherUserID, InboxFilter{
		State: "active",
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListInbox(other) error = %v", err)
	}
	if len(otherItems) != 0 {
		t.Fatalf("other recipient items = %#v", otherItems)
	}
	var receipts, projectedItems int
	if err := pool.QueryRow(
		ctx,
		"SELECT count(*) FROM inbox_projection_events WHERE event_id = $1",
		eventID,
	).Scan(&receipts); err != nil {
		t.Fatalf("count projection receipts: %v", err)
	}
	if err := pool.QueryRow(
		ctx,
		"SELECT count(*) FROM inbox_items WHERE source_event_id = $1",
		eventID,
	).Scan(&projectedItems); err != nil {
		t.Fatalf("count projected inbox items: %v", err)
	}
	if receipts != 1 || projectedItems != 1 {
		t.Fatalf("receipts=%d items=%d, want 1/1", receipts, projectedItems)
	}
	var suppressedOutcome string
	var suppressedItems int
	if err := pool.QueryRow(
		ctx,
		`SELECT outcome, inbox_count
		   FROM inbox_projection_events
		  WHERE event_id = $1`,
		commentEventID,
	).Scan(&suppressedOutcome, &suppressedItems); err != nil {
		t.Fatalf("read suppressed projection receipt: %v", err)
	}
	if suppressedOutcome != "suppressed" || suppressedItems != 0 {
		t.Fatalf(
			"suppressed receipt outcome=%q items=%d",
			suppressedOutcome,
			suppressedItems,
		)
	}
}

func seedP2Workspace(
	t *testing.T,
	pool *pgxpool.Pool,
	now time.Time,
	userID, otherUserID, workspaceID, boardID uuid.UUID,
) {
	t.Helper()
	ctx := context.Background()
	for _, user := range []struct {
		id   uuid.UUID
		name string
	}{
		{userID, "P2 Recipient"},
		{otherUserID, "P2 Other Member"},
	} {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO users (id, email, name, role, created_at, updated_at)
			 VALUES ($1, $2, $3, 'member', $4, $4)`,
			user.id,
			fmt.Sprintf("%s@berry.test", user.id),
			user.name,
			now,
		); err != nil {
			t.Fatalf("seed user: %v", err)
		}
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspaces (
			id, name, slug, created_by, created_at, updated_at
		 ) VALUES ($1, 'P2 Workspace', $2, $3, $4, $4)`,
		workspaceID,
		"p2-"+workspaceID.String()[:8],
		userID,
		now,
	); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	for index, memberID := range []uuid.UUID{userID, otherUserID} {
		role := "member"
		if index == 0 {
			role = "owner"
		}
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO workspace_memberships (
				workspace_id, user_id, role, joined_at, updated_at
			 ) VALUES ($1, $2, $3, $4, $4)`,
			workspaceID,
			memberID,
			role,
			now,
		); err != nil {
			t.Fatalf("seed membership: %v", err)
		}
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO boards (
			id, workspace_id, name, slug, columns, created_by,
			created_at, updated_at
		 ) VALUES ($1, $2, 'P2 Board', 'p2board', '[]'::jsonb, $3, $4, $4)`,
		boardID,
		workspaceID,
		userID,
		now,
	); err != nil {
		t.Fatalf("seed board: %v", err)
	}
}

func openP2TestDatabase(
	t *testing.T,
	includeParallelMigrations bool,
) *pgxpool.Pool {
	t.Helper()
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
	schema := "berry_p2_" + uuid.NewString()[:8]
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create isolated P2 schema: %v", err)
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
		t.Fatalf("open isolated P2 pool: %v", err)
	}
	t.Cleanup(pool.Close)
	all, err := migrations.List()
	if err != nil {
		t.Fatalf("list migrations: %v", err)
	}
	appliedP2 := false
	for _, migration := range all {
		if !includeParallelMigrations &&
			migration.Version > 4 &&
			migration.Name != "007_p2_views_inbox.up.sql" {
			continue
		}
		if migration.Version == 7 {
			appliedP2 = true
		}
		if _, err := pool.Exec(ctx, migration.SQL); err != nil {
			t.Fatalf("apply %s: %v", migration.Name, err)
		}
	}
	if !appliedP2 {
		t.Fatal("P2 migration was not applied")
	}
	return pool
}
