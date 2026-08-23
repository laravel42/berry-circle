package realtime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultDedupeEntries = 8192
	defaultDedupeTTL     = 20 * time.Minute
	minRelayBackoff      = 100 * time.Millisecond
	maxRelayBackoff      = 5 * time.Second
)

type relayHealth interface {
	NodeID() string
	Ping(context.Context) error
}

type relayPreparer interface {
	Prepare(context.Context) error
}

// DistributedConfig controls optional-vs-required relay behavior.
type DistributedConfig struct {
	Required      bool
	DedupeEntries int
	DedupeTTL     time.Duration
	Logger        *slog.Logger
	Observer      Observer
}

// ManagedBroadcaster is the optional process lifecycle/readiness seam used by
// multi-instance deployments. Domain packages continue to depend on Broadcaster.
type ManagedBroadcaster interface {
	Broadcaster
	Start(context.Context) error
	Check(context.Context) error
	Healthy() bool
	NodeID() string
	Close() error
}

// Distributed composes immediate local fanout with an ephemeral cross-node
// relay. It persists nothing and deduplicates loopback by event id.
type Distributed struct {
	hub      *Hub
	relay    Relay
	required bool
	logger   *slog.Logger
	observer Observer
	dedupe   *eventDeduper
	healthy  atomic.Bool
	reader   atomic.Bool

	lifecycleMu sync.Mutex
	cancel      context.CancelFunc
	started     bool
	closed      bool
	wg          sync.WaitGroup
}

// NewDistributed creates a composing broadcaster.
func NewDistributed(
	hub *Hub,
	relay Relay,
	config DistributedConfig,
) (*Distributed, error) {
	if hub == nil {
		return nil, errors.New("realtime hub is required")
	}
	if config.Required && relay == nil {
		return nil, errors.New("required realtime relay is unavailable")
	}
	if config.DedupeEntries == 0 {
		config.DedupeEntries = defaultDedupeEntries
	}
	if config.DedupeEntries < 1 || config.DedupeEntries > 1_000_000 {
		return nil, errors.New("realtime dedupe capacity is invalid")
	}
	if config.DedupeTTL == 0 {
		config.DedupeTTL = defaultDedupeTTL
	}
	if config.DedupeTTL < time.Second || config.DedupeTTL > 24*time.Hour {
		return nil, errors.New("realtime dedupe TTL is invalid")
	}
	hub.SetObserver(config.Observer)
	distributed := &Distributed{
		hub:      hub,
		relay:    relay,
		required: config.Required,
		logger:   config.Logger,
		observer: config.Observer,
		dedupe:   newEventDeduper(config.DedupeEntries, config.DedupeTTL),
	}
	if relay == nil {
		distributed.healthy.Store(true)
	}
	return distributed, nil
}

// Publish delivers locally once, then relays the same event id to other nodes.
func (distributed *Distributed) Publish(ctx context.Context, event Event) error {
	if distributed == nil || distributed.hub == nil {
		return errors.New("realtime broadcaster is unavailable")
	}
	event, err := normalizeEvent(event)
	if err != nil {
		return err
	}
	duplicate := distributed.dedupe.seen(event.ID)
	if !duplicate {
		if err := distributed.hub.Publish(ctx, event); err != nil {
			distributed.dedupe.forget(event.ID)
			return err
		}
	}
	if distributed.relay == nil {
		return nil
	}
	if err := distributed.relay.Publish(ctx, event); err != nil {
		distributed.markDisconnected()
		observe(distributed.observer, Observation{Kind: ObservationRelayPublishFailed})
		distributed.logWarn("realtime relay publish failed")
		if distributed.required {
			return fmt.Errorf("required realtime relay publish failed: %w", err)
		}
	} else if distributed.reader.Load() {
		distributed.markConnected()
	}
	return nil
}

