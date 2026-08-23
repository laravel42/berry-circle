package runs

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestConcurrentRunEventSequenceAndSuccessGate(t *testing.T) {
	databaseURL := os.Getenv("BERRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BERRY_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open BERRY_TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping BERRY_TEST_DATABASE_URL: %v", err)
	}

	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	userID := uuid.New()
	workspaceID := uuid.New()
	boardID := uuid.New()
	issueID := uuid.New()
	agentID := uuid.New()
	upstreamAgentID := uuid.New()
	runID := uuid.New()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM boards WHERE id = $1`, boardID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, workspaceID)
	})
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO users (id, email, name, role, created_at, updated_at)
		 VALUES ($1, $2, 'Run repository test', 'member', $3, $3)`,
		userID,
		fmt.Sprintf("%s@berry.test", userID),
		now,
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspaces (
		    id, name, slug, created_by, created_at, updated_at
		 ) VALUES ($1, 'Run Workspace', $2, $3, $4, $4)`,
		workspaceID,
		"run-"+workspaceID.String()[:8],
		userID,
		now,
	); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspace_memberships (
		    workspace_id, user_id, role, joined_at, updated_at
		 ) VALUES ($1, $2, 'owner', $3, $3)`,
		workspaceID,
		userID,
		now,
	); err != nil {
		t.Fatalf("seed workspace membership: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`UPDATE users SET last_workspace_id = $2 WHERE id = $1`,
		userID,
		workspaceID,
	); err != nil {
		t.Fatalf("select seeded workspace: %v", err)
	}
	slug := "t" + userID.String()[:8]
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO boards (
			id, name, slug, columns, issue_counter, created_by, created_at, updated_at
		 ) VALUES ($1, 'Run test', $2, '[]'::jsonb, 1, $3, $4, $4)`,
		boardID,
		slug,
		userID,
		now,
	); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO agents (
			id, workspace_id, board_id, openfang_agent_id, name, status,
			created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, 'Run agent', 'available', $5, $5)`,
		agentID,
		workspaceID,
		boardID,
		upstreamAgentID,
		now,
	); err != nil {
		t.Fatalf("seed agent (apply migration 003 first): %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO issues (
			id, board_id, number, title, status, priority, sort_order,
			assignee_type, assignee_id, created_by, created_at, updated_at
		 ) VALUES (
			$1, $2, 1, 'Concurrent projection', 'in_progress', 'medium', 0,
			'agent', $3, $4, $5, $5
		 )`,
		issueID,
		boardID,
		agentID,
		userID,
		now,
	); err != nil {
		t.Fatalf("seed issue: %v", err)
	}
	repository, err := New(pool)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := repository.Admit(ctx, AdmitParams{
		RunID:          runID,
		CreatedEventID: uuid.New(),
		IssueRef:       issueID.String(),
		WorkspaceID:    workspaceID,
		RequestedBy:    userID,
		RequestID:      "req_repository_test",
		CreatedAt:      now,
	}); err != nil {
		t.Fatalf("Admit() error = %v", err)
	}
	if _, err := repository.ClaimDispatch(ctx, runID, now); err != nil {
		t.Fatalf("ClaimDispatch() error = %v", err)
	}
	if _, _, err := repository.MarkRunning(
		ctx,
		runID,
		uuid.New(),
		"upstream-test",
		now,
	); err != nil {
		t.Fatalf("MarkRunning() error = %v", err)
	}

	const writers = 16
	errors := make(chan error, writers)
	var wait sync.WaitGroup
	for index := range writers {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			_, err := repository.AppendOutput(
				ctx,
				runID,
				uuid.New(),
				"progress",
				fmt.Sprintf("%02d", index),
				now,
			)
			errors <- err
		}(index)
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("AppendOutput() error = %v", err)
		}
	}

	if _, _, err := repository.CompleteSuccess(ctx, SuccessParams{
		RunID:            runID,
		UsageEventID:     uuid.New(),
		CompletedEventID: uuid.New(),
		IssueEventID:     uuid.New(),
		Usage: Usage{
			InputTokens:  10,
			OutputTokens: 5,
			TotalTokens:  15,
		},
		CompletedAt: now,
	}); err != nil {
		t.Fatalf("CompleteSuccess() error = %v", err)
	}
	events, err := repository.ListRunEvents(
		ctx,
		runID,
		-1,
		now.Add(-time.Hour),
		100,
	)
	if err != nil {
		t.Fatalf("ListRunEvents() error = %v", err)
	}
	if len(events) != writers+4 {
		t.Fatalf("event count = %d, want %d", len(events), writers+4)
	}
	var previous time.Time
	for index, event := range events {
		if event.Sequence == nil || *event.Sequence != int64(index) {
			t.Fatalf("event %d sequence = %#v", index, event.Sequence)
		}
		if !previous.IsZero() && !event.OccurredAt.After(previous) {
			t.Fatalf(
				"event %d occurredAt = %s, previous = %s",
				index,
				event.OccurredAt,
				previous,
			)
		}
		previous = event.OccurredAt
	}
	var (
		status      string
		activeRunID *uuid.UUID
	)
	if err := pool.QueryRow(
		ctx,
		`SELECT status::text, active_run_id FROM issues WHERE id = $1`,
		issueID,
	).Scan(&status, &activeRunID); err != nil {
		t.Fatalf("read issue gate: %v", err)
	}
	if status != "in_review" || activeRunID != nil {
		t.Fatalf("issue status=%q activeRunId=%v", status, activeRunID)
	}
}
