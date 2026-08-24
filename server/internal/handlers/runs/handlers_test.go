package runs

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	runrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
)

func TestRunMountRequiresAuthentication(t *testing.T) {
	handlers, cleanup := newHTTPTestHandlers(t, &fakeRunReader{}, &fakeCoordinator{})
	defer cleanup()
	request := httptest.NewRequest(http.MethodGet, "/"+uuid.NewString(), nil)
	response := httptest.NewRecorder()

	handlers.Mount().Handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	assertErrorCode(t, response.Body.Bytes(), "UNAUTHENTICATED")
}

func TestRunEventStreamFramesReplayAndClosesOnTerminal(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	runID := uuid.New()
	boardID := uuid.New()
	issueID := uuid.New()
	agentID := uuid.New()
	reader := &fakeRunReader{
		run: runrepo.Run{
			ID:        runID,
			BoardID:   boardID,
			IssueID:   issueID,
			AgentID:   agentID,
			Status:    runrepo.StatusSucceeded,
			CreatedAt: now,
		},
		events: []runrepo.Event{
			runEvent(uuid.New(), runID, boardID, issueID, "run.created", 0, `{}`, now),
			runEvent(
				uuid.New(),
				runID,
				boardID,
				issueID,
				"run.output.delta",
				1,
				`{"channel":"progress","text":"hello\nworld"}`,
				now.Add(time.Microsecond),
			),
			runEvent(
				uuid.New(),
				runID,
				boardID,
				issueID,
				"run.completed",
				2,
				`{}`,
				now.Add(2*time.Microsecond),
			),
		},
	}
	handlers, cleanup := newHTTPTestHandlers(t, reader, &fakeCoordinator{})
	defer cleanup()
	request := httptest.NewRequest(
		http.MethodGet,
		"/"+runID.String()+"/events",
		nil,
	)
	request.Header.Set("Authorization", "Bearer "+testToken())
	response := httptest.NewRecorder()

	handlers.Mount().Handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "text/event-stream; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	body := response.Body.String()
	if !strings.HasPrefix(body, "retry: 3000\n\n") {
		t.Fatalf("stream prefix = %q", body)
	}
	if strings.Count(body, "\nevent: ") != 3 {
		t.Fatalf("event frames = %q", body)
	}
	if !strings.Contains(body, `hello\nworld`) ||
		!strings.Contains(body, "event: run.completed") {
		t.Fatalf("stream body = %q", body)
	}
}

func TestRunEventStreamRejectsExpiredCursorBeforeOpening(t *testing.T) {
	runID := uuid.New()
	reader := &fakeRunReader{
		run: runrepo.Run{
			ID:        runID,
			BoardID:   uuid.New(),
			IssueID:   uuid.New(),
			AgentID:   uuid.New(),
			Status:    runrepo.StatusRunning,
			CreatedAt: time.Now().UTC(),
		},
		cursorErr: runrepo.ErrCursorExpired,
	}
	handlers, cleanup := newHTTPTestHandlers(t, reader, &fakeCoordinator{})
	defer cleanup()
	request := httptest.NewRequest(
		http.MethodGet,
		"/"+runID.String()+"/events",
		nil,
	)
	request.Header.Set("Authorization", "Bearer "+testToken())
	request.Header.Set("Last-Event-ID", uuid.NewString())
	response := httptest.NewRecorder()

	handlers.Mount().Handler.ServeHTTP(response, request)

	if response.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatal("expired cursor committed an SSE response")
	}
	assertErrorCode(t, response.Body.Bytes(), "CURSOR_EXPIRED")
}