// Subscribe delegates to the bounded local hub.
func (distributed *Distributed) Subscribe(
	ctx context.Context,
	workspaceID string,
) (*Subscription, error) {
	if distributed == nil || distributed.hub == nil {
		return nil, errors.New("realtime broadcaster is unavailable")
	}
	return distributed.hub.Subscribe(ctx, workspaceID)
}

// Start launches the reconnecting relay reader.
func (distributed *Distributed) Start(ctx context.Context) error {
	if distributed == nil {
		return errors.New("realtime broadcaster is unavailable")
	}
	distributed.lifecycleMu.Lock()
	defer distributed.lifecycleMu.Unlock()
	if distributed.closed {
		return errors.New("realtime broadcaster is closed")
	}
	if distributed.started {
		return errors.New("realtime broadcaster is already started")
	}
	runCtx, cancel := context.WithCancel(ctx)
	distributed.cancel = cancel
	distributed.started = true
	distributed.wg.Add(1)
	go func() {
		defer distributed.wg.Done()
		distributed.run(runCtx)
	}()
	return nil
}

func (distributed *Distributed) run(ctx context.Context) {
	if distributed.relay == nil {
		<-ctx.Done()
		return
	}
	backoff := minRelayBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		if health, ok := distributed.relay.(relayHealth); ok {
			if err := health.Ping(ctx); err != nil {
				distributed.markDisconnected()
				if !waitForRetry(ctx, backoff) {
					return
				}
				backoff = nextBackoff(backoff)
				continue
			}
		}
		if preparer, ok := distributed.relay.(relayPreparer); ok {
			if err := preparer.Prepare(ctx); err != nil {
				distributed.markDisconnected()
				if !waitForRetry(ctx, backoff) {
					return
				}
				backoff = nextBackoff(backoff)
				continue
			}
		}
		distributed.reader.Store(true)
		distributed.markConnected()
		connectedAt := time.Now()
		err := distributed.relay.Run(ctx, distributed.receive)
		distributed.reader.Store(false)
		if ctx.Err() != nil {
			return
		}
		distributed.markDisconnected()
		if err != nil {
			distributed.logWarn("realtime relay reader disconnected")
		} else {
			distributed.logWarn("realtime relay reader stopped unexpectedly")
		}
		if time.Since(connectedAt) >= 30*time.Second {
			backoff = minRelayBackoff
		}
		if !waitForRetry(ctx, backoff) {
			return
		}
		backoff = nextBackoff(backoff)
	}
}

func (distributed *Distributed) receive(ctx context.Context, event Event) error {
	if distributed.reader.Load() {
		distributed.markConnected()
	}
	if event.OriginNodeID != "" && event.OriginNodeID == distributed.NodeID() {
		return nil
	}
	if err := validateEvent(event); err != nil {
		observe(distributed.observer, Observation{Kind: ObservationRelayEventRejected})
		return nil
	}
	if distributed.dedupe.seen(event.ID) {
		return nil
	}
	return distributed.hub.Publish(ctx, event)
}

func (distributed *Distributed) markConnected() {
	if distributed.healthy.Swap(true) {
		return
	}
	// The in-memory cursor can outlive only short reconnects; clients resync
	// because stream trimming or expiry may have removed an unseen event.
	distributed.hub.DisconnectAll()
	observe(distributed.observer, Observation{Kind: ObservationRelayConnected})
}

func (distributed *Distributed) markDisconnected() {
	if distributed.healthy.Swap(false) {
		observe(distributed.observer, Observation{Kind: ObservationRelayDisconnected})
		// Stream retention is intentionally lossy. Ending subscriptions makes the
		// reconnect/resync contract explicit to browser clients.
		distributed.hub.DisconnectAll()
	}
}

