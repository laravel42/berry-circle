package resolutions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	repository "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
)

func TestResolvePublishesCommittedEventsAndReturnsRevision(t *testing.T) {
	t.Parallel()
	actorID, workspaceID, commentID := uuid.New(), uuid.New(), uuid.New()
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	event := repository.Event{
		ID:          uuid.New(),
		WorkspaceID: workspaceID,
		Topic:       "comment.resolved",
		Payload:     json.RawMessage(`{"resolved":true}`),
		OccurredAt:  now,
	}
	store := &resolutionStoreFake{result: repository.ResolutionResult{
		Resolution: repository.Resolution{
			CommentID: commentID,
			Revision:  2,
			Resolved:  true,
			At:        &now,
			By: &repository.Actor{
				ID:   actorID,
				Name: "Berry Member",
			},
		},
		Events: []repository.Event{event},
	}}
	hub, err := realtime.NewHub(1)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = hub.Close() })
	subscription, err := hub.Subscribe(context.Background(), workspaceID.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(subscription.Close)
	ids := []uuid.UUID{uuid.New(), uuid.New()}
	options := handlerOptions{
		Store:       store,
		Clock:       func() time.Time { return now },
		NewID:       func() uuid.UUID { id := ids[0]; ids = ids[1:]; return id },
		Broadcaster: hub,
	}
	router := chi.NewRouter()
	router.Post("/comments/{commentId}/resolution", func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		request = request.WithContext(auth.WithUser(request.Context(), auth.User{ID: actorID}))
		resolveHandler(options).ServeHTTP(response, request)
	})
	request := httptest.NewRequest(
		http.MethodPost,
		"/comments/"+commentID.String()+"/resolution",
		strings.NewReader(`{}`),
	)
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), `"revision":2`) ||
		!strings.Contains(response.Body.String(), `"resolved":true`) {
		t.Fatalf("response = %s", response.Body)
	}
	select {
	case published := <-subscription.Events():
		if published.ID != event.ID.String() || published.Type != event.Topic {
			t.Fatalf("published event = %#v", published)
		}
	case <-time.After(time.Second):
		t.Fatal("resolution event was not published")
	}
	if store.resolveCalls != 1 {
		t.Fatalf("ResolveComment() calls = %d, want 1", store.resolveCalls)
	}
}

func TestResolveRejectsUnknownJSONBeforePersistence(t *testing.T) {
	t.Parallel()
	commentID := uuid.New()
	store := &resolutionStoreFake{}
	request := httptest.NewRequest(
		http.MethodPost,
		"/comments/"+commentID.String()+"/resolution",
		strings.NewReader(`{"unexpected":true}`),
	)
	request = request.WithContext(auth.WithUser(request.Context(), auth.User{ID: uuid.New()}))
	response := httptest.NewRecorder()
	router := chi.NewRouter()
	router.Post("/comments/{commentId}/resolution", resolveHandler(handlerOptions{
		Store: store,
		NewID: uuid.New,
		Clock: time.Now,
	}))

	router.ServeHTTP(response, request)

	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body)
	}
	if store.resolveCalls != 0 {
		t.Fatalf("ResolveComment() calls = %d, want 0", store.resolveCalls)
	}
}

type resolutionStoreFake struct {
	result       repository.ResolutionResult
	err          error
	resolveCalls int
}

func (store *resolutionStoreFake) ResolveComment(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
	time.Time,
) (repository.ResolutionResult, error) {
	store.resolveCalls++
	return store.result, store.err
}

func (store *resolutionStoreFake) UnresolveComment(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
	time.Time,
) (repository.ResolutionResult, error) {
	return store.result, store.err
}
