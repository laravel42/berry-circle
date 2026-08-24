package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	relayKeyPrefix        = "berry:realtime:v1:"
	defaultStreamMaxLen   = int64(10_000)
	defaultStreamTTL      = 15 * time.Minute
	defaultRelayReadBlock = 5 * time.Second
	maxRelayEnvelopeBytes = MaxEventPayloadBytes + 2048
)

// ValkeyRelayConfig bounds the disposable Redis Stream used for invalidations.
type ValkeyRelayConfig struct {
	NodeID       string
	Namespace    string
	StreamMaxLen int64
	StreamTTL    time.Duration
	ReadBlock    time.Duration
	OwnClient    bool
	Observer     Observer
}

// ValkeyRelay fans validated workspace invalidations between server nodes.
// Its stream is an ephemeral reconnect aid, never a durable source of truth.
type ValkeyRelay struct {
	client       redis.UniversalClient
	nodeID       string
	streamKey    string
	streamMaxLen int64
	streamTTL    time.Duration
	readBlock    time.Duration
	ownClient    bool
	observer     Observer

	mu        sync.Mutex
	runCancel context.CancelFunc
	closed    bool

	cursorMu sync.Mutex
	lastID   string
}

type relayEnvelope struct {
	Version int    `json:"version"`
	NodeID  string `json:"nodeId"`
	Event   Event  `json:"event"`
}

var relayPublishScript = redis.NewScript(`
local id = redis.call(
  "XADD", KEYS[1], "MAXLEN", "~", ARGV[1], "*", "event", ARGV[3]
)
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return id
`)

// OpenValkeyRelay opens an independently-owned relay client.
func OpenValkeyRelay(
	ctx context.Context,
	rawURL string,
	config ValkeyRelayConfig,
) (*ValkeyRelay, error) {
	if strings.HasPrefix(rawURL, "valkey://") {
		rawURL = "redis://" + strings.TrimPrefix(rawURL, "valkey://")
	}
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, errors.New("open realtime relay: VALKEY_URL is invalid")
	}
	client := redis.NewClient(options)
	config.OwnClient = true
	relay, err := NewValkeyRelay(client, config)
	if err != nil {
		_ = client.Close()
		return nil, err
	}
	if err := relay.Ping(ctx); err != nil {
		_ = relay.Close()
		return nil, err
	}
	return relay, nil
}

// NewValkeyRelay wraps a Valkey-compatible client. Shared clients are not
// closed unless OwnClient is explicitly set.
func NewValkeyRelay(
	client redis.UniversalClient,
	config ValkeyRelayConfig,
) (*ValkeyRelay, error) {
	if client == nil {
		return nil, errors.New("realtime relay client is required")
	}
	if strings.TrimSpace(config.NodeID) == "" {
		config.NodeID = uuid.NewString()
	}
	if !validIdentifier(config.NodeID, maxEventIDBytes) {
		return nil, errors.New("realtime relay node id is invalid")
	}
	if config.StreamMaxLen == 0 {
		config.StreamMaxLen = defaultStreamMaxLen
	}
	if config.StreamMaxLen < 1 || config.StreamMaxLen > 1_000_000 {
		return nil, errors.New("realtime relay stream max length is invalid")
	}
	if config.StreamTTL == 0 {
		config.StreamTTL = defaultStreamTTL
	}
	if config.StreamTTL < time.Second || config.StreamTTL > 24*time.Hour {
		return nil, errors.New("realtime relay stream TTL is invalid")
	}
	if config.ReadBlock == 0 {
		config.ReadBlock = defaultRelayReadBlock
	}
	if config.ReadBlock < 10*time.Millisecond || config.ReadBlock >= config.StreamTTL {
		return nil, errors.New("realtime relay read block is invalid")
	}
	streamKey := relayKeyPrefix + "events"
	if config.Namespace != "" {
		if !validIdentifier(config.Namespace, 64) {
			return nil, errors.New("realtime relay namespace is invalid")
		}
		streamKey = relayKeyPrefix + config.Namespace + ":events"
	}
	return &ValkeyRelay{
		client:       client,
		nodeID:       config.NodeID,
		streamKey:    streamKey,
		streamMaxLen: config.StreamMaxLen,
		streamTTL:    config.StreamTTL,
		readBlock:    config.ReadBlock,
		ownClient:    config.OwnClient,
		observer:     config.Observer,
	}, nil
}

// NodeID returns the process identity carried by relay envelopes.
func (relay *ValkeyRelay) NodeID() string {
	if relay == nil {
		return ""
	}
	return relay.nodeID
}

// StreamKey returns the owned, versioned key for readiness and test cleanup.
func (relay *ValkeyRelay) StreamKey() string {
	if relay == nil {
		return ""
	}
	return relay.streamKey
}

// Publish appends one bounded event and refreshes the stream's expiry.
func (relay *ValkeyRelay) Publish(ctx context.Context, event Event) error {
	if relay == nil || relay.client == nil {
		return errors.New("realtime relay is unavailable")
	}
	relay.mu.Lock()
	closed := relay.closed
	relay.mu.Unlock()
	if closed {
		return errors.New("realtime relay is closed")
	}
	event, err := normalizeEvent(event)
	if err != nil {
		return err
	}
	envelope := relayEnvelope{
		Version: 1,
		NodeID:  relay.nodeID,
		Event:   event,
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("encode realtime relay event: %w", err)
	}
	if len(body) > maxRelayEnvelopeBytes {
		return fmt.Errorf("realtime relay event exceeds %d bytes", maxRelayEnvelopeBytes)
	}
	_, err = relayPublishScript.Run(
		ctx,
		relay.client,
		[]string{relay.streamKey},
		relay.streamMaxLen,
		relay.streamTTL.Milliseconds(),
		string(body),
	).Result()
	if err != nil {
		return fmt.Errorf("publish realtime relay event: %w", err)
	}
	return nil
}

