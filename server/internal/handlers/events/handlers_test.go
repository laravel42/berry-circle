package events

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	runrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
)

func TestBoardEventMountRequiresAuthentication(t *testing.T) {
	store := &eventStore{}
	mount, cleanup := newEventTestMount(t, store)
	defer cleanup()
	request := httptest.NewRequest(
		http.MethodGet,
		"/?boardId="+uuid.NewString(),
		nil,
	)
	response := httptest.NewRecorder()

	mount.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if store.existsCalls.Load() != 0 {
		t.Fatalf("store calls = %d, want 0", store.existsCalls.Load())
	}
}

func TestBoardEventStreamReplaysPersistedEnvelope(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	boardID := uuid.New()
	issueID := uuid.New()
	runID := uuid.New()
	sequence := int64(1)
	eventID := uuid.New()
	store := &eventStore{
		exists: true,
		events: []runrepo.Event{{
			ID:         eventID,
			Type:       "run.started",
			OccurredAt: now,
			BoardID:    boardID,
			IssueID:    issueID,
			RunID:      &runID,
			Sequence:   &sequence,
			Payload:    json.RawMessage(`{"startedAt":"2026-08-22T12:00:00Z"}`),
		}},
	}
	mount, cleanup := newEventTestMount(t, store)
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	store.cancel = cancel
	request := httptest.NewRequest(
		http.MethodGet,
		"/?boardId="+boardID.String(),
		nil,
	).WithContext(ctx)
	request.Header.Set("Authorization", "Bearer "+eventTestToken())
	response := httptest.NewRecorder()

	mount.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.HasPrefix(body, "retry: 3000\n\n") ||
		!strings.Contains(body, "id: "+eventID.String()) ||
		!strings.Contains(body, "event: run.started") {
		t.Fatalf("stream body = %q", body)
	}
	var dataLine string
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "data: ") {
			dataLine = strings.TrimPrefix(line, "data: ")
			break
		}
	}
	var envelope map[string]any
	if dataLine == "" || json.Unmarshal([]byte(dataLine), &envelope) != nil {
		t.Fatalf("invalid data line = %q", dataLine)
	}
	if envelope["id"] != eventID.String() || envelope["type"] != "run.started" {
		t.Fatalf("envelope = %#v", envelope)
	}
}

func newEventTestMount(
	t *testing.T,
	store Store,
) (http.Handler, func()) {
	t.Helper()
	hub, err := realtime.NewHub(8)
	if err != nil {
		t.Fatalf("NewHub() error = %v", err)
	}
	mount, err := NewMount(Options{
		Store:         store,
		Sessions:      eventSessions{},
		Authorization: eventAuthorizer{},
		Clock:         func() time.Time { return time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC) },
		Broadcaster:   hub,
		Retention:     24 * time.Hour,
		Heartbeat:     10 * time.Millisecond,
		PollInterval:  time.Millisecond,
	})
	if err != nil {
		_ = hub.Close()
		t.Fatalf("NewMount() error = %v", err)
	}
	return mount.Handler, func() { _ = hub.Close() }
}

type eventSessions struct{}

func (eventSessions) ResolveSession(context.Context, string) (auth.User, error) {
	return auth.User{ID: uuid.New(), Role: auth.RoleMember}, nil
}

type eventAuthorizer struct{}

func (eventAuthorizer) AuthorizeBoard(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: identity.RoleViewer}, nil
}

type eventStore struct {
	exists      bool
	events      []runrepo.Event
	cancel      context.CancelFunc
	existsCalls atomic.Int32
	listCalls   atomic.Int32
}

func (store *eventStore) BoardExists(context.Context, uuid.UUID) (bool, error) {
	store.existsCalls.Add(1)
	return store.exists, nil
}

func (*eventStore) ResolveBoardCursor(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	time.Time,
) (runrepo.BoardCursor, error) {
	return runrepo.BoardCursor{}, nil
}

func (store *eventStore) ListBoardEvents(
	context.Context,
	uuid.UUID,
	*runrepo.BoardCursor,
	time.Time,
	int,
) ([]runrepo.Event, error) {
	if store.listCalls.Add(1) == 1 {
		if store.cancel != nil {
			store.cancel()
		}
		return store.events, nil
	}
	return nil, nil
}

func eventTestToken() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
}
