package openfang

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDispatchMessageIsAttemptedOnceOnRetryableResponse(t *testing.T) {
	t.Parallel()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		requests.Add(1)
		http.Error(response, "temporary", http.StatusServiceUnavailable)
	}))
	defer server.Close()

	client, err := New(server.URL, "secret", server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = client.DispatchMessage(context.Background(), uuid.New(), MessageRequest{Message: "run"})
	if err == nil {
		t.Fatal("DispatchMessage() succeeded")
	}
	if requests.Load() != 1 {
		t.Fatalf("request count = %d, want 1", requests.Load())
	}
}

func TestInterruptedDispatchStreamDoesNotRepost(t *testing.T) {
	t.Parallel()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		requests.Add(1)
		if got := request.Header.Get("X-Request-Id"); got != "req_dispatch_1234" {
			t.Errorf("X-Request-Id = %q", got)
		}
		response.Header().Set("Content-Type", "text/event-stream")
		response.Header().Set("X-Request-Id", "upstream-123")
		response.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(response, "event: chunk\ndata: {\"content\":\"partial\"}\n\n")
	}))
	defer server.Close()

	client, err := New(
		server.URL,
		"",
		server.Client(),
		slog.New(slog.DiscardHandler),
		WithStreamTimeout(time.Second),
	)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream, err := client.DispatchMessage(context.Background(), uuid.New(), MessageRequest{
		Message:   "run",
		RequestID: "req_dispatch_1234",
	})
	if err != nil {
		t.Fatalf("DispatchMessage() error = %v", err)
	}
	defer stream.Close()
	if stream.RequestID() != "upstream-123" {
		t.Fatalf("request ID = %q", stream.RequestID())
	}
	event, err := stream.Next()
	if err != nil || event.Content != "partial" {
		t.Fatalf("first event=%#v error=%v", event, err)
	}
	if _, err := stream.Next(); !errors.Is(err, ErrStreamInterrupted) {
		t.Fatalf("second Next() error = %v", err)
	}
	if requests.Load() != 1 {
		t.Fatalf("request count = %d, want 1", requests.Load())
	}
}

// The run bound is wired from orchestration and must cover a whole multi-turn
// run; the blocking chat call keeps its own, shorter bound regardless.
func TestWithStreamTimeoutLeavesTheChatBoundAlone(t *testing.T) {
	t.Parallel()
	client, err := New(
		"http://127.0.0.1:1",
		"",
		nil,
		slog.New(slog.DiscardHandler),
		WithStreamTimeout(2*time.Hour),
		WithStreamTimeout(0),
	)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if client.streamTimeout != 2*time.Hour {
		t.Fatalf("streamTimeout = %s, want 2h", client.streamTimeout)
	}
	if client.messageTimeout != 15*time.Minute {
		t.Fatalf("messageTimeout = %s, want 15m", client.messageTimeout)
	}
}

func TestStopAgentIsAttemptedOnceOnRetryableResponse(t *testing.T) {
	t.Parallel()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		requests.Add(1)
		http.Error(response, "temporary", http.StatusServiceUnavailable)
	}))
	defer server.Close()

	client, err := New(server.URL, "secret", server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = client.StopAgent(context.Background(), uuid.New())
	if err == nil {
		t.Fatal("StopAgent() succeeded")
	}
	if requests.Load() != 1 {
		t.Fatalf("request count = %d, want 1", requests.Load())
	}
}