// Run skips history before the first reader start and resumes its in-memory
// cursor across reconnects. The composing broadcaster still disconnects
// clients because expiry or trimming can create an undetectable gap.
func (relay *ValkeyRelay) Run(
	ctx context.Context,
	receive func(context.Context, Event) error,
) error {
	if relay == nil || relay.client == nil {
		return errors.New("realtime relay is unavailable")
	}
	if receive == nil {
		return errors.New("realtime relay receiver is required")
	}
	runCtx, cancel := context.WithCancel(ctx)
	relay.mu.Lock()
	if relay.closed {
		relay.mu.Unlock()
		cancel()
		return errors.New("realtime relay is closed")
	}
	if relay.runCancel != nil {
		relay.mu.Unlock()
		cancel()
		return errors.New("realtime relay reader is already running")
	}
	relay.runCancel = cancel
	relay.mu.Unlock()
	defer func() {
		cancel()
		relay.mu.Lock()
		relay.runCancel = nil
		relay.mu.Unlock()
	}()

	if err := relay.Ping(runCtx); err != nil {
		return err
	}
	if err := relay.Prepare(runCtx); err != nil {
		return err
	}
	for {
		lastID := relay.cursor()
		streams, err := relay.client.XRead(runCtx, &redis.XReadArgs{
			Streams: []string{relay.streamKey, lastID},
			Count:   128,
			Block:   relay.readBlock,
		}).Result()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			if runCtx.Err() != nil {
				return runCtx.Err()
			}
			return fmt.Errorf("read realtime relay stream: %w", err)
		}
		for _, stream := range streams {
			for _, message := range stream.Messages {
				relay.advanceCursor(message.ID)
				event, nodeID, err := decodeRelayMessage(message)
				if err != nil {
					observe(relay.observer, Observation{Kind: ObservationRelayEventRejected})
					continue
				}
				if nodeID == relay.nodeID {
					continue
				}
				event.OriginNodeID = nodeID
				if err := receive(runCtx, event); err != nil {
					return fmt.Errorf("deliver realtime relay event: %w", err)
				}
			}
		}
	}
}

// Prepare snapshots the initial stream tail. Later reconnects resume from the
// last consumed stream id while it remains retained.
func (relay *ValkeyRelay) Prepare(ctx context.Context) error {
	relay.cursorMu.Lock()
	if relay.lastID != "" {
		relay.cursorMu.Unlock()
		return nil
	}
	relay.cursorMu.Unlock()

	info, err := relay.client.XInfoStream(ctx, relay.streamKey).Result()
	lastID := "0-0"
	if err == nil && info.LastGeneratedID != "" {
		lastID = info.LastGeneratedID
	} else if err != nil && !missingStreamError(err) {
		return fmt.Errorf("inspect realtime relay stream: %w", err)
	}
	relay.cursorMu.Lock()
	if relay.lastID == "" {
		relay.lastID = lastID
	}
	relay.cursorMu.Unlock()
	return nil
}

func missingStreamError(err error) bool {
	return errors.Is(err, redis.Nil) ||
		strings.Contains(strings.ToLower(err.Error()), "no such key")
}

func (relay *ValkeyRelay) cursor() string {
	relay.cursorMu.Lock()
	defer relay.cursorMu.Unlock()
	if relay.lastID == "" {
		return "0-0"
	}
	return relay.lastID
}

func (relay *ValkeyRelay) advanceCursor(id string) {
	relay.cursorMu.Lock()
	relay.lastID = id
	relay.cursorMu.Unlock()
}

func decodeRelayMessage(message redis.XMessage) (Event, string, error) {
	raw, ok := redisString(message.Values["event"])
	if !ok || len(raw) > maxRelayEnvelopeBytes {
		return Event{}, "", errors.New("invalid realtime relay envelope")
	}
	var envelope relayEnvelope
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		return Event{}, "", errors.New("invalid realtime relay envelope")
	}
	if envelope.Version != 1 || !validIdentifier(envelope.NodeID, maxEventIDBytes) {
		return Event{}, "", errors.New("invalid realtime relay envelope")
	}
	if err := validateEvent(envelope.Event); err != nil {
		return Event{}, "", err
	}
	return envelope.Event, envelope.NodeID, nil
}

func redisString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case []byte:
		return string(typed), true
	default:
		return "", false
	}
}

// Ping verifies relay connectivity without exposing endpoint credentials.
func (relay *ValkeyRelay) Ping(ctx context.Context) error {
	if relay == nil || relay.client == nil {
		return errors.New("realtime relay is unavailable")
	}
	if err := relay.client.Ping(ctx).Err(); err != nil {
		return errors.New("realtime relay ping failed")
	}
	return nil
}

// Close stops the reader and closes only independently-owned clients.
func (relay *ValkeyRelay) Close() error {
	if relay == nil {
		return nil
	}
	relay.mu.Lock()
	if relay.closed {
		relay.mu.Unlock()
		return nil
	}
	relay.closed = true
	cancel := relay.runCancel
	relay.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if relay.ownClient && relay.client != nil {
		return relay.client.Close()
	}
	return nil
}

var _ Relay = (*ValkeyRelay)(nil)
