package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

func TestValkeyRelayUsesVersionedBoundedNamespace(t *testing.T) {
	t.Parallel()

	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	defer client.Close()
	relay, err := NewValkeyRelay(client, ValkeyRelayConfig{
		NodeID:       "node-a",
		Namespace:    "test-unit",
		StreamMaxLen: 32,
		StreamTTL:    time.Minute,
		ReadBlock:    100 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewValkeyRelay() error = %v", err)
	}
	if relay.StreamKey() != "berry:realtime:v1:test-unit:events" {
		t.Fatalf("StreamKey() = %q", relay.StreamKey())
	}
	if _, err := NewValkeyRelay(client, ValkeyRelayConfig{
		NodeID:       "node-a",
		Namespace:    "../unsafe",
		StreamMaxLen: 32,
		StreamTTL:    time.Minute,
		ReadBlock:    100 * time.Millisecond,
	}); err == nil {
		t.Fatal("NewValkeyRelay() accepted an unsafe namespace")
	}
}

func TestDecodeRelayMessageValidatesEnvelopeAndEvent(t *testing.T) {
	t.Parallel()

	envelope := relayEnvelope{
		Version: 1,
		NodeID:  "node-a",
		Event: Event{
			ID:          "event-1",
			WorkspaceID: "workspace-1",
			Type:        "issue.updated",
			Payload:     json.RawMessage(`{"id":"issue-1"}`),
			OccurredAt:  time.Now().UTC(),
		},
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	event, nodeID, err := decodeRelayMessage(redis.XMessage{
		ID:     "1-0",
		Values: map[string]any{"event": string(body)},
	})
	if err != nil {
		t.Fatalf("decodeRelayMessage() error = %v", err)
	}
	if event.ID != "event-1" || nodeID != "node-a" {
		t.Fatalf("decodeRelayMessage() = %#v, %q", event, nodeID)
	}
	envelope.Event.ID = ""
	body, _ = json.Marshal(envelope)
	if _, _, err := decodeRelayMessage(redis.XMessage{
		ID:     "2-0",
		Values: map[string]any{"event": string(body)},
	}); err == nil {
		t.Fatal("decodeRelayMessage() accepted a missing event id")
	}
}

func TestMissingStreamErrorRecognizesCleanValkey(t *testing.T) {
	t.Parallel()

	if !missingStreamError(errors.New("ERR no such key")) ||
		!missingStreamError(redis.Nil) {
		t.Fatal("missingStreamError() did not recognize a missing stream")
	}
	if missingStreamError(errors.New("connection refused")) {
		t.Fatal("missingStreamError() hid a transport failure")
	}
}

func TestValkeyRelayIntegration(t *testing.T) {
	rawURL := strings.TrimSpace(os.Getenv("BERRY_TEST_VALKEY_URL"))
	if rawURL == "" {
		t.Skip("BERRY_TEST_VALKEY_URL is not set")
	}
	if strings.HasPrefix(rawURL, "valkey://") {
		rawURL = "redis://" + strings.TrimPrefix(rawURL, "valkey://")
	}
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		t.Fatalf("redis.ParseURL() error = %v", err)
	}
	firstClient := redis.NewClient(options)
	secondClient := redis.NewClient(options)
	defer firstClient.Close()
	defer secondClient.Close()

	namespace := "test-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	config := ValkeyRelayConfig{
		Namespace:    namespace,
		StreamMaxLen: 32,
		StreamTTL:    time.Minute,
		ReadBlock:    100 * time.Millisecond,
	}
	firstConfig := config
	firstConfig.NodeID = "node-a"
	first, err := NewValkeyRelay(firstClient, firstConfig)
	if err != nil {
		t.Fatalf("NewValkeyRelay(first) error = %v", err)
	}
	secondConfig := config
	secondConfig.NodeID = "node-b"
	second, err := NewValkeyRelay(secondClient, secondConfig)
	if err != nil {
		t.Fatalf("NewValkeyRelay(second) error = %v", err)
	}
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cleanupCancel()
	defer func() {
		if err := firstClient.Del(cleanupCtx, first.StreamKey()).Err(); err != nil {
			t.Errorf("cleanup own relay stream: %v", err)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	received := make(chan Event, 2)
	oldEvent := Event{
		ID:          "event-before-reader",
		WorkspaceID: "workspace-1",
		Type:        "issue.updated",
		Payload:     json.RawMessage(`{"id":"old"}`),
		OccurredAt:  time.Now().UTC(),
	}
	if err := first.Publish(context.Background(), oldEvent); err != nil {
		t.Fatalf("Publish(old) error = %v", err)
	}
	readerDone := make(chan error, 1)
	go func() {
		readerDone <- second.Run(ctx, func(_ context.Context, event Event) error {
			received <- event
			return nil
		})
	}()
	time.Sleep(50 * time.Millisecond)

	event := Event{
		ID:          "event-integration",
		WorkspaceID: "workspace-1",
		Type:        "issue.updated",
		Payload:     json.RawMessage(`{"id":"issue-1"}`),
		OccurredAt:  time.Now().UTC(),
	}
	if err := first.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	select {
	case delivered := <-received:
		if delivered.ID != event.ID || delivered.OriginNodeID != "node-a" {
			t.Fatalf("delivered event = %#v", delivered)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for cross-node event")
	}
	ttl, err := firstClient.TTL(context.Background(), first.StreamKey()).Result()
	if err != nil || ttl <= 0 {
		t.Fatalf("stream TTL = %s, error = %v", ttl, err)
	}
	cancel()
	select {
	case <-readerDone:
	case <-time.After(5 * time.Second):
		t.Fatal("relay reader did not stop after cancellation")
	}
}
