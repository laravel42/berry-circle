package issues_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
	eventhandlers "github.com/laravel42/berry-circle/server/internal/handlers/events"
	"github.com/laravel42/berry-circle/server/internal/handlers/issues"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/realtime"
)

// A person moving an issue to done is a durable fact scoped to its workspace
// and board, replayed on the board stream and delivered live to the board's
// subscribers. Before migration 019 none of that held for a manual PATCH: the
// only issue.updated came from a run, and it was filed under the board id in
// the workspace column.
func TestIssueCompletionIsScopedReplayedAndPublished(t *testing.T) {
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

	now := time.Date(2026, 8, 25, 9, 30, 0, 0, time.UTC)
	userID := uuid.New()
	workspaceID := uuid.New()
	boardID := uuid.New()
	t.Cleanup(func() {
		cleanup := context.Background()
		_, _ = pool.Exec(cleanup, `DELETE FROM outbox_events WHERE board_id = $1`, boardID)
		_, _ = pool.Exec(cleanup, `DELETE FROM boards WHERE id = $1`, boardID)
		_, _ = pool.Exec(
			cleanup,
			`DELETE FROM idempotency_records WHERE actor_type = 'user' AND actor_id = $1`,
			userID,
		)
		_, _ = pool.Exec(cleanup, `DELETE FROM users WHERE id = $1`, userID)
		_, _ = pool.Exec(cleanup, `DELETE FROM workspaces WHERE id = $1`, workspaceID)
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role, created_at, updated_at)
	      VALUES ($1, $2, 'Event Author', 'member'::user_role, $3, $3)`,
		userID, fmt.Sprintf("%s@berry.test", userID), now)
	exec(`INSERT INTO workspaces (id, name, slug, created_by, created_at, updated_at)
	      VALUES ($1, 'Events Workspace', $2, $3, $4, $4)`,
		workspaceID, "events-"+workspaceID.String()[:8], userID, now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at)
	      VALUES ($1, $2, 'member', $3, $3)`, workspaceID, userID, now)
	exec(`UPDATE users SET last_workspace_id = $1 WHERE id = $2`, workspaceID, userID)
	exec(`INSERT INTO boards (id, workspace_id, name, slug, columns, created_by, created_at, updated_at)
	      VALUES ($1, $2, 'Events Board', $3, '[]'::jsonb, $4, $5, $5)`,
		boardID, workspaceID, "ev-"+boardID.String()[:8], userID, now)

	sessionService, err := coreauth.NewService(coreauth.ServiceOptions{
		Pool:       pool,
		Now:        func() time.Time { return now },
		NewID:      uuid.New,
		Random:     rand.Reader,
		SessionTTL: 24 * time.Hour,
	})
	if err != nil {
		t.Fatalf("construct auth service: %v", err)
	}
	authorization, err := identity.NewService(identity.ServiceOptions{
		Pool:   pool,
		Now:    func() time.Time { return now },
		NewID:  uuid.New,
		Random: rand.Reader,
	})
	if err != nil {
		t.Fatalf("construct identity service: %v", err)
	}
	token, err := coreauth.GenerateToken(rand.Reader)
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}
	exec(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
	      VALUES ($1, $2, $3, $4, $5)`,
		uuid.New(), userID, coreauth.HashToken(token), now.Add(time.Hour), now)

	hub, err := realtime.NewHub(64)
	if err != nil {
		t.Fatalf("NewHub() error = %v", err)
	}
	t.Cleanup(func() { _ = hub.Close() })
	var registry httpapi.Registry
	for _, mount := range issues.Mounts(issues.Options{
		Pool:             pool,
		Sessions:         sessionService,
		Authorization:    authorization,
		Clock:            func() time.Time { return now },
		NewID:            uuid.New,
		IdempotencyStore: httpapi.PostgresIdempotencyStore{Pool: pool},
		Broadcaster:      hub,
	}) {
		if err := registry.Register(mount); err != nil {
			t.Fatalf("register %s: %v", mount.Prefix, err)
		}
	}
	eventMount, err := eventhandlers.NewMount(eventhandlers.Options{
		Pool:          pool,
		Sessions:      sessionService,
		Authorization: authorization,
		Clock:         time.Now,
		Broadcaster:   hub,
	})
	if err != nil {
		t.Fatalf("construct event mount: %v", err)
	}
	if err := registry.Register(eventMount); err != nil {
		t.Fatalf("register events: %v", err)
	}
	handler := registry.Handler(httpapi.Options{
		Logger:       slog.New(slog.DiscardHandler),
		NewRequestID: func() string { return "req_issue_events_test" },
	})
	request := func(method, path string, body any, key string) *httptest.ResponseRecorder {
		t.Helper()
		var encoded []byte
		if body != nil {
			encoded, err = json.Marshal(body)
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}
		}
		httpRequest := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		httpRequest.Header.Set("Content-Type", "application/json")
		httpRequest.Header.Set("Authorization", "Bearer "+token)
		if key != "" {
			httpRequest.Header.Set("Idempotency-Key", key)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httpRequest)
		return response
	}

	created := request(http.MethodPost, "/api/v1/issues", map[string]any{
		"boardId": boardID.String(),
		"title":   "Ship the board stream",
		"status":  "todo",
	}, "issue-events-create-0001")
	if created.Code != http.StatusCreated {
		t.Fatalf("create issue status=%d body=%s", created.Code, created.Body)
	}
	var issue struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &issue); err != nil {
		t.Fatalf("decode issue: %v", err)
	}
	for _, status := range []string{"inProgress", "inReview"} {
		if response := request(
			http.MethodPatch, "/api/v1/issues/"+issue.ID.String(),
			map[string]any{"status": status}, "",
		); response.Code != http.StatusOK {
			t.Fatalf("patch %s status=%d body=%s", status, response.Code, response.Body)
		}
	}

	// Subscribe on the board scope before the final move: the board stream
	// wakes up on the board id, and the handler must publish under it.
	subscription, err := hub.Subscribe(ctx, boardID.String())
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer subscription.Close()
	if response := request(
		http.MethodPatch, "/api/v1/issues/"+issue.ID.String(),
		map[string]any{"status": "done"}, "",
	); response.Code != http.StatusOK {
		t.Fatalf("patch done status=%d body=%s", response.Code, response.Body)
	}

	var (
		storedWorkspace *uuid.UUID
		storedBoard     *uuid.UUID
		storedEnvelope  []byte
	)
	if err := pool.QueryRow(
		ctx,
		`SELECT workspace_id, board_id, payload
		   FROM outbox_events
		  WHERE topic = 'issue.completed' AND aggregate_type = 'issue' AND aggregate_id = $1`,
		issue.ID,
	).Scan(&storedWorkspace, &storedBoard, &storedEnvelope); err != nil {
		t.Fatalf("issue.completed outbox row: %v", err)
	}
	if storedWorkspace == nil || *storedWorkspace != workspaceID ||
		storedBoard == nil || *storedBoard != boardID {
		t.Fatalf("issue.completed scope = workspace %v board %v, want %s / %s",
			storedWorkspace, storedBoard, workspaceID, boardID)
	}
	var envelope struct {
		WorkspaceID uuid.UUID  `json:"workspaceId"`
		BoardID     uuid.UUID  `json:"boardId"`
		IssueID     uuid.UUID  `json:"issueId"`
		RunID       *uuid.UUID `json:"runId"`
		Sequence    *int64     `json:"sequence"`
		Payload     struct {
			ChangedFields  []string `json:"changedFields"`
			PreviousStatus string   `json:"previousStatus"`
			Actor          struct {
				Type string    `json:"type"`
				ID   uuid.UUID `json:"id"`
			} `json:"actor"`
			Issue struct {
				Status     string `json:"status"`
				Identifier string `json:"identifier"`
			} `json:"issue"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(storedEnvelope, &envelope); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if envelope.WorkspaceID != workspaceID || envelope.BoardID != boardID ||
		envelope.IssueID != issue.ID || envelope.RunID != nil || envelope.Sequence != nil ||
		envelope.Payload.PreviousStatus != "inReview" || envelope.Payload.Issue.Status != "done" ||
		envelope.Payload.Actor.ID != userID || envelope.Payload.Actor.Type != "user" ||
		len(envelope.Payload.ChangedFields) != 1 || envelope.Payload.ChangedFields[0] != "status" ||
		// The prefix is whatever the workspace derives; the number is the
		// board's first. Formatting goes through berry_issue_identifier.
		!strings.HasSuffix(envelope.Payload.Issue.Identifier, "-1") {
		t.Fatalf("issue.completed envelope = %s", storedEnvelope)
	}

	liveTypes := make([]string, 0, 2)
	for len(liveTypes) < 2 {
		select {
		case event := <-subscription.Events():
			if event.BoardID != boardID.String() || event.WorkspaceID != workspaceID.String() {
				t.Fatalf("live event scope = %#v", event)
			}
			liveTypes = append(liveTypes, event.Type)
		case <-time.After(2 * time.Second):
			t.Fatalf("live board events = %v, want issue.updated and issue.completed", liveTypes)
		}
	}
	if liveTypes[0] != "issue.updated" || liveTypes[1] != "issue.completed" {
		t.Fatalf("live board events = %v", liveTypes)
	}

	streamCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	streamRequest := httptest.NewRequest(
		http.MethodGet, "/api/v1/events?boardId="+boardID.String(), nil,
	).WithContext(streamCtx)
	streamRequest.Header.Set("Authorization", "Bearer "+token)
	stream := httptest.NewRecorder()
	handler.ServeHTTP(stream, streamRequest)
	if stream.Code != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", stream.Code, stream.Body)
	}
	body := stream.Body.String()
	for _, frame := range []string{
		"event: issue.created", "event: issue.started", "event: issue.completed",
	} {
		if !strings.Contains(body, frame) {
			t.Errorf("board stream lacks %q:\n%s", frame, body)
		}
	}
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(line, "data: ") || !strings.Contains(line, `"type":"issue.completed"`) {
			continue
		}
		var frame struct {
			WorkspaceID uuid.UUID  `json:"workspaceId"`
			BoardID     uuid.UUID  `json:"boardId"`
			RunID       *uuid.UUID `json:"runId"`
			Sequence    *int64     `json:"sequence"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame); err != nil {
			t.Fatalf("decode stream frame: %v", err)
		}
		if frame.WorkspaceID != workspaceID || frame.BoardID != boardID ||
			frame.RunID != nil || frame.Sequence != nil {
			t.Fatalf("replayed issue.completed frame = %s", line)
		}
		return
	}
	t.Fatalf("no issue.completed data frame in stream:\n%s", body)
}
