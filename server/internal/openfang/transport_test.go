package openfang

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestUnsafePostIsNeverRetriedAndErrorIsRedacted(t *testing.T) {
	t.Parallel()

	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		requests.Add(1)
		http.Error(response, request.Header.Get("Authorization"), http.StatusInternalServerError)
	}))
	defer server.Close()

	const key = "very-secret-upstream-key"
	client, err := New(server.URL, key, server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	request, err := client.NewJSONRequest(
		context.Background(),
		http.MethodPost,
		"/api/agents/id/message/stream",
		map[string]string{"message": "run"},
	)
	if err != nil {
		t.Fatalf("NewJSONRequest() error = %v", err)
	}
	_, err = client.Do(context.Background(), request, RetryUnsafe)
	if err == nil {
		t.Fatal("Do() succeeded, want upstream error")
	}
	if requests.Load() != 1 {
		t.Fatalf("request count = %d, want exactly 1", requests.Load())
	}
	if strings.Contains(err.Error(), key) {
		t.Fatalf("Do() error exposed API key: %v", err)
	}
}

func TestReadRetriesTransientFailure(t *testing.T) {
	t.Parallel()

	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		if requests.Add(1) == 1 {
			http.Error(response, "temporary", http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(response, `{"ok":true}`)
	}))
	defer server.Close()

	client, err := New(server.URL, "", server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	client.baseBackoff = time.Millisecond
	client.maxBackoff = 2 * time.Millisecond
	request, _ := client.NewJSONRequest(context.Background(), http.MethodGet, "/api/agents", nil)
	response, err := client.Do(context.Background(), request, RetryRead)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	defer response.Body.Close()
	if requests.Load() != 2 {
		t.Fatalf("request count = %d, want 2", requests.Load())
	}
}

func TestRetryClassRejectsUnsafeMethodPairing(t *testing.T) {
	t.Parallel()

	client, err := New("http://127.0.0.1:1", "", nil, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	request, _ := client.NewJSONRequest(
		context.Background(),
		http.MethodPost,
		"/api/workflows/id/run",
		map[string]string{"input": "run"},
	)
	if _, err := client.Do(context.Background(), request, RetryRead); err == nil {
		t.Fatal("Do() accepted POST with read retry class")
	}
}

// The retry class is a safety boundary, so the method rules it enforces are
// asserted rather than assumed. Agent configuration is sent as PATCH, and
// rejecting it here fails the request before it is ever dispatched — which
// surfaces to a user as an unavailable runtime rather than a bug.
func TestRetryClassMethodRules(t *testing.T) {
	cases := []struct {
		name   string
		method string
		class  RetryClass
		allow  bool
		ok     bool
	}{
		{"read GET", http.MethodGet, RetryRead, true, true},
		{"read HEAD", http.MethodHead, RetryRead, true, true},
		{"read rejects POST", http.MethodPost, RetryRead, false, false},
		{"idempotent PUT", http.MethodPut, RetryIdempotentWrite, true, true},
		{"idempotent PATCH", http.MethodPatch, RetryIdempotentWrite, true, true},
		{"idempotent DELETE", http.MethodDelete, RetryIdempotentWrite, true, true},
		{"idempotent rejects POST", http.MethodPost, RetryIdempotentWrite, false, false},
		{"unsafe never retries", http.MethodPost, RetryUnsafe, false, true},
	}
	for _, testCase := range cases {
		allow, err := retryAllowed(testCase.method, testCase.class)
		if (err == nil) != testCase.ok {
			t.Errorf("%s: err = %v, want ok = %v", testCase.name, err, testCase.ok)
		}
		if allow != testCase.allow {
			t.Errorf("%s: allow = %v, want %v", testCase.name, allow, testCase.allow)
		}
	}
}
