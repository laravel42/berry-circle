package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestWebSocketRequiresOriginAndAuthenticatedScope(t *testing.T) {
	t.Parallel()

	hub, _ := NewHub(4)
	defer hub.Close()
	handler := WebSocketHandler{
		Hub: hub,
		Scope: func(context.Context, *http.Request) (string, error) {
			return "workspace-1", nil
		},
		CheckOrigin: func(request *http.Request) bool {
			return request.Header.Get("Origin") == "https://berry.test"
		},
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/realtime", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("missing-origin status = %d, want 403", response.Code)
	}

	handler.Scope = func(context.Context, *http.Request) (string, error) {
		return "", errors.New("denied")
	}
	request = httptest.NewRequest(http.MethodGet, "/api/v1/realtime", nil)
	request.Header.Set("Origin", "https://berry.test")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("denied-scope status = %d, want 403", response.Code)
	}

	handler.Scope = nil
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing-scope status = %d, want 503", response.Code)
	}
}

func TestWebSocketDeliversInvalidationsAndRejectsClientData(t *testing.T) {
	t.Parallel()

	hub, _ := NewHub(4)
	defer hub.Close()
	metrics := &AtomicMetrics{}
	handler := WebSocketHandler{
		Hub: hub,
		Scope: func(context.Context, *http.Request) (string, error) {
			return "workspace-1", nil
		},
		CheckOrigin: func(request *http.Request) bool {
			return request.Header.Get("Origin") == "https://berry.test"
		},
		Observer:  metrics,
		PingEvery: time.Second,
		PongWait:  2 * time.Second,
		WriteWait: time.Second,
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	connection := dialWebSocket(t, server.URL, "https://berry.test")
	defer connection.Close()
	event := Event{
		ID:          "event-1",
		WorkspaceID: "workspace-1",
		Type:        "issue.updated",
		Payload:     json.RawMessage(`{"issueId":"issue-1"}`),
		OccurredAt:  time.Now(),
	}
	if err := hub.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	var received Event
	if err := connection.ReadJSON(&received); err != nil {
		t.Fatalf("ReadJSON() error = %v", err)
	}
	if received.ID != event.ID || received.WorkspaceID != event.WorkspaceID {
		t.Fatalf("received event = %#v", received)
	}
	if err := connection.WriteMessage(websocket.TextMessage, []byte(`{"arbitrary":true}`)); err != nil {
		t.Fatalf("WriteMessage() error = %v", err)
	}
	_, _, err := connection.ReadMessage()
	var closeError *websocket.CloseError
	if !errors.As(err, &closeError) || closeError.Code != websocket.ClosePolicyViolation {
		t.Fatalf("ReadMessage() error = %v, want policy-violation close", err)
	}
	waitUntil(t, time.Second, func() bool {
		snapshot := metrics.Snapshot()
		return snapshot.ClientRejected == 1 && snapshot.Delivered == 1 &&
			snapshot.Connections == 0
	})
}

func TestWebSocketBoundsInboundMessages(t *testing.T) {
	t.Parallel()

	hub, _ := NewHub(2)
	defer hub.Close()
	handler := WebSocketHandler{
		Hub: hub,
		Scope: func(context.Context, *http.Request) (string, error) {
			return "workspace-1", nil
		},
		CheckOrigin: func(*http.Request) bool { return true },
		ReadLimit:   8,
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	connection := dialWebSocket(t, server.URL, "https://berry.test")
	defer connection.Close()
	if err := connection.WriteMessage(
		websocket.TextMessage,
		[]byte(strings.Repeat("x", 64)),
	); err != nil {
		t.Fatalf("WriteMessage() error = %v", err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(time.Second))
	_, _, err := connection.ReadMessage()
	var closeError *websocket.CloseError
	if !errors.As(err, &closeError) || closeError.Code != websocket.CloseMessageTooBig {
		t.Fatalf("ReadMessage() error = %v, want message-too-big close", err)
	}
}

func dialWebSocket(t *testing.T, serverURL, origin string) *websocket.Conn {
	t.Helper()
	headers := make(http.Header)
	headers.Set("Origin", origin)
	connection, response, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(serverURL, "http"),
		headers,
	)
	if err != nil {
		if response != nil {
			t.Fatalf("Dial() status/error = %d / %v", response.StatusCode, err)
		}
		t.Fatalf("Dial() error = %v", err)
	}
	return connection
}
