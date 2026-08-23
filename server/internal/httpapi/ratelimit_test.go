package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestMemoryRateLimiterResetsFixedWindow(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	limiter := NewMemoryRateLimiter(func() time.Time { return now })
	for request := 1; request <= 3; request++ {
		decision, err := limiter.Allow(context.Background(), "127.0.0.1", 2, time.Minute)
		if err != nil {
			t.Fatalf("Allow(%d) error = %v", request, err)
		}
		if decision.Allowed != (request <= 2) {
			t.Errorf("Allow(%d).Allowed = %v", request, decision.Allowed)
		}
	}
	now = now.Add(time.Minute)
	decision, err := limiter.Allow(context.Background(), "127.0.0.1", 2, time.Minute)
	if err != nil {
		t.Fatalf("Allow(after reset) error = %v", err)
	}
	if !decision.Allowed || decision.Remaining != 1 {
		t.Fatalf("Allow(after reset) = %#v, want fresh window", decision)
	}
}

type failingLimiter struct{}

func (failingLimiter) Allow(
	context.Context,
	string,
	int64,
	time.Duration,
) (RateDecision, error) {
	return RateDecision{}, errors.New("unavailable")
}

func TestRateLimitFailurePolicy(t *testing.T) {
	t.Parallel()

	next := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})
	for _, test := range []struct {
		name     string
		failOpen bool
		status   int
	}{
		{name: "closed", failOpen: false, status: http.StatusServiceUnavailable},
		{name: "open", failOpen: true, status: http.StatusNoContent},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
			request.RemoteAddr = "127.0.0.1:1234"
			response := httptest.NewRecorder()
			handler := RateLimitByIP(
				failingLimiter{},
				10,
				time.Minute,
				test.failOpen,
				slog.New(slog.DiscardHandler),
			)(next)
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
		})
	}
}
