package infobip

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(Options{
		BaseURL: server.URL,
		APIKey:  "secret-key",
		Senders: map[Channel]string{ChannelWhatsApp: "447700900000"},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return client
}

func TestRejectsInvalidConfiguration(t *testing.T) {
	cases := map[string]Options{
		"no base url":  {APIKey: "k"},
		"no key":       {BaseURL: "https://x.api.infobip.com"},
		"bad scheme":   {BaseURL: "ftp://x.api.infobip.com", APIKey: "k"},
		"credentialed": {BaseURL: "https://u:p@x.api.infobip.com", APIKey: "k"},
	}
	for name, options := range cases {
		if _, err := New(options); err == nil {
			t.Errorf("%s: expected configuration to be rejected", name)
		}
	}
}

func TestWebRTCTokenSendsIdentityAndKey(t *testing.T) {
	var gotAuth, gotPath string
	var payload map[string]any
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&payload)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":          "jwt-value",
			"expirationTime": "2026-08-23T19:50:38Z",
		})
	})

	token, err := client.IssueWebRTCToken(
		context.Background(), "user-1234", "Alice Example", 2*time.Hour,
	)
	if err != nil {
		t.Fatalf("IssueWebRTCToken: %v", err)
	}
	if token.Token != "jwt-value" {
		t.Fatalf("token = %q", token.Token)
	}
	if gotPath != "/webrtc/1/token" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "App secret-key" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	if payload["identity"] != "user-1234" {
		t.Fatalf("identity = %v", payload["identity"])
	}
	if payload["timeToLive"] != float64(7200) {
		t.Fatalf("timeToLive = %v", payload["timeToLive"])
	}
}

// A display name below the provider minimum must be dropped, not sent and
// rejected — the call should still connect.
func TestShortDisplayNameIsDropped(t *testing.T) {
	var payload map[string]any
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&payload)
		_ = json.NewEncoder(w).Encode(map[string]any{"token": "t"})
	})
	if _, err := client.IssueWebRTCToken(context.Background(), "user-1", "Al", 0); err != nil {
		t.Fatalf("IssueWebRTCToken: %v", err)
	}
	if _, present := payload["displayName"]; present {
		t.Fatal("a too-short display name was sent to the provider")
	}
}

func TestSendMessageUsesConfiguredSender(t *testing.T) {
	var payload map[string]any
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&payload)
		_ = json.NewEncoder(w).Encode(map[string]any{"messageId": "m-1"})
	})
	result, err := client.SendMessage(context.Background(), OutboundMessage{
		Channel: ChannelWhatsApp, To: "447700900111", Text: "Plan ready to approve",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if result.MessageID != "m-1" {
		t.Fatalf("messageId = %q", result.MessageID)
	}
	if payload["from"] != "447700900000" {
		t.Fatalf("from = %v, want the configured sender", payload["from"])
	}
}

// Delivering to a channel with no sender configured must fail loudly at the
// call site rather than silently doing nothing.
func TestUnconfiguredChannelIsRejected(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("request should not have been made")
	})
	if _, err := client.SendMessage(context.Background(), OutboundMessage{
		Channel: ChannelSMS, To: "447700900111", Text: "hi",
	}); err == nil {
		t.Fatal("expected an error for an unconfigured channel")
	}
}

// Provider errors must not echo the response body: it can contain message text.
func TestErrorsDoNotLeakProviderBody(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"secret":"super-sensitive-content"}`))
	})
	_, err := client.IssueWebRTCToken(context.Background(), "user-1", "", 0)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "super-sensitive") {
		t.Fatalf("provider body leaked into error: %v", err)
	}
	var providerErr *Error
	if !errorsAs(err, &providerErr) || providerErr.Code != "AUTH" {
		t.Fatalf("error = %v, want classified AUTH", err)
	}
	if providerErr.Retryable {
		t.Fatal("an auth failure must not be marked retryable")
	}
}

func errorsAs(err error, target **Error) bool {
	cast, ok := err.(*Error)
	if ok {
		*target = cast
	}
	return ok
}
