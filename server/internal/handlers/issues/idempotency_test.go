package issues

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

func TestIdempotencyProceedReplayConflictAndInProgress(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	userID := uuid.MustParse("10000000-0000-4000-8000-000000000001")
	body := `{"boardId":"10000000-0000-4000-8000-000000000002","title":"Berry"}`
	key := "idempotency-key-0001"

	t.Run("proceed stores replay-safe response", func(t *testing.T) {
		store := &fakeIdempotencyStore{result: httpapi.IdempotencyResult{
			Decision: httpapi.IdempotencyProceed,
			ClaimID:  uuid.MustParse("20000000-0000-4000-8000-000000000002"),
		}}
		handler := requireIdempotency(
			store,
			func() time.Time { return now },
			http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Location", "/api/v1/issues/one")
				httpapi.WriteJSON(response, http.StatusCreated, map[string]string{"id": "one"})
			}),
		)
		response := serveIdempotent(t, handler, userID, key, body)
		if response.Code != http.StatusCreated ||
			response.Header().Get("Location") != "/api/v1/issues/one" {
			t.Fatalf("response status=%d headers=%v body=%s", response.Code, response.Header(), response.Body)
		}
		if store.completed.Status != http.StatusCreated ||
			store.completed.Headers.Get("Location") != "/api/v1/issues/one" {
			t.Fatalf("completed response = %#v", store.completed)
		}
		if store.scope.ActorID != userID ||
			store.scope.CanonicalPath != "/api/v1/issues" ||
			store.scope.Method != http.MethodPost {
			t.Fatalf("scope = %#v", store.scope)
		}
	})

	t.Run("replay preserves response and marks it", func(t *testing.T) {
		store := &fakeIdempotencyStore{result: httpapi.IdempotencyResult{
			Decision: httpapi.IdempotencyReplay,
			Response: httpapi.StoredResponse{
				Status: http.StatusCreated,
				Headers: map[string][]string{
					"Content-Type": {"application/json"},
					"Location":     {"/api/v1/issues/replayed"},
				},
				Body: []byte(`{"id":"replayed"}`),
			},
		}}
		handler := requireIdempotency(
			store,
			func() time.Time { return now },
			http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Fatal("replay executed the create handler")
			}),
		)
		response := serveIdempotent(t, handler, userID, key, body)
		if response.Code != http.StatusCreated ||
			response.Header().Get("Idempotency-Replayed") != "true" ||
			response.Header().Get("Location") != "/api/v1/issues/replayed" {
			t.Fatalf("replay status=%d headers=%v body=%s", response.Code, response.Header(), response.Body)
		}
	})

	for _, test := range []struct {
		name       string
		decision   httpapi.IdempotencyDecision
		code       string
		retryAfter string
	}{
		{
			name:     "different body conflict",
			decision: httpapi.IdempotencyConflict,
			code:     "IDEMPOTENCY_CONFLICT",
		},
		{
			name:       "request in progress",
			decision:   httpapi.IdempotencyInProgress,
			code:       "CONFLICT",
			retryAfter: "1",
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			store := &fakeIdempotencyStore{result: httpapi.IdempotencyResult{
				Decision: test.decision,
			}}
			handler := requireIdempotency(
				store,
				func() time.Time { return now },
				http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
					t.Fatal("conflict executed the create handler")
				}),
			)
			response := serveIdempotent(t, handler, userID, key, body)
			if response.Code != http.StatusConflict ||
				response.Header().Get("Retry-After") != test.retryAfter {
				t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body)
			}
			var envelope httpapi.ErrorEnvelope
			if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
				t.Fatalf("decode error: %v", err)
			}
			if envelope.Error.Code != test.code {
				t.Fatalf("code=%s want=%s", envelope.Error.Code, test.code)
			}
		})
	}
}

func TestIdempotencyAbandonsPanicsAndCompletionFailures(t *testing.T) {
	t.Parallel()
	userID := uuid.MustParse("10000000-0000-4000-8000-000000000001")
	claimID := uuid.MustParse("20000000-0000-4000-8000-000000000002")
	store := &fakeIdempotencyStore{result: httpapi.IdempotencyResult{
		Decision: httpapi.IdempotencyProceed,
		ClaimID:  claimID,
	}}
	handler := requireIdempotency(
		store,
		time.Now,
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("boom")
		}),
	)
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("panic was not propagated to central recovery")
			}
		}()
		_ = serveIdempotent(t, handler, userID, "idempotency-key-0002", `{"title":"panic"}`)
	}()
	if store.abandoned != claimID {
		t.Fatalf("abandoned claim=%s want=%s", store.abandoned, claimID)
	}

	store = &fakeIdempotencyStore{
		result: httpapi.IdempotencyResult{
			Decision: httpapi.IdempotencyProceed,
			ClaimID:  claimID,
		},
		completeError: errors.New("database unavailable"),
	}
	handler = requireIdempotency(
		store,
		time.Now,
		http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			httpapi.WriteJSON(response, http.StatusCreated, map[string]bool{"ok": true})
		}),
	)
	response := serveIdempotent(t, handler, userID, "idempotency-key-0003", `{"title":"complete"}`)
	if response.Code != http.StatusInternalServerError || store.abandoned != claimID {
		t.Fatalf("status=%d abandoned=%s body=%s", response.Code, store.abandoned, response.Body)
	}
}

func serveIdempotent(
	t *testing.T,
	handler http.Handler,
	userID uuid.UUID,
	key, body string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/issues", strings.NewReader(body))
	request.Header.Set("Idempotency-Key", key)
	request = request.WithContext(auth.WithUser(request.Context(), auth.User{
		ID:   userID,
		Role: auth.RoleMember,
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

type fakeIdempotencyStore struct {
	result        httpapi.IdempotencyResult
	scope         httpapi.ActorScope
	completed     storedResponseWithHeader
	abandoned     uuid.UUID
	completeError error
}

type storedResponseWithHeader struct {
	Status  int
	Headers http.Header
	Body    []byte
}

func (store *fakeIdempotencyStore) Begin(
	_ context.Context,
	scope httpapi.ActorScope,
	_ string,
	_ [32]byte,
	_ time.Time,
) (httpapi.IdempotencyResult, error) {
	store.scope = scope
	return store.result, nil
}

func (store *fakeIdempotencyStore) Complete(
	_ context.Context,
	_ uuid.UUID,
	response httpapi.StoredResponse,
	_ time.Time,
) error {
	store.completed = storedResponseWithHeader{
		Status:  response.Status,
		Headers: http.Header(response.Headers),
		Body:    response.Body,
	}
	return store.completeError
}

func (store *fakeIdempotencyStore) Abandon(_ context.Context, claimID uuid.UUID) error {
	store.abandoned = claimID
	return nil
}
