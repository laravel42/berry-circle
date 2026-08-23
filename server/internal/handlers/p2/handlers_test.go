package p2handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
)

func TestCreateSavedViewIsStrictAndIdempotent(t *testing.T) {
	userID, workspaceID, viewID := uuid.New(), uuid.New(), uuid.New()
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	createCalls := 0
	api := &apiStub{
		createSavedView: func(
			_ context.Context,
			gotUserID, gotWorkspaceID uuid.UUID,
			name, visibility string,
			version int,
			query, display json.RawMessage,
		) (p2repo.SavedView, error) {
			createCalls++
			if gotUserID != userID || gotWorkspaceID != workspaceID ||
				name != "My issues" || visibility != "private" || version != 1 {
				t.Fatalf(
					"create scope=(%s,%s,%q,%q,%d)",
					gotUserID,
					gotWorkspaceID,
					name,
					visibility,
					version,
				)
			}
			if string(query) != `{"assignedToMe":true}` || string(display) != `{}` {
				t.Fatalf("query=%s display=%s", query, display)
			}
			return p2repo.SavedView{
				ID:                viewID,
				WorkspaceID:       workspaceID,
				OwnerID:           userID,
				Name:              name,
				Visibility:        visibility,
				DefinitionVersion: version,
				Query:             query,
				Display:           display,
				Revision:          1,
				CreatedAt:         now,
				UpdatedAt:         now,
			}, nil
		},
	}
	idempotency := newMemoryIdempotency()
	mounts, err := NewMounts(Options{
		Sessions:         staticSessions{user: auth.User{ID: userID, Role: auth.RoleMember}},
		Service:          api,
		IdempotencyStore: idempotency,
		Clock:            func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewMounts() error = %v", err)
	}
	views := findMount(t, mounts, "/api/v1/views")
	body := `{"workspaceId":"` + workspaceID.String() +
		`","name":"My issues","query":{"assignedToMe":true}}`
	first := serveJSON(
		views.Handler,
		http.MethodPost,
		"/",
		body,
		"berry-p2-view-key-0001",
	)
	second := serveJSON(
		views.Handler,
		http.MethodPost,
		"/",
		body,
		"berry-p2-view-key-0001",
	)
	if first.Code != http.StatusCreated || second.Code != http.StatusCreated {
		t.Fatalf(
			"statuses = (%d, %d), bodies=(%s, %s)",
			first.Code,
			second.Code,
			first.Body,
			second.Body,
		)
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("replay body differs: first=%s second=%s", first.Body, second.Body)
	}
	if createCalls != 1 {
		t.Fatalf("CreateSavedView() calls = %d, want 1", createCalls)
	}

	unknown := serveJSON(
		views.Handler,
		http.MethodPost,
		"/",
		body[:len(body)-1]+`,"recipientId":"`+uuid.NewString()+`"}`,
		"berry-p2-view-key-0002",
	)
	if unknown.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown field status=%d body=%s", unknown.Code, unknown.Body)
	}
	if createCalls != 1 {
		t.Fatalf("unknown field reached service, calls=%d", createCalls)
	}
}