func TestListBoardRunsReturnsConnection(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	boardID := uuid.New()
	runID := uuid.New()
	issueID := uuid.New()
	agentID := uuid.New()
	reader := &fakeRunReader{
		boardRuns: []runrepo.Run{
			{
				ID:        runID,
				BoardID:   boardID,
				IssueID:   issueID,
				AgentID:   agentID,
				Status:    runrepo.StatusSucceeded,
				CreatedAt: now,
			},
		},
	}
	handlers, cleanup := newHTTPTestHandlers(t, reader, &fakeCoordinator{})
	defer cleanup()
	router := chi.NewRouter()
	router.Route("/api/v1/boards/{boardId}", func(router chi.Router) {
		router.Mount("/runs", handlers.BoardHandler())
	})
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/boards/"+boardID.String()+"/runs?first=10",
		nil,
	)
	request = request.WithContext(auth.WithUser(request.Context(), testUser()))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Nodes []runResource `json:"nodes"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(payload.Nodes) != 1 || payload.Nodes[0].ID != runID {
		t.Fatalf("nodes = %#v", payload.Nodes)
	}
	if reader.lastBoardFilter.BoardID != boardID {
		t.Fatalf("board filter = %#v", reader.lastBoardFilter)
	}
}

func TestCreateRunIsIdempotentAndQueuesAfterCompletion(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	issueID := uuid.New()
	agentID := uuid.New()
	runID := uuid.New()
	coordinator := &fakeCoordinator{
		admitted: runrepo.Run{
			ID:        runID,
			IssueID:   issueID,
			BoardID:   uuid.New(),
			AgentID:   agentID,
			Status:    runrepo.StatusQueued,
			CreatedAt: now,
		},
	}
	handlers, cleanup := newHTTPTestHandlers(t, &fakeRunReader{}, coordinator)
	defer cleanup()
	router := chi.NewRouter()
	router.Route("/api/v1/issues/{issueRef}", func(router chi.Router) {
		router.Mount("/runs", handlers.IssueHandler())
	})
	body := []byte(`{"agentId":"` + agentID.String() + `","instructions":"test first"}`)

	first := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/issues/"+issueID.String()+"/runs/",
		bytes.NewReader(body),
	)
	first = first.WithContext(auth.WithUser(first.Context(), testUser()))
	first.Header.Set("Idempotency-Key", "run-create-key-01")
	firstResponse := httptest.NewRecorder()
	router.ServeHTTP(firstResponse, first)

	if firstResponse.Code != http.StatusAccepted {
		t.Fatalf("first status = %d body=%s", firstResponse.Code, firstResponse.Body.String())
	}
	if firstResponse.Header().Get("Location") != "/api/v1/runs/"+runID.String() {
		t.Fatalf("Location = %q", firstResponse.Header().Get("Location"))
	}

	second := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/issues/"+issueID.String()+"/runs/",
		bytes.NewReader(body),
	)
	second = second.WithContext(auth.WithUser(second.Context(), testUser()))
	second.Header.Set("Idempotency-Key", "run-create-key-01")
	secondResponse := httptest.NewRecorder()
	router.ServeHTTP(secondResponse, second)

	if secondResponse.Code != http.StatusAccepted {
		t.Fatalf("second status = %d body=%s", secondResponse.Code, secondResponse.Body.String())
	}
	if secondResponse.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatal("second response was not marked as replayed")
	}
	if firstResponse.Body.String() != secondResponse.Body.String() {
		t.Fatalf(
			"replayed body differs: first=%q second=%q",
			firstResponse.Body.String(),
			secondResponse.Body.String(),
		)
	}
	if coordinator.admits.Load() != 1 || coordinator.queues.Load() != 1 {
		t.Fatalf(
			"admission counts admit=%d queue=%d",
			coordinator.admits.Load(),
			coordinator.queues.Load(),
		)
	}
	if coordinator.params.AgentID == nil || *coordinator.params.AgentID != agentID {
		t.Fatalf("admitted agent = %#v", coordinator.params.AgentID)
	}
}

func newHTTPTestHandlers(
	t *testing.T,
	reader Reader,
	coordinator Coordinator,
) (*Handlers, func()) {
	t.Helper()
	hub, err := realtime.NewHub(8)
	if err != nil {
		t.Fatalf("NewHub() error = %v", err)
	}
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	workspaceID := uuid.New()
	handlers, err := New(Options{
		Repository:       reader,
		Service:          coordinator,
		Sessions:         staticSessions{user: testUser()},
		Authorization:    runAuthorizer{workspaceID: workspaceID},
		Clock:            func() time.Time { return now },
		NewID:            uuid.New,
		IdempotencyStore: &memoryIdempotency{},
		Broadcaster:      hub,
		Retention:        24 * time.Hour,
		Heartbeat:        time.Second,
		PollInterval:     10 * time.Millisecond,
	})
	if err != nil {
		_ = hub.Close()
		t.Fatalf("New() error = %v", err)
	}
	return handlers, func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = handlers.Close(ctx)
		_ = hub.Close()
	}
}

type runAuthorizer struct {
	workspaceID uuid.UUID
	err         error
}

func (authorizer runAuthorizer) scope() (identity.Scope, error) {
	return identity.Scope{
		WorkspaceID: authorizer.workspaceID,
		Role:        identity.RoleOwner,
	}, authorizer.err
}

func (authorizer runAuthorizer) AuthorizeIssue(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return authorizer.scope()
}

func (authorizer runAuthorizer) AuthorizeBoard(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return authorizer.scope()
}

func (authorizer runAuthorizer) AuthorizeRun(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return authorizer.scope()
}

func (authorizer runAuthorizer) AuthorizeAgent(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return authorizer.scope()
}

type staticSessions struct {
	user auth.User
	err  error
}

func (sessions staticSessions) ResolveSession(context.Context, string) (auth.User, error) {
	if sessions.err != nil {
		return auth.User{}, sessions.err
	}
	return sessions.user, nil
}

type fakeRunReader struct {
	run             runrepo.Run
	getErr          error
	events          []runrepo.Event
	cursor          int64
	cursorErr       error
	boardRuns       []runrepo.Run
	lastBoardFilter runrepo.BoardListFilter
}

func (reader *fakeRunReader) Get(context.Context, uuid.UUID) (runrepo.Run, error) {
	if reader.getErr != nil {
		return runrepo.Run{}, reader.getErr
	}
	return reader.run, nil
}

func (reader *fakeRunReader) ListByBoard(
	_ context.Context,
	filter runrepo.BoardListFilter,
) ([]runrepo.Run, error) {
	reader.lastBoardFilter = filter
	if reader.boardRuns != nil {
		return reader.boardRuns, nil
	}
	return nil, nil
}

func (*fakeRunReader) List(
	context.Context,
	runrepo.ListFilter,
) ([]runrepo.Run, error) {
	return nil, nil
}

func (*fakeRunReader) ResolveIssueID(context.Context, string) (uuid.UUID, error) {
	return uuid.New(), nil
}

func (reader *fakeRunReader) ResolveRunCursor(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	time.Time,
) (int64, error) {
	return reader.cursor, reader.cursorErr
}

func (reader *fakeRunReader) ListRunEvents(
	_ context.Context,
	_ uuid.UUID,
	after int64,
	_ time.Time,
	limit int,
) ([]runrepo.Event, error) {
	result := make([]runrepo.Event, 0, limit)
	for _, event := range reader.events {
		if event.Sequence != nil && *event.Sequence > after {
			result = append(result, event)
			if len(result) == limit {
				break
			}
		}
	}
	return result, nil
}

type fakeCoordinator struct {
	admitted runrepo.Run
	admitErr error
	params   runrepo.AdmitParams
	admits   atomic.Int32
	queues   atomic.Int32
}

func (coordinator *fakeCoordinator) Admit(
	_ context.Context,
	params runrepo.AdmitParams,
) (runrepo.Run, error) {
	coordinator.params = params
	coordinator.admits.Add(1)
	return coordinator.admitted, coordinator.admitErr
}

func (coordinator *fakeCoordinator) Queue(uuid.UUID) error {
	coordinator.queues.Add(1)
	return nil
}

func (coordinator *fakeCoordinator) Get(
	context.Context,
	uuid.UUID,
) (runrepo.Run, error) {
	return coordinator.admitted, nil
}

func (coordinator *fakeCoordinator) Cancel(
	context.Context,
	uuid.UUID,
	uuid.UUID,
) (runrepo.Run, error) {
	return coordinator.admitted, nil
}

func (*fakeCoordinator) Close(context.Context) error { return nil }

type memoryIdempotency struct {
	mu          sync.Mutex
	claimID     uuid.UUID
	fingerprint [32]byte
	response    *httpapi.StoredResponse
}

func (store *memoryIdempotency) Begin(
	_ context.Context,
	_ httpapi.ActorScope,
	_ string,
	fingerprint [32]byte,
	_ time.Time,
) (httpapi.IdempotencyResult, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.claimID == uuid.Nil {
		store.claimID = uuid.New()
		store.fingerprint = fingerprint
		return httpapi.IdempotencyResult{
			Decision: httpapi.IdempotencyProceed,
			ClaimID:  store.claimID,
		}, nil
	}
	if store.fingerprint != fingerprint {
		return httpapi.IdempotencyResult{
			Decision: httpapi.IdempotencyConflict,
		}, nil
	}
	if store.response == nil {
		return httpapi.IdempotencyResult{
			Decision: httpapi.IdempotencyInProgress,
		}, nil
	}
	return httpapi.IdempotencyResult{
		Decision: httpapi.IdempotencyReplay,
		Response: *store.response,
	}, nil
}

func (store *memoryIdempotency) Complete(
	_ context.Context,
	claimID uuid.UUID,
	response httpapi.StoredResponse,
	_ time.Time,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if claimID != store.claimID {
		return errors.New("claim mismatch")
	}
	copy := response
	store.response = &copy
	return nil
}

func (store *memoryIdempotency) Abandon(context.Context, uuid.UUID) error {
	return nil
}

func runEvent(
	eventID, runID, boardID, issueID uuid.UUID,
	eventType string,
	sequence int64,
	payload string,
	occurredAt time.Time,
) runrepo.Event {
	run := runID
	seq := sequence
	return runrepo.Event{
		ID:         eventID,
		Type:       eventType,
		OccurredAt: occurredAt,
		BoardID:    boardID,
		IssueID:    issueID,
		RunID:      &run,
		Sequence:   &seq,
		Payload:    json.RawMessage(payload),
	}
}

func testToken() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
}

func testUser() auth.User {
	return auth.User{
		ID:    uuid.MustParse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
		Email: "member@example.com",
		Name:  "Member",
		Role:  auth.RoleMember,
	}
}

func assertErrorCode(t *testing.T, body []byte, expected string) {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("decode error envelope: %v body=%s", err, body)
	}
	if envelope.Error.Code != expected {
		t.Fatalf("error code = %q, want %q", envelope.Error.Code, expected)
	}
}