// Check reports a failure only when cross-node fanout is configured as required.
func (distributed *Distributed) Check(ctx context.Context) error {
	if distributed == nil {
		return errors.New("realtime broadcaster is unavailable")
	}
	if !distributed.required {
		return nil
	}
	if distributed.relay == nil || !distributed.healthy.Load() {
		return errors.New("required realtime relay is unavailable")
	}
	if health, ok := distributed.relay.(relayHealth); ok {
		if err := health.Ping(ctx); err != nil {
			distributed.markDisconnected()
			return errors.New("required realtime relay is unavailable")
		}
	}
	return nil
}

// Healthy reports the most recently observed relay state.
func (distributed *Distributed) Healthy() bool {
	return distributed != nil && distributed.healthy.Load()
}

// NodeID returns the relay's process identity when available.
func (distributed *Distributed) NodeID() string {
	if distributed == nil || distributed.relay == nil {
		return ""
	}
	if health, ok := distributed.relay.(relayHealth); ok {
		return health.NodeID()
	}
	return ""
}

// Close stops relay readers and disconnects local subscribers.
func (distributed *Distributed) Close() error {
	if distributed == nil {
		return nil
	}
	distributed.lifecycleMu.Lock()
	if distributed.closed {
		distributed.lifecycleMu.Unlock()
		return nil
	}
	distributed.closed = true
	cancel := distributed.cancel
	distributed.lifecycleMu.Unlock()
	if cancel != nil {
		cancel()
	}
	distributed.reader.Store(false)
	distributed.markDisconnected()
	relayErr := error(nil)
	if distributed.relay != nil {
		relayErr = distributed.relay.Close()
	}
	distributed.wg.Wait()
	hubErr := distributed.hub.Close()
	return errors.Join(relayErr, hubErr)
}

func (distributed *Distributed) logWarn(message string) {
	if distributed.logger != nil {
		distributed.logger.Warn(message)
	}
}

func waitForRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func nextBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > maxRelayBackoff {
		return maxRelayBackoff
	}
	return next
}

type dedupeEntry struct {
	id        string
	expiresAt time.Time
}

type eventDeduper struct {
	mu        sync.Mutex
	max       int
	ttl       time.Duration
	entries   map[string]time.Time
	insertion []dedupeEntry
}

func newEventDeduper(maxEntries int, ttl time.Duration) *eventDeduper {
	return &eventDeduper{
		max:     maxEntries,
		ttl:     ttl,
		entries: make(map[string]time.Time, maxEntries),
	}
}

// seen returns true for a live duplicate and records a new id otherwise.
func (dedupe *eventDeduper) seen(id string) bool {
	now := time.Now()
	dedupe.mu.Lock()
	defer dedupe.mu.Unlock()
	dedupe.prune(now)
	if expiresAt, ok := dedupe.entries[id]; ok && expiresAt.After(now) {
		return true
	}
	expiresAt := now.Add(dedupe.ttl)
	dedupe.entries[id] = expiresAt
	dedupe.insertion = append(dedupe.insertion, dedupeEntry{id: id, expiresAt: expiresAt})
	for len(dedupe.entries) > dedupe.max && len(dedupe.insertion) > 0 {
		oldest := dedupe.insertion[0]
		dedupe.insertion = dedupe.insertion[1:]
		if current, ok := dedupe.entries[oldest.id]; ok && current.Equal(oldest.expiresAt) {
			delete(dedupe.entries, oldest.id)
		}
	}
	return false
}

func (dedupe *eventDeduper) prune(now time.Time) {
	for len(dedupe.insertion) > 0 {
		oldest := dedupe.insertion[0]
		if oldest.expiresAt.After(now) {
			return
		}
		dedupe.insertion = dedupe.insertion[1:]
		if current, ok := dedupe.entries[oldest.id]; ok && current.Equal(oldest.expiresAt) {
			delete(dedupe.entries, oldest.id)
		}
	}
}

func (dedupe *eventDeduper) forget(id string) {
	dedupe.mu.Lock()
	delete(dedupe.entries, id)
	dedupe.mu.Unlock()
}

var _ ManagedBroadcaster = (*Distributed)(nil)
