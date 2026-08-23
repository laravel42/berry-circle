package channels

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

	"github.com/laravel42/berry-circle/server/internal/repository/conversations"
)

const testSecret = "0123456789abcdef0123456789abcdef"

type stubStore struct {
	calls []conversations.InboundMessage
	err   error
}

func (store *stubStore) RecordInbound(
	_ context.Context,
	message conversations.InboundMessage,
	_ time.Time,
) (conversations.Recorded, error) {
	store.calls = append(store.calls, message)
	if store.err != nil {
		return conversations.Recorded{}, store.err
	}
	return conversations.Recorded{
		ConversationID: uuid.New(), MessageID: uuid.New(), Created: true,
	}, nil
}

func mount(t *testing.T, store Store) http.Handler {
	t.Helper()
	m, err := NewMount(Options{Store: store, Secret: testSecret})
	if err != nil {
		t.Fatalf("NewMount: %v", err)
	}
	return m.Handler
}

func post(handler http.Handler, secret, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/channels/inbound",
		strings.NewReader(body))
	if secret != "" {
		request.Header.Set("X-Berry-Webhook-Secret", secret)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

const samplePayload = `{"results":[{"messageId":"ib-1","from":"447700900111",
"channel":"WHATSAPP","message":{"text":"ship the login page"}}]}`

// A webhook without a secret must never be mountable: it would let anyone post
// as any user, and in this product a user's word approves agent work.
func TestMountRequiresStrongSecret(t *testing.T) {
	for name, secret := range map[string]string{"empty": "", "short": "abc123"} {
		if _, err := NewMount(Options{Store: &stubStore{}, Secret: secret}); err == nil {
			t.Errorf("%s secret: expected NewMount to fail", name)
		}
	}
}

func TestRejectsMissingOrWrongSecret(t *testing.T) {
	store := &stubStore{}
	handler := mount(t, store)
	for name, secret := range map[string]string{
		"absent": "",
		"wrong":  strings.Repeat("f", len(testSecret)),
		"prefix": testSecret[:len(testSecret)-1],
	} {
		if got := post(handler, secret, samplePayload).Code; got != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, want 401", name, got)
		}
	}
	if len(store.calls) != 0 {
		t.Fatalf("unauthorized requests reached the store %d times", len(store.calls))
	}
}

func TestAcceptsInboundMessage(t *testing.T) {
	store := &stubStore{}
	recorder := post(mount(t, store), testSecret, samplePayload)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body)
	}
	if len(store.calls) != 1 {
		t.Fatalf("store calls = %d, want 1", len(store.calls))
	}
	call := store.calls[0]
	if call.ExternalID != "ib-1" || call.Channel != "WHATSAPP" {
		t.Fatalf("unexpected message: %+v", call)
	}
	if call.Body != "ship the login page" {
		t.Fatalf("body = %q", call.Body)
	}
}

// A stranger messaging the business number is expected, not an error. It must
// be dropped rather than attributed, and must still return 200 so the provider
// stops retrying.
func TestUnknownSenderIsIgnoredNotAttributed(t *testing.T) {
	store := &stubStore{err: conversations.ErrUnknownSender}
	recorder := post(mount(t, store), testSecret, samplePayload)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	var body map[string]int
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	if body["accepted"] != 0 || body["ignored"] != 1 {
		t.Fatalf("body = %v, want 0 accepted / 1 ignored", body)
	}
}

// A storage failure must return non-2xx so the provider retries. Idempotency on
// the provider message id is what makes that retry safe.
func TestStorageFailureAsksProviderToRetry(t *testing.T) {
	store := &stubStore{err: errors.New("database down")}
	recorder := post(mount(t, store), testSecret, samplePayload)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "database down") {
		t.Fatalf("internal error leaked to an untrusted caller: %s", recorder.Body)
	}
}

// Providers add fields; a brief from a phone must not fail because of one.
func TestUnknownFieldsAreTolerated(t *testing.T) {
	store := &stubStore{}
	payload := `{"results":[{"messageId":"ib-2","from":"447700900111",
	"channel":"WHATSAPP","content":{"text":"hello"},"somethingNew":{"a":1}}],
	"pendingMessageCount":0}`
	if got := post(mount(t, store), testSecret, payload).Code; got != http.StatusOK {
		t.Fatalf("status = %d, want 200", got)
	}
	if len(store.calls) != 1 || store.calls[0].Body != "hello" {
		t.Fatalf("calls = %+v", store.calls)
	}
}

func TestEmptyMessagesAreIgnored(t *testing.T) {
	store := &stubStore{}
	payload := `{"results":[{"messageId":"ib-3","from":"x","channel":"SMS","message":{"text":"  "}}]}`
	recorder := post(mount(t, store), testSecret, payload)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if len(store.calls) != 0 {
		t.Fatal("an empty message reached the store")
	}
}
