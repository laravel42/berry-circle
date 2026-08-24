package platform

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

type checkerFunc func(context.Context) error

func (check checkerFunc) Check(ctx context.Context) error { return check(ctx) }

func testHandler(t *testing.T, options Options) http.Handler {
	t.Helper()
	var registry httpapi.Registry
	for _, mount := range Mounts(options) {
		if err := registry.Register(mount); err != nil {
			t.Fatalf("Register(%s) error = %v", mount.Prefix, err)
		}
	}
	return registry.Handler(httpapi.Options{
		Logger:       slog.New(slog.DiscardHandler),
		NewRequestID: func() string { return "req_platform123" },
	})
}

func TestOperationalEndpoints(t *testing.T) {
	t.Parallel()

	handler := testHandler(t, Options{
		Database:       checkerFunc(func(context.Context) error { return nil }),
		Valkey:         checkerFunc(func(context.Context) error { return nil }),
		MetricsEnabled: true,
		Gatherer:       prometheus.NewRegistry(),
		Capabilities: Capabilities{
			AgentExecution: true,
			Metrics:        true,
			Realtime:       true,
			Storage:        true,
			Valkey:         false,
		},
	})
	for _, path := range []string{"/health", "/ready", "/readyz", "/metrics", "/api/v1/config"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Errorf("GET %s status = %d, want 200; body=%s", path, response.Code, response.Body)
		}
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/api/v1/config", nil),
	)
	var body map[string]map[string]bool
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode config response: %v", err)
	}
	if len(body["capabilities"]) != 5 || !body["capabilities"]["agentExecution"] {
		t.Fatalf("capabilities = %#v, want safe booleans only", body["capabilities"])
	}
}

func TestReadyReportsSafeBooleanChecks(t *testing.T) {
	t.Parallel()

	handler := testHandler(t, Options{
		Database: checkerFunc(func(context.Context) error {
			return errors.New("postgres://user:secret@db/berry")
		}),
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
	if string(response.Body.Bytes()) == "" {
		t.Fatal("ready response body is empty")
	}
	if contains := string(response.Body.Bytes()); contains != "" &&
		(bytesContains(response.Body.Bytes(), []byte("secret")) ||
			bytesContains(response.Body.Bytes(), []byte("postgres://"))) {
		t.Fatalf("ready response exposed dependency error: %s", response.Body)
	}
}

func TestReadyFailsWhenRequiredRealtimeIsUnavailable(t *testing.T) {
	t.Parallel()

	handler := testHandler(t, Options{
		Database: checkerFunc(func(context.Context) error { return nil }),
		Realtime: checkerFunc(func(context.Context) error {
			return errors.New("relay credential must stay private")
		}),
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
	var envelope httpapi.ErrorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode readiness envelope: %v", err)
	}
	if envelope.Error.Code != "NOT_READY" {
		t.Fatalf("error code = %q, want NOT_READY", envelope.Error.Code)
	}
}

func TestMetricsDisabledUsesErrorEnvelope(t *testing.T) {
	t.Parallel()

	handler := testHandler(t, Options{
		Database: checkerFunc(func(context.Context) error { return nil }),
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
	var envelope httpapi.ErrorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if envelope.Error.Code != "NOT_FOUND" {
		t.Fatalf("error code = %q, want NOT_FOUND", envelope.Error.Code)
	}
}

func bytesContains(body, fragment []byte) bool {
	if len(fragment) == 0 || len(body) < len(fragment) {
		return false
	}
	for index := 0; index <= len(body)-len(fragment); index++ {
		matches := true
		for offset := range fragment {
			if body[index+offset] != fragment[offset] {
				matches = false
				break
			}
		}
		if matches {
			return true
		}
	}
	return false
}
