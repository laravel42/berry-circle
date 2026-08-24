package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRouterUsesCentralEnvelopesAndRequestIDs(t *testing.T) {
	t.Parallel()

	var registry Registry
	panicHandler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("internal-secret")
	})
	if err := registry.Register(Mount{Prefix: "/panic", Handler: panicHandler}); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	handler := registry.Handler(Options{
		Logger:       slog.New(slog.DiscardHandler),
		NewRequestID: func() string { return "req_generated123" },
	})

	for _, test := range []struct {
		name      string
		path      string
		requestID string
		status    int
		code      string
		wantID    string
	}{
		{
			name:      "not found",
			path:      "/missing",
			requestID: "client-request-123",
			status:    http.StatusNotFound,
			code:      "NOT_FOUND",
			wantID:    "client-request-123",
		},
		{
			name:      "recovery",
			path:      "/panic",
			requestID: "bad id",
			status:    http.StatusInternalServerError,
			code:      "INTERNAL",
			wantID:    "req_generated123",
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			request.Header.Set("X-Request-Id", test.requestID)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			var envelope ErrorEnvelope
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("decode error envelope: %v", err)
			}
			if envelope.Error.Code != test.code || envelope.Error.RequestID != test.wantID {
				t.Fatalf("error = %#v, want code %s requestId %s", envelope.Error, test.code, test.wantID)
			}
			if response.Header().Get("X-Request-Id") != test.wantID {
				t.Fatalf("X-Request-Id = %q, want %q", response.Header().Get("X-Request-Id"), test.wantID)
			}
			if response.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("security headers are missing")
			}
		})
	}
}

func TestSubrouterUsesCentralMethodNotAllowedEnvelope(t *testing.T) {
	t.Parallel()

	subrouter := NewSubrouter()
	subrouter.Get("/", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})
	var registry Registry
	if err := registry.Register(Mount{Prefix: "/thing", Handler: subrouter}); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	handler := registry.Handler(Options{
		Logger:       slog.New(slog.DiscardHandler),
		NewRequestID: func() string { return "req_generated123" },
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodPost, "/thing", nil),
	)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", response.Code)
	}
	var envelope ErrorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if envelope.Error.Code != "METHOD_NOT_ALLOWED" {
		t.Fatalf("error code = %q, want METHOD_NOT_ALLOWED", envelope.Error.Code)
	}
}

func TestCORSAllowsConfiguredOriginAndRejectsOthers(t *testing.T) {
	t.Parallel()

	subrouter := NewSubrouter()
	subrouter.Get("/", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})
	var registry Registry
	_ = registry.Register(Mount{Prefix: "/config", Handler: subrouter})
	handler := registry.Handler(Options{
		Logger:         slog.New(slog.DiscardHandler),
		TrustedOrigins: []string{"https://app.example"},
		NewRequestID:   func() string { return "req_generated123" },
	})

	allowed := httptest.NewRequest(http.MethodGet, "/config", nil)
	allowed.Header.Set("Origin", "https://app.example")
	allowedResponse := httptest.NewRecorder()
	handler.ServeHTTP(allowedResponse, allowed)
	if allowedResponse.Code != http.StatusNoContent {
		t.Fatalf("allowed status = %d, want 204", allowedResponse.Code)
	}
	if allowedResponse.Header().Get("Access-Control-Allow-Origin") != "https://app.example" {
		t.Fatal("configured origin was not reflected")
	}

	blocked := httptest.NewRequest(http.MethodGet, "/config", nil)
	blocked.Header.Set("Origin", "https://evil.example")
	blockedResponse := httptest.NewRecorder()
	handler.ServeHTTP(blockedResponse, blocked)
	if blockedResponse.Code != http.StatusForbidden {
		t.Fatalf("blocked status = %d, want 403", blockedResponse.Code)
	}
}

func TestCORSAllowsPrivateDevelopmentOrigin(t *testing.T) {
	t.Parallel()

	subrouter := NewSubrouter()
	subrouter.Get("/", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})
	var registry Registry
	_ = registry.Register(Mount{Prefix: "/config", Handler: subrouter})
	handler := registry.Handler(Options{
		Logger:                     slog.New(slog.DiscardHandler),
		AllowPrivateBrowserOrigins: true,
		NewRequestID:               func() string { return "req_generated123" },
	})

	private := httptest.NewRequest(http.MethodGet, "/config", nil)
	private.Header.Set("Origin", "http://192.168.0.86:3000")
	privateResponse := httptest.NewRecorder()
	handler.ServeHTTP(privateResponse, private)
	if privateResponse.Code != http.StatusNoContent {
		t.Fatalf("private status = %d, want 204", privateResponse.Code)
	}

	blocked := httptest.NewRequest(http.MethodGet, "/config", nil)
	blocked.Header.Set("Origin", "https://evil.example")
	blockedResponse := httptest.NewRecorder()
	handler.ServeHTTP(blockedResponse, blocked)
	if blockedResponse.Code != http.StatusForbidden {
		t.Fatalf("blocked status = %d, want 403", blockedResponse.Code)
	}
}

func TestRegistryRejectsOverlappingMounts(t *testing.T) {
	t.Parallel()

	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	var registry Registry
	if err := registry.Register(Mount{Prefix: "/api/v1/issues", Handler: handler}); err != nil {
		t.Fatalf("Register(first) error = %v", err)
	}
	if err := registry.Register(Mount{Prefix: "/api/v1/issues/runs", Handler: handler}); err == nil {
		t.Fatal("Register() accepted overlapping domain mounts")
	}
}