func TestInboxRecipientComesOnlyFromAuthenticatedSession(t *testing.T) {
	userID, workspaceID, itemID := uuid.New(), uuid.New(), uuid.New()
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	api := &apiStub{
		listInbox: func(
			_ context.Context,
			gotUserID, gotWorkspaceID uuid.UUID,
			filter p2repo.InboxFilter,
		) ([]p2repo.InboxItem, error) {
			if gotUserID != userID || gotWorkspaceID != workspaceID {
				t.Fatalf(
					"recipient scope=(%s,%s), want (%s,%s)",
					gotUserID,
					gotWorkspaceID,
					userID,
					workspaceID,
				)
			}
			if filter.State != "active" || filter.Limit != 51 {
				t.Fatalf("filter=%#v", filter)
			}
			return []p2repo.InboxItem{{
				ID:          itemID,
				WorkspaceID: workspaceID,
				RecipientID: userID,
				EventType:   "comment.created",
				Category:    "comments",
				Severity:    "info",
				Title:       "New comment",
				Details:     json.RawMessage(`{}`),
				CreatedAt:   now,
			}}, nil
		},
	}
	mounts, err := NewMounts(Options{
		Sessions:         staticSessions{user: auth.User{ID: userID, Role: auth.RoleMember}},
		Service:          api,
		IdempotencyStore: newMemoryIdempotency(),
		Clock:            func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewMounts() error = %v", err)
	}
	inbox := findMount(t, mounts, "/api/v1/inbox")
	request := httptest.NewRequest(
		http.MethodGet,
		"/?workspaceId="+workspaceID.String(),
		nil,
	)
	request.Header.Set("Authorization", "Bearer "+testToken())
	response := httptest.NewRecorder()
	inbox.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var payload struct {
		Nodes []struct {
			RecipientID uuid.UUID `json:"recipientId"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(payload.Nodes) != 1 || payload.Nodes[0].RecipientID != userID {
		t.Fatalf("nodes=%#v", payload.Nodes)
	}

	malicious := serveJSON(
		inbox.Handler,
		http.MethodPost,
		"/bulk",
		`{"workspaceId":"`+workspaceID.String()+
			`","recipientId":"`+uuid.NewString()+
			`","action":"read","itemIds":["`+itemID.String()+`"]}`,
		"",
	)
	if malicious.Code != http.StatusUnprocessableEntity {
		t.Fatalf("malicious status=%d body=%s", malicious.Code, malicious.Body)
	}
}

func serveJSON(
	handler http.Handler,
	method, target, body, idempotencyKey string,
) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+testToken())
	request.Header.Set("Content-Type", "application/json")
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func findMount(t *testing.T, mounts []httpapi.Mount, prefix string) httpapi.Mount {
	t.Helper()
	for _, mount := range mounts {
		if mount.Prefix == prefix {
			return mount
		}
	}
	t.Fatalf("mount %q not found", prefix)
	return httpapi.Mount{}
}

func testToken() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
}

type staticSessions struct {
	user auth.User
	err  error
}

func (sessions staticSessions) ResolveSession(
	context.Context,
	string,
) (auth.User, error) {
	return sessions.user, sessions.err
}

type apiStub struct {
	API
	createSavedView func(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		string,
		string,
		int,
		json.RawMessage,
		json.RawMessage,
	) (p2repo.SavedView, error)
	listInbox func(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		p2repo.InboxFilter,
	) ([]p2repo.InboxItem, error)
}

func (api *apiStub) CreateSavedView(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	name, visibility string,
	version int,
	query, display json.RawMessage,
) (p2repo.SavedView, error) {
	return api.createSavedView(
		ctx,
		userID,
		workspaceID,
		name,
		visibility,
		version,
		query,
		display,
	)
}

func (api *apiStub) ListInbox(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter p2repo.InboxFilter,
) ([]p2repo.InboxItem, error) {
	return api.listInbox(ctx, userID, workspaceID, filter)
}

type memoryIdempotency struct {
	mu      sync.Mutex
	records map[string]*idempotencyRecord
	claims  map[uuid.UUID]string
}

type idempotencyRecord struct {
	claimID     uuid.UUID
	fingerprint [32]byte
	response    *httpapi.StoredResponse
}

func newMemoryIdempotency() *memoryIdempotency {
	return &memoryIdempotency{
		records: make(map[string]*idempotencyRecord),
		claims:  make(map[uuid.UUID]string),
	}
}

func (store *memoryIdempotency) Begin(
	_ context.Context,
	scope httpapi.ActorScope,
	key string,
	fingerprint [32]byte,
	_ time.Time,
) (httpapi.IdempotencyResult, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	recordKey := scope.ActorID.String() + ":" + scope.Method + ":" +
		scope.CanonicalPath + ":" + key
	record, exists := store.records[recordKey]
	if !exists {
		claimID := uuid.New()
		store.records[recordKey] = &idempotencyRecord{
			claimID:     claimID,
			fingerprint: fingerprint,
		}
		store.claims[claimID] = recordKey
		return httpapi.IdempotencyResult{
			Decision: httpapi.IdempotencyProceed,
			ClaimID:  claimID,
		}, nil
	}
	if record.fingerprint != fingerprint {
		return httpapi.IdempotencyResult{Decision: httpapi.IdempotencyConflict}, nil
	}
	if record.response == nil {
		return httpapi.IdempotencyResult{Decision: httpapi.IdempotencyInProgress}, nil
	}
	return httpapi.IdempotencyResult{
		Decision: httpapi.IdempotencyReplay,
		Response: *record.response,
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
	key, exists := store.claims[claimID]
	if !exists {
		return errors.New("unknown idempotency claim")
	}
	copy := response
	store.records[key].response = &copy
	return nil
}

func (store *memoryIdempotency) Abandon(
	_ context.Context,
	claimID uuid.UUID,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	key, exists := store.claims[claimID]
	if exists {
		delete(store.records, key)
		delete(store.claims, claimID)
	}
	return nil
}
