package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type memoryRelayBus struct {
	mu     sync.Mutex
	relays []*memoryRelay
}

func (bus *memoryRelayBus) add(nodeID string) *memoryRelay {
	relay := &memoryRelay{
		nodeID:    nodeID,
		bus:       bus,
		inbox:     make(chan Event, 32),
		failReads: make(chan error, 1),
	}
	bus.mu.Lock()
	bus.relays = append(bus.relays, relay)
	bus.mu.Unlock()
	return relay
}

func (bus *memoryRelayBus) publish(source string, event Event) {
	bus.mu.Lock()
	relays := append([]*memoryRelay(nil), bus.relays...)
	bus.mu.Unlock()
	for _, relay := range relays {
		copy := event
		copy.OriginNodeID = source
		relay.inbox <- copy
	}
}

type memoryRelay struct {
	nodeID     string
	bus        *memoryRelayBus
	inbox      chan Event
	failReads  chan error
	available  atomic.Bool
	publishErr atomic.Bool
}

func (relay *memoryRelay) Publish(_ context.Context, event Event) error {
	if relay.publishErr.Load() {
		return errors.New("relay publish failed")
	}
	relay.bus.publish(relay.nodeID, event)
	return nil
}

func (relay *memoryRelay) Run(
	ctx context.Context,
	receive func(context.Context, Event) error,
) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-relay.failReads:
			return err
		case event := <-relay.inbox:
			if err := receive(ctx, event); err != nil {
				return err
			}
		}
	}
}

func (relay *memoryRelay) Close() error   { return nil }
func (relay *memoryRelay) NodeID() string { return relay.nodeID }

func (relay *memoryRelay) Ping(context.Context) error {
	if !relay.available.Load() {
		return errors.New("relay unavailable")
	}
	return nil
}

func TestDistributedFansOutAcrossNodesWithoutLocalDuplicates(t *testing.T) {
	t.Parallel()

	bus := &memoryRelayBus{}
	firstRelay := bus.add("node-a")
	secondRelay := bus.add("node-b")
	firstRelay.available.Store(true)
	secondRelay.available.Store(true)
	firstHub, _ := NewHub(8)
	secondHub, _ := NewHub(8)
	first, err := NewDistributed(firstHub, firstRelay, DistributedConfig{})
	if err != nil {
		t.Fatalf("NewDistributed(first) error = %v", err)
	}
	second, err := NewDistributed(secondHub, secondRelay, DistributedConfig{})
	if err != nil {
		t.Fatalf("NewDistributed(second) error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := first.Start(ctx); err != nil {
		t.Fatalf("Start(first) error = %v", err)
	}
	if err := second.Start(ctx); err != nil {
		t.Fatalf("Start(second) error = %v", err)
	}
	defer first.Close()
	defer second.Close()
	waitUntil(t, time.Second, func() bool { return first.Healthy() && second.Healthy() })

	firstSubscription, _ := first.Subscribe(context.Background(), "workspace-1")
	secondSubscription, _ := second.Subscribe(context.Background(), "workspace-1")
	otherWorkspace, _ := second.Subscribe(context.Background(), "workspace-2")
	defer firstSubscription.Close()
	defer secondSubscription.Close()
	defer otherWorkspace.Close()

	event := Event{
		ID:          "event-1",
		WorkspaceID: "workspace-1",
		Type:        "issue.updated",
		Payload:     json.RawMessage(`{"issueId":"issue-1"}`),
		OccurredAt:  time.Now(),
	}
	if err := first.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	assertEvent(t, firstSubscription.Events(), "event-1")
	assertEvent(t, secondSubscription.Events(), "event-1")
	select {
	case received := <-firstSubscription.Events():
		t.Fatalf("local subscriber received relay loopback duplicate: %#v", received)
	case <-time.After(50 * time.Millisecond):
	}
	select {
	case received := <-otherWorkspace.Events():
		t.Fatalf("other workspace received event: %#v", received)
	default:
	}

	if err := first.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish(duplicate) error = %v", err)
	}
	select {
	case received := <-secondSubscription.Events():
		t.Fatalf("remote subscriber received duplicate id: %#v", received)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestDistributedOptionalFailureStaysLocalAndRequiredFailsReadiness(t *testing.T) {
	t.Parallel()

	bus := &memoryRelayBus{}
	optionalRelay := bus.add("optional-node")
	optionalRelay.publishErr.Store(true)
	hub, _ := NewHub(2)
	optional, err := NewDistributed(
		hub,
		optionalRelay,
		DistributedConfig{Logger: slog.New(slog.DiscardHandler)},
	)
	if err != nil {
		t.Fatalf("NewDistributed(optional) error = %v", err)
	}
	subscription, _ := optional.Subscribe(context.Background(), "workspace-1")
	defer subscription.Close()
	event := Event{ID: "event-1", WorkspaceID: "workspace-1", Type: "issue.updated"}
	if err := optional.Publish(context.Background(), event); err != nil {
		t.Fatalf("optional Publish() error = %v", err)
	}
	assertEvent(t, subscription.Events(), "event-1")
	if err := optional.Check(context.Background()); err != nil {
		t.Fatalf("optional Check() error = %v", err)
	}

	requiredRelay := bus.add("required-node")
	requiredRelay.publishErr.Store(true)
	requiredHub, _ := NewHub(2)
	required, err := NewDistributed(
		requiredHub,
		requiredRelay,
		DistributedConfig{Required: true},
	)
	if err != nil {
		t.Fatalf("NewDistributed(required) error = %v", err)
	}
	if err := required.Publish(context.Background(), event); err == nil {
		t.Fatal("required Publish() ignored relay failure")
	}
	if err := required.Check(context.Background()); err == nil {
		t.Fatal("required Check() reported ready after relay failure")
	}
}

func TestDistributedDisconnectsSubscribersAcrossRelayReconnect(t *testing.T) {
	t.Parallel()

	bus := &memoryRelayBus{}
	relay := bus.add("node-a")
	relay.available.Store(true)
	hub, _ := NewHub(2)
	distributed, err := NewDistributed(hub, relay, DistributedConfig{})
	if err != nil {
		t.Fatalf("NewDistributed() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := distributed.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer distributed.Close()
	waitUntil(t, time.Second, distributed.Healthy)

	subscription, _ := distributed.Subscribe(context.Background(), "workspace-1")
	relay.failReads <- errors.New("connection lost")
	select {
	case _, ok := <-subscription.Events():
		if ok {
			t.Fatal("subscription received an event during relay loss")
		}
	case <-time.After(time.Second):
		t.Fatal("relay loss did not end subscription for resync")
	}
}

func TestEventValidationBoundsPayloadAndIdentifiers(t *testing.T) {
	t.Parallel()

	hub, _ := NewHub(2)
	defer hub.Close()
	invalid := Event{WorkspaceID: "../workspace", Type: "issue.updated"}
	if err := hub.Publish(context.Background(), invalid); err == nil {
		t.Fatal("Publish() accepted an invalid workspace id")
	}
	oversized := Event{
		WorkspaceID: "workspace-1",
		Type:        "issue.updated",
		Payload:     json.RawMessage(`"` + string(make([]byte, MaxEventPayloadBytes)) + `"`),
	}
	if err := hub.Publish(context.Background(), oversized); err == nil {
		t.Fatal("Publish() accepted an oversized payload")
	}
}

func assertEvent(t *testing.T, events <-chan Event, id string) {
	t.Helper()
	select {
	case event := <-events:
		if event.ID != id {
			t.Fatalf("event id = %q, want %q", event.ID, id)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for event %q", id)
	}
}

func waitUntil(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}
