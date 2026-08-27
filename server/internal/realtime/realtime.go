package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// Event is an ephemeral projection of a fact already persisted in PostgreSQL.
type Event struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	// BoardID is a second delivery scope. Board streams subscribe on the board
	// id while workspace-wide consumers subscribe on the workspace id, and one
	// fact must reach both without being published twice: the hub fans an
	// event out to every subscriber of either scope. Empty for facts that
	// belong to no board.
	BoardID    string          `json:"boardId,omitempty"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
	OccurredAt time.Time       `json:"occurredAt"`

	// OriginNodeID is relay metadata and is never sent to browser clients.
	OriginNodeID string `json:"-"`
}

// Broadcaster distributes workspace-scoped projections within one process.
type Broadcaster interface {
	Publish(context.Context, Event) error
	Subscribe(context.Context, string) (*Subscription, error)
}

// Hub is a bounded in-process broadcaster. Slow subscribers are disconnected
// instead of allowing unbounded memory growth.
type Hub struct {
	mu       sync.Mutex
	buffer   int
	nextID   uint64
	closed   bool
	channels map[string]map[uint64]*subscriber
	overflow atomic.Uint64
	observer Observer
}

type subscriber struct {
	events chan Event
	done   chan struct{}
	once   sync.Once
}

func (subscriber *subscriber) stop() {
	subscriber.once.Do(func() {
		close(subscriber.done)
		for {
			select {
			case <-subscriber.events:
			default:
				close(subscriber.events)
				return
			}
		}
	})
}

// NewHub creates a broadcaster with a fixed per-subscriber buffer.
func NewHub(buffer int) (*Hub, error) {
	if buffer <= 0 {
		return nil, errors.New("realtime subscriber buffer must be positive")
	}
	return &Hub{
		buffer:   buffer,
		channels: make(map[string]map[uint64]*subscriber),
	}, nil
}

// Subscription owns one event channel and an idempotent close function.
type Subscription struct {
	events    <-chan Event
	closeOnce sync.Once
	close     func()
}

// Events returns the bounded delivery channel.
func (subscription *Subscription) Events() <-chan Event {
	if subscription == nil {
		return nil
	}
	return subscription.events
}

// Close removes the subscription and closes its event channel.
func (subscription *Subscription) Close() {
	if subscription == nil {
		return
	}
	subscription.closeOnce.Do(subscription.close)
}

// Subscribe registers a workspace-scoped subscriber.
func (hub *Hub) Subscribe(
	ctx context.Context,
	workspaceID string,
) (*Subscription, error) {
	if !validIdentifier(workspaceID, maxWorkspaceIDBytes) {
		return nil, errors.New("valid workspace scope is required")
	}
	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
		return nil, errors.New("realtime hub is closed")
	}
	hub.nextID++
	id := hub.nextID
	target := &subscriber{
		events: make(chan Event, hub.buffer),
		done:   make(chan struct{}),
	}
	if hub.channels[workspaceID] == nil {
		hub.channels[workspaceID] = make(map[uint64]*subscriber)
	}
	hub.channels[workspaceID][id] = target
	hub.mu.Unlock()

	subscription := &Subscription{
		events: target.events,
		close: func() {
			hub.remove(workspaceID, id)
		},
	}
	go func() {
		select {
		case <-ctx.Done():
			subscription.Close()
		case <-target.done:
		}
	}()
	return subscription, nil
}

// Publish fans an event out without blocking. An overflowed subscriber is
// removed and its channel is closed.
func (hub *Hub) Publish(ctx context.Context, event Event) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	event, err := normalizeEvent(event)
	if err != nil {
		return err
	}
	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
		return errors.New("realtime hub is closed")
	}
	overflowed := 0
	for _, scope := range event.scopes() {
		for id, target := range hub.channels[scope] {
			select {
			case target.events <- event:
			default:
				delete(hub.channels[scope], id)
				target.stop()
				hub.overflow.Add(1)
				overflowed++
			}
		}
		if len(hub.channels[scope]) == 0 {
			delete(hub.channels, scope)
		}
	}
	observer := hub.observer
	hub.mu.Unlock()
	for range overflowed {
		observe(observer, Observation{Kind: ObservationSlowSubscriber})
	}
	return nil
}

// SetObserver installs optional metrics hooks.
func (hub *Hub) SetObserver(observer Observer) {
	hub.mu.Lock()
	hub.observer = observer
	hub.mu.Unlock()
}

// DisconnectAll ends current subscriptions without closing the hub. Clients
// reconnect and re-fetch PostgreSQL after relay loss or retention gaps.
func (hub *Hub) DisconnectAll() {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	for workspaceID, subscribers := range hub.channels {
		for id, target := range subscribers {
			delete(subscribers, id)
			target.stop()
		}
		delete(hub.channels, workspaceID)
	}
}

// Close disconnects all subscribers.
func (hub *Hub) Close() error {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed {
		return nil
	}
	hub.closed = true
	for workspaceID, subscribers := range hub.channels {
		for id, target := range subscribers {
			delete(subscribers, id)
			target.stop()
		}
		delete(hub.channels, workspaceID)
	}
	return nil
}

// SubscriberCount exposes lifecycle state for readiness and tests.
func (hub *Hub) SubscriberCount() int {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	total := 0
	for _, subscribers := range hub.channels {
		total += len(subscribers)
	}
	return total
}

// OverflowCount reports disconnected slow subscribers.
func (hub *Hub) OverflowCount() uint64 {
	return hub.overflow.Load()
}

func (hub *Hub) remove(workspaceID string, id uint64) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	subscribers := hub.channels[workspaceID]
	target, ok := subscribers[id]
	if !ok {
		return
	}
	delete(subscribers, id)
	target.stop()
	if len(subscribers) == 0 {
		delete(hub.channels, workspaceID)
	}
}

// Relay is the cross-process invalidation seam. Durable events remain
// PostgreSQL facts regardless of relay availability.
type Relay interface {
	Publish(context.Context, Event) error
	Run(context.Context, func(context.Context, Event) error) error
	Close() error
}

// NoopRelay is suitable for a single-process deployment.
type NoopRelay struct{}

func (NoopRelay) Publish(context.Context, Event) error { return nil }

func (NoopRelay) Run(ctx context.Context, _ func(context.Context, Event) error) error {
	<-ctx.Done()
	return ctx.Err()
}

func (NoopRelay) Close() error { return nil }
