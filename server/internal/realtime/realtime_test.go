package realtime

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestHubDisconnectsOverflowedSubscriber(t *testing.T) {
	t.Parallel()

	hub, err := NewHub(1)
	if err != nil {
		t.Fatalf("NewHub() error = %v", err)
	}
	defer hub.Close()
	subscription, err := hub.Subscribe(context.Background(), "workspace-1")
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer subscription.Close()

	event := Event{
		WorkspaceID: "workspace-1",
		Type:        "issue.updated",
		Payload:     json.RawMessage(`{"id":"one"}`),
		OccurredAt:  time.Now(),
	}
	if err := hub.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish(first) error = %v", err)
	}
	if err := hub.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish(second) error = %v", err)
	}
	if hub.SubscriberCount() != 0 {
		t.Fatalf("SubscriberCount() = %d, want 0", hub.SubscriberCount())
	}
	if hub.OverflowCount() != 1 {
		t.Fatalf("OverflowCount() = %d, want 1", hub.OverflowCount())
	}
	<-subscription.Events()
	if _, ok := <-subscription.Events(); ok {
		t.Fatal("overflowed subscription channel remained open")
	}
}

func TestSubscriptionCancellationCleansUp(t *testing.T) {
	t.Parallel()

	hub, err := NewHub(2)
	if err != nil {
		t.Fatalf("NewHub() error = %v", err)
	}
	defer hub.Close()
	ctx, cancel := context.WithCancel(context.Background())
	subscription, err := hub.Subscribe(ctx, "workspace-1")
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	cancel()

	select {
	case _, ok := <-subscription.Events():
		if ok {
			t.Fatal("cancelled subscription delivered an event")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled subscription was not closed")
	}
	if hub.SubscriberCount() != 0 {
		t.Fatalf("SubscriberCount() = %d, want 0", hub.SubscriberCount())
	}
}

func TestHubKeepsWorkspaceScopesSeparate(t *testing.T) {
	t.Parallel()

	hub, err := NewHub(2)
	if err != nil {
		t.Fatalf("NewHub() error = %v", err)
	}
	defer hub.Close()
	first, _ := hub.Subscribe(context.Background(), "workspace-1")
	second, _ := hub.Subscribe(context.Background(), "workspace-2")
	defer first.Close()
	defer second.Close()

	event := Event{WorkspaceID: "workspace-1", Type: "comment.created"}
	if err := hub.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	select {
	case <-first.Events():
	case <-time.After(time.Second):
		t.Fatal("matching workspace did not receive event")
	}
	select {
	case <-second.Events():
		t.Fatal("different workspace received event")
	default:
	}
}
