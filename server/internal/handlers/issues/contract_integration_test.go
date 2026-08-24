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
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
	authhandler "github.com/laravel42/berry-circle/server/internal/handlers/auth"
	"github.com/laravel42/berry-circle/server/internal/handlers/boards"
	"github.com/laravel42/berry-circle/server/internal/handlers/comments"
	"github.com/laravel42/berry-circle/server/internal/handlers/issues"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

func TestAuthenticatedCoreContract(t *testing.T) {
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

	now := time.Date(2026, 8, 22, 12, 30, 0, 0, time.UTC)
	userIDs := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	workspaceID := uuid.New()
	t.Cleanup(func() {
		for _, userID := range userIDs {
			_, _ = pool.Exec(context.Background(), `DELETE FROM boards WHERE created_by = $1`, userID)
			_, _ = pool.Exec(
				context.Background(),
				`DELETE FROM idempotency_records WHERE actor_type = 'user' AND actor_id = $1`,
				userID,
			)
			_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
		}
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, workspaceID)
	})
	roles := []string{"member", "member", "admin"}
	names := []string{"Contract Author", "Contract Intruder", "Contract Admin"}
	for index, userID := range userIDs {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO users (id, email, name, role, created_at, updated_at)
			 VALUES ($1, $2, $3, $4::user_role, $5, $5)`,
			userID,
			fmt.Sprintf("%s@berry.test", userID),
			names[index],
			roles[index],
			now,
		); err != nil {
			t.Fatalf("seed user: %v", err)
		}
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspaces (
		    id, name, slug, created_by, created_at, updated_at
		 ) VALUES ($1, 'Contract Workspace', $2, $3, $4, $4)`,
		workspaceID,
		"contract-"+workspaceID.String()[:8],
		userIDs[2],
		now,
	); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspace_memberships (
		    workspace_id, user_id, role, joined_at, updated_at
		 ) VALUES
		    ($1, $2, 'member', $5, $5),
		    ($1, $3, 'member', $5, $5),
		    ($1, $4, 'owner', $5, $5)`,
		workspaceID,
		userIDs[0],
		userIDs[1],
		userIDs[2],
		now,
	); err != nil {
		t.Fatalf("seed workspace memberships: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`UPDATE users SET last_workspace_id = $1 WHERE id = ANY($2::uuid[])`,
		workspaceID,
		userIDs,
	); err != nil {
		t.Fatalf("select seeded workspace: %v", err)
	}

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
	tokens := make([]string, len(userIDs))
	for index, userID := range userIDs {
		token, err := coreauth.GenerateToken(rand.Reader)
		if err != nil {
			t.Fatalf("generate seeded token: %v", err)
		}
		tokens[index] = token
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO sessions (
				id, user_id, token_hash, expires_at, created_at
			 ) VALUES ($1, $2, $3, $4, $5)`,
			uuid.New(),
			userID,
			coreauth.HashToken(token),
			now.Add(time.Hour),
			now,
		); err != nil {
			t.Fatalf("seed session: %v", err)
		}
	}

	idempotency := httpapi.PostgresIdempotencyStore{Pool: pool}
	var registry httpapi.Registry
	register := func(mounts []httpapi.Mount) {
		t.Helper()
		for _, mount := range mounts {
			if err := registry.Register(mount); err != nil {
				t.Fatalf("register %s: %v", mount.Prefix, err)
			}
		}
	}
	register(authhandler.Mounts(authhandler.Options{
		Pool:     pool,
		Sessions: sessionService,
		Clock:    func() time.Time { return now },
		NewID:    uuid.New,
		Login: authhandler.LoginConfig{
			AllowKnownEmail: true,
			Environment:     "test",
		},
	}))
	common := struct {
		Pool             *pgxpool.Pool
		Sessions         coreauth.SessionResolver
		Clock            func() time.Time
		NewID            func() uuid.UUID
		IdempotencyStore httpapi.IdempotencyStore
	}{
		Pool:             pool,
		Sessions:         sessionService,
		Clock:            func() time.Time { return now },
		NewID:            uuid.New,
		IdempotencyStore: idempotency,
	}
	register(boards.Mounts(boards.Options{
		Pool:             common.Pool,
		Sessions:         common.Sessions,
		Authorization:    authorization,
		Clock:            common.Clock,
		NewID:            common.NewID,
		IdempotencyStore: common.IdempotencyStore,
	}))
	register(issues.Mounts(issues.Options{
		Pool:             common.Pool,
		Sessions:         common.Sessions,
		Authorization:    authorization,
		Clock:            common.Clock,
		NewID:            common.NewID,
		IdempotencyStore: common.IdempotencyStore,
	}))
	register(comments.Mounts(comments.Options{
		Pool:             common.Pool,
		Sessions:         common.Sessions,
		Authorization:    authorization,
		Clock:            common.Clock,
		NewID:            common.NewID,
		IdempotencyStore: common.IdempotencyStore,
	}))
	handler := registry.Handler(httpapi.Options{
		Logger:       slog.New(slog.DiscardHandler),
		NewRequestID: func() string { return "req_contract_test_123" },
	})

	request := func(
		method, path, token, key string,
		body any,
	) *httptest.ResponseRecorder {
		t.Helper()
		var encoded []byte
		if body != nil {
			var marshalErr error
			encoded, marshalErr = json.Marshal(body)
			if marshalErr != nil {
				t.Fatalf("marshal request: %v", marshalErr)
			}
		}
		httpRequest := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		if body != nil {
			httpRequest.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			httpRequest.Header.Set("Authorization", "Bearer "+token)
		}
		if key != "" {
			httpRequest.Header.Set("Idempotency-Key", key)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httpRequest)
		return response
	}

	t.Run("auth login me logout and hash-only storage", func(t *testing.T) {
		login := request(
			http.MethodPost,
			"/api/v1/auth/login",
			"",
			"",
			map[string]any{"email": fmt.Sprintf("%s@berry.test", userIDs[0])},
		)
		if login.Code != http.StatusOK || login.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("login status=%d headers=%v body=%s", login.Code, login.Header(), login.Body)
		}
		var payload struct {
			Token string `json:"token"`
			User  struct {
				Role string `json:"role"`
			} `json:"user"`
		}
		decodeResponse(t, login, &payload)
		if payload.Token == "" || payload.User.Role != "member" {
			t.Fatalf("login payload = %#v", payload)
		}
		var storedHash string
		if err := pool.QueryRow(
			ctx,
			`SELECT token_hash FROM sessions WHERE token_hash = $1`,
			coreauth.HashToken(payload.Token),
		).Scan(&storedHash); err != nil {
			t.Fatalf("read issued session hash: %v", err)
		}
		if storedHash == payload.Token {
			t.Fatal("raw login token was persisted")
		}
		if response := request(http.MethodGet, "/api/v1/auth/me", payload.Token, "", nil); response.Code != 200 {
			t.Fatalf("me status=%d body=%s", response.Code, response.Body)
		}
		if response := request(http.MethodPost, "/api/v1/auth/logout", payload.Token, "", nil); response.Code != 204 {
			t.Fatalf("logout status=%d body=%s", response.Code, response.Body)
		}
		if response := request(http.MethodGet, "/api/v1/auth/me", payload.Token, "", nil); response.Code != 401 {
			t.Fatalf("revoked me status=%d body=%s", response.Code, response.Body)
		}
	})

	if response := request(http.MethodGet, "/api/v1/boards", "", "", nil); response.Code != 401 {
		t.Fatalf("unauthenticated boards status=%d body=%s", response.Code, response.Body)
	}
	if response := request(
		http.MethodPost,
		"/api/v1/boards",
		tokens[0],
		"",
		map[string]any{"name": "No key", "slug": "no-key"},
	); response.Code != 422 {
		t.Fatalf("missing idempotency key status=%d body=%s", response.Code, response.Body)
	}

	boardRequest := map[string]any{"name": "Contract Board", "slug": "ct-" + uuid.NewString()[:8]}
	firstBoard := request(
		http.MethodPost,
		"/api/v1/boards",
		tokens[0],
		"board-create-key-0001",
		boardRequest,
	)
	if firstBoard.Code != http.StatusCreated {
		t.Fatalf("create board status=%d body=%s", firstBoard.Code, firstBoard.Body)
	}
	var board struct {
		ID      uuid.UUID `json:"id"`
		Slug    string    `json:"slug"`
		Columns []struct {
			ID string `json:"id"`
		} `json:"columns"`
	}
	decodeResponse(t, firstBoard, &board)
	if len(board.Columns) != 5 || firstBoard.Header().Get("Location") == "" {
		t.Fatalf("board payload=%#v headers=%v", board, firstBoard.Header())
	}
	replay := request(
		http.MethodPost,
		"/api/v1/boards",
		tokens[0],
		"board-create-key-0001",
		boardRequest,
	)
	if replay.Code != http.StatusCreated ||
		replay.Header().Get("Idempotency-Replayed") != "true" ||
		replay.Body.String() != firstBoard.Body.String() {
		t.Fatalf("board replay status=%d headers=%v body=%s", replay.Code, replay.Header(), replay.Body)
	}
	conflict := request(
		http.MethodPost,
		"/api/v1/boards",
		tokens[0],
		"board-create-key-0001",
		map[string]any{"name": "Different", "slug": board.Slug},
	)
	assertErrorCode(t, conflict, http.StatusConflict, "IDEMPOTENCY_CONFLICT")
	duplicateSlug := request(
		http.MethodPost,
		"/api/v1/boards",
		tokens[0],
		"board-create-key-0002",
		map[string]any{"name": "Duplicate slug", "slug": board.Slug},
	)
	assertErrorCode(t, duplicateSlug, http.StatusConflict, "CONFLICT")

	const issueCount = 6
	numbers := make(chan int, issueCount)
	errorsChannel := make(chan string, issueCount)
	var wait sync.WaitGroup
	for index := 0; index < issueCount; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			response := request(
				http.MethodPost,
				"/api/v1/issues",
				tokens[0],
				fmt.Sprintf("issue-create-key-%04d", index),
				map[string]any{
					"boardId": board.ID,
					"title":   fmt.Sprintf("Concurrent %d", index),
				},
			)
			if response.Code != http.StatusCreated {
				errorsChannel <- fmt.Sprintf("status=%d body=%s", response.Code, response.Body)
				return
			}
			var issue struct {
				Number int `json:"number"`
			}
			decodeResponse(t, response, &issue)
			numbers <- issue.Number
		}(index)
	}
	wait.Wait()
	close(numbers)
	close(errorsChannel)
	for message := range errorsChannel {
		t.Errorf("concurrent issue create: %s", message)
	}
	gotNumbers := make([]int, 0, issueCount)
	for number := range numbers {
		gotNumbers = append(gotNumbers, number)
	}
	sort.Ints(gotNumbers)
	for index, number := range gotNumbers {
		if number != index+1 {
			t.Fatalf("atomic numbers=%v, want 1..%d", gotNumbers, issueCount)
		}
	}

	createdIssueResponse := request(
		http.MethodPost,
		"/api/v1/issues",
		tokens[0],
		"issue-create-assigned-0001",
		map[string]any{
			"boardId":  board.ID,
			"title":    "Assigned and discussable",
			"status":   "todo",
			"priority": "high",
			"assignee": map[string]any{"type": "user", "id": userIDs[1]},
		},
	)
	if createdIssueResponse.Code != http.StatusCreated {
		t.Fatalf("create assigned issue status=%d body=%s", createdIssueResponse.Code, createdIssueResponse.Body)
	}
	var issue struct {
		ID         uuid.UUID `json:"id"`
		Identifier string    `json:"identifier"`
		Status     string    `json:"status"`
		Assignee   struct {
			ID uuid.UUID `json:"id"`
		} `json:"assignee"`
	}
	decodeResponse(t, createdIssueResponse, &issue)
	if issue.Status != "todo" || issue.Assignee.ID != userIDs[1] {
		t.Fatalf("assigned issue = %#v", issue)
	}
	var assignmentCount int
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM assignments WHERE issue_id = $1`,
		issue.ID,
	).Scan(&assignmentCount); err != nil || assignmentCount != 1 {
		t.Fatalf("assignment history count=%d err=%v", assignmentCount, err)
	}
	columnGuard := request(
		http.MethodPatch,
		"/api/v1/boards/"+board.ID.String(),
		tokens[0],
		"",
		map[string]any{"columns": []map[string]string{
			{"id": "backlog", "name": "Backlog"},
			{"id": "inProgress", "name": "In progress"},
			{"id": "inReview", "name": "In review"},
			{"id": "done", "name": "Done"},
		}},
	)
	assertErrorCode(t, columnGuard, http.StatusConflict, "CONFLICT")
	byIdentifier := request(
		http.MethodGet,
		"/api/v1/issues/"+strings.ToLower(issue.Identifier),
		tokens[0],
		"",
		nil,
	)
	if byIdentifier.Code != http.StatusOK {
		t.Fatalf("identifier lookup status=%d body=%s", byIdentifier.Code, byIdentifier.Body)
	}
	invalidTransition := request(
		http.MethodPatch,
		"/api/v1/issues/"+issue.ID.String(),
		tokens[0],
		"",
		map[string]any{"status": "done"},
	)
	assertErrorCode(t, invalidTransition, http.StatusConflict, "INVALID_STATE_TRANSITION")
	filtered := request(
		http.MethodGet,
		"/api/v1/issues?boardId="+board.ID.String()+"&status=todo",
		tokens[0],
		"",
		nil,
	)
	if filtered.Code != http.StatusOK {
		t.Fatalf("filtered issues status=%d body=%s", filtered.Code, filtered.Body)
	}
	var filteredPage struct {
		Nodes []struct {
			Status string `json:"status"`
		} `json:"nodes"`
	}
	decodeResponse(t, filtered, &filteredPage)
	if len(filteredPage.Nodes) != 1 || filteredPage.Nodes[0].Status != "todo" {
		t.Fatalf("filtered issues = %#v", filteredPage.Nodes)
	}

	pageOne := request(
		http.MethodGet,
		"/api/v1/issues?boardId="+board.ID.String()+"&first=2",
		tokens[0],
		"",
		nil,
	)
	if pageOne.Code != http.StatusOK {
		t.Fatalf("issue page one status=%d body=%s", pageOne.Code, pageOne.Body)
	}
	var firstPage struct {
		Nodes []struct {
			ID uuid.UUID `json:"id"`
		} `json:"nodes"`
		PageInfo struct {
			EndCursor string `json:"endCursor"`
		} `json:"pageInfo"`
	}
	decodeResponse(t, pageOne, &firstPage)
	crossScope := request(
		http.MethodGet,
		"/api/v1/issues?boardId="+board.ID.String()+"&status=todo&first=2&after="+
			firstPage.PageInfo.EndCursor,
		tokens[0],
		"",
		nil,
	)
	assertErrorCode(t, crossScope, http.StatusBadRequest, "INVALID_CURSOR")
	pageTwo := request(
		http.MethodGet,
		"/api/v1/issues?boardId="+board.ID.String()+"&first=2&after="+
			firstPage.PageInfo.EndCursor,
		tokens[0],
		"",
		nil,
	)
	if pageTwo.Code != http.StatusOK {
		t.Fatalf("issue page two status=%d body=%s", pageTwo.Code, pageTwo.Body)
	}
	var secondPage struct {
		Nodes []struct {
			ID uuid.UUID `json:"id"`
		} `json:"nodes"`
	}
	decodeResponse(t, pageTwo, &secondPage)
	seen := make(map[uuid.UUID]struct{})
	for _, node := range append(firstPage.Nodes, secondPage.Nodes...) {
		if _, duplicate := seen[node.ID]; duplicate {
			t.Fatalf("issue %s repeated across adjacent pages", node.ID)
		}
		seen[node.ID] = struct{}{}
	}

	rootResponse := request(
		http.MethodPost,
		"/api/v1/issues/"+issue.ID.String()+"/comments",
		tokens[0],
		"comment-create-root-0001",
		map[string]any{"body": "root"},
	)
	if rootResponse.Code != http.StatusCreated {
		t.Fatalf("create root comment status=%d body=%s", rootResponse.Code, rootResponse.Body)
	}
	var root struct {
		ID uuid.UUID `json:"id"`
	}
	decodeResponse(t, rootResponse, &root)
	replyResponse := request(
		http.MethodPost,
		"/api/v1/issues/"+issue.ID.String()+"/comments",
		tokens[0],
		"comment-create-reply-001",
		map[string]any{"body": "reply", "parentId": root.ID},
	)
	if replyResponse.Code != http.StatusCreated {
		t.Fatalf("create reply status=%d body=%s", replyResponse.Code, replyResponse.Body)
	}
	var reply struct {
		ID uuid.UUID `json:"id"`
	}
	decodeResponse(t, replyResponse, &reply)
	nested := request(
		http.MethodPost,
		"/api/v1/issues/"+issue.ID.String()+"/comments",
		tokens[0],
		"comment-create-nested-01",
		map[string]any{"body": "nested", "parentId": reply.ID},
	)
	assertErrorCode(t, nested, http.StatusUnprocessableEntity, "VALIDATION_FAILED")
	intruderEdit := request(
		http.MethodPatch,
		"/api/v1/comments/"+root.ID.String(),
		tokens[1],
		"",
		map[string]any{"body": "intrusion"},
	)
	assertErrorCode(t, intruderEdit, http.StatusForbidden, "FORBIDDEN")
	adminEdit := request(
		http.MethodPatch,
		"/api/v1/comments/"+root.ID.String(),
		tokens[2],
		"",
		map[string]any{"body": "moderated"},
	)
	if adminEdit.Code != http.StatusOK {
		t.Fatalf("admin edit status=%d body=%s", adminEdit.Code, adminEdit.Body)
	}
	deleted := request(
		http.MethodDelete,
		"/api/v1/comments/"+root.ID.String(),
		tokens[0],
		"",
		nil,
	)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete root status=%d body=%s", deleted.Code, deleted.Body)
	}
	if response := request(
		http.MethodGet,
		"/api/v1/comments/"+reply.ID.String(),
		tokens[0],
		"",
		nil,
	); response.Code != http.StatusNotFound {
		t.Fatalf("cascaded reply status=%d body=%s", response.Code, response.Body)
	}
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response status=%d body=%s: %v", response.Code, response.Body, err)
	}
}

func assertErrorCode(
	t *testing.T,
	response *httptest.ResponseRecorder,
	status int,
	code string,
) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status=%d want=%d body=%s", response.Code, status, response.Body)
	}
	var envelope httpapi.ErrorEnvelope
	decodeResponse(t, response, &envelope)
	if envelope.Error.Code != code {
		t.Fatalf("error code=%s want=%s body=%s", envelope.Error.Code, code, response.Body)
	}
}
