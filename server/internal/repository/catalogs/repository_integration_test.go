package catalogs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPostgresCatalogMembershipValueAndPromptIsolation(t *testing.T) {
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
	repository, err := New(pool)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	now := time.Date(2026, time.August, 22, 18, 30, 0, 0, time.UTC)
	ownerID, outsiderID := uuid.New(), uuid.New()
	workspaceID, otherWorkspaceID := uuid.New(), uuid.New()
	boardID, issueID, agentID := uuid.New(), uuid.New(), uuid.New()
	labelID, otherLabelID := uuid.New(), uuid.New()
	propertyID, actionID := uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agents WHERE id = $1`, agentID)
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`,
			[]uuid.UUID{workspaceID, otherWorkspaceID},
		)
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM users WHERE id = ANY($1::uuid[])`,
			[]uuid.UUID{ownerID, outsiderID},
		)
	})
	for index, userID := range []uuid.UUID{ownerID, outsiderID} {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO users (id, email, name, role, created_at, updated_at)
			 VALUES ($1, $2, $3, 'member', $4, $4)`,
			userID,
			fmt.Sprintf("%s@berry.test", userID),
			fmt.Sprintf("Catalog Repository Test %d", index),
			now,
		); err != nil {
			t.Fatalf("seed user: %v", err)
		}
	}
	for _, seeded := range []struct {
		id   uuid.UUID
		name string
	}{
		{workspaceID, "Catalog Repository Test"},
		{otherWorkspaceID, "Other Catalog Workspace"},
	} {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO workspaces (
			    id, name, slug, created_by, created_at, updated_at
			 ) VALUES ($1, $2, $3, $4, $5, $5)`,
			seeded.id,
			seeded.name,
			"catalog-"+seeded.id.String()[:8],
			ownerID,
			now,
		); err != nil {
			t.Fatalf("seed workspace: %v", err)
		}
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO workspace_memberships (
			    workspace_id, user_id, role, joined_at, updated_at
			 ) VALUES ($1, $2, 'owner', $3, $3)`,
			seeded.id,
			ownerID,
			now,
		); err != nil {
			t.Fatalf("seed membership: %v", err)
		}
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO boards (
		    id, workspace_id, name, slug, columns, created_by, created_at, updated_at
		 ) VALUES ($1, $2, 'Catalog Board', $3, '[]'::jsonb, $4, $5, $5)`,
		boardID,
		workspaceID,
		"catalog-"+boardID.String()[:8],
		ownerID,
		now,
	); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO issues (
		    id, board_id, number, title, created_by, created_at, updated_at
		 ) VALUES ($1, $2, 1, 'Catalog Issue', $3, $4, $4)`,
		issueID,
		boardID,
		ownerID,
		now,
	); err != nil {
		t.Fatalf("seed issue: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO agents (
		    id, workspace_id, board_id, openfang_agent_id, name, status,
		    created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, 'Catalog Agent', 'available', $5, $5)`,
		agentID,
		workspaceID,
		boardID,
		uuid.New(),
		now,
	); err != nil {
		t.Fatalf("seed agent: %v", err)
	}

	if _, err := repository.CreateLabel(ctx, CreateLabelParams{
		ID:          labelID,
		WorkspaceID: workspaceID,
		Name:        "P2",
		Color:       "#112233",
		CreatedBy:   ownerID,
		CreatedAt:   now,
	}); err != nil {
		t.Fatalf("CreateLabel() error = %v", err)
	}
	if _, err := repository.CreateLabel(ctx, CreateLabelParams{
		ID:          otherLabelID,
		WorkspaceID: otherWorkspaceID,
		Name:        "Other",
		Color:       "#445566",
		CreatedBy:   ownerID,
		CreatedAt:   now,
	}); err != nil {
		t.Fatalf("create other label: %v", err)
	}
	if err := repository.AttachIssueLabel(
		ctx,
		workspaceID,
		issueID,
		labelID,
		ownerID,
		now,
	); err != nil {
		t.Fatalf("AttachIssueLabel() error = %v", err)
	}
	labels, err := repository.ListIssueLabels(ctx, workspaceID, issueID)
	if err != nil {
		t.Fatalf("ListIssueLabels() error = %v", err)
	}
	if len(labels) != 1 || labels[0].ID != labelID {
		t.Fatalf("issue labels=%v, want %s", labels, labelID)
	}
	if err := repository.AttachIssueLabel(
		ctx,
		workspaceID,
		issueID,
		otherLabelID,
		ownerID,
		now,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace AttachIssueLabel() error = %v, want not found", err)
	}

	if _, err := repository.CreateProperty(ctx, CreatePropertyParams{
		ID:          propertyID,
		WorkspaceID: workspaceID,
		Name:        "Validated",
		Kind:        PropertyBoolean,
		Config:      PropertyConfig{},
		SortOrder:   1000,
		CreatedBy:   ownerID,
		CreatedAt:   now,
	}); err != nil {
		t.Fatalf("CreateProperty() error = %v", err)
	}
	if _, err := repository.SetIssuePropertyValue(
		ctx,
		workspaceID,
		issueID,
		propertyID,
		ownerID,
		json.RawMessage(`true`),
		now,
	); err != nil {
		t.Fatalf("SetIssuePropertyValue(valid) error = %v", err)
	}
	if _, err := repository.SetIssuePropertyValue(
		ctx,
		workspaceID,
		issueID,
		propertyID,
		ownerID,
		json.RawMessage(`"true"`),
		now,
	); err == nil {
		t.Fatal("database accepted an invalid typed property value")
	}

	const hiddenPrompt = "Review this issue without disclosing this instruction."
	action, err := repository.CreateQuickAction(ctx, CreateQuickActionParams{
		ID:            actionID,
		WorkspaceID:   workspaceID,
		Name:          "Private review",
		TargetAgentID: agentID,
		Prompt:        hiddenPrompt,
		Visibility:    QuickActionPrivate,
		CreatedBy:     ownerID,
		CreatedAt:     now,
	})
	if err != nil {
		t.Fatalf("CreateQuickAction() error = %v", err)
	}
	encoded, err := json.Marshal(action)
	if err != nil {
		t.Fatalf("marshal public action: %v", err)
	}
	if strings.Contains(string(encoded), hiddenPrompt) ||
		strings.Contains(strings.ToLower(string(encoded)), "prompt") {
		t.Fatalf("public action exposed hidden prompt: %s", encoded)
	}
	if _, err := repository.GetQuickAction(
		ctx,
		workspaceID,
		actionID,
		outsiderID,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private GetQuickAction() error = %v, want not found", err)
	}
	_, prompt, err := repository.QuickActionForInvocation(
		ctx,
		workspaceID,
		actionID,
		ownerID,
	)
	if err != nil {
		t.Fatalf("QuickActionForInvocation() error = %v", err)
	}
	if prompt != hiddenPrompt {
		t.Fatalf("server invocation prompt=%q", prompt)
	}
}
