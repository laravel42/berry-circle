package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Event is an ephemeral projection of a fact already persisted in PostgreSQL.
type Event struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	Type        string          `json:"type"`
	Payload     json.RawMessage `json:"payload"`
	OccurredAt  time.Time       `json:"occurredAt"`

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
	for id, target := range hub.channels[event.WorkspaceID] {
		select {
		case target.events <- event:
		default:
			delete(hub.channels[event.WorkspaceID], id)
			target.stop()
			hub.overflow.Add(1)
			overflowed++
		}
	}
	if len(hub.channels[event.WorkspaceID]) == 0 {
		delete(hub.channels, event.WorkspaceID)
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

// WorkspaceScope authenticates a request and returns its authorized workspace.
type WorkspaceScope func(context.Context, *http.Request) (string, error)

// Reject writes a pre-upgrade HTTP error through the shared API envelope.
type Reject func(http.ResponseWriter, *http.Request, int, string, string)

// WebSocketHandler upgrades authorized, origin-checked workspace subscriptions.
type WebSocketHandler struct {
	// Hub remains for foundation callers. Broadcaster takes precedence when set.
	Hub         *Hub
	Broadcaster Broadcaster
	Scope       WorkspaceScope
	CheckOrigin func(*http.Request) bool
	Reject      Reject
	Observer    Observer
	PingEvery   time.Duration
	PongWait    time.Duration
	WriteWait   time.Duration
	ReadLimit   int64
}

// ServeHTTP follows a small server-to-client JSON event protocol. It is not a
// daemon, execution, or local-process protocol.
func (handler WebSocketHandler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	broadcaster := handler.broadcaster()
	if broadcaster == nil || handler.Scope == nil || handler.CheckOrigin == nil {
		handler.reject(response, request, http.StatusServiceUnavailable, "REALTIME_UNAVAILABLE", "Realtime is unavailable.")
		return
	}
	if stringsBlank(request.Header.Get("Origin")) || !handler.CheckOrigin(request) {
		handler.reject(response, request, http.StatusForbidden, "FORBIDDEN", "Origin is not allowed.")
		return
	}
	workspaceID, err := handler.Scope(request.Context(), request)
	if err != nil || stringsBlank(workspaceID) {
		handler.reject(response, request, http.StatusForbidden, "FORBIDDEN", "Workspace access is denied.")
		return
	}
	subscription, err := broadcaster.Subscribe(request.Context(), workspaceID)
	if err != nil {
		handler.reject(response, request, http.StatusServiceUnavailable, "REALTIME_UNAVAILABLE", "Realtime is unavailable.")
		return
	}
	defer subscription.Close()

	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 4096,
		CheckOrigin:     handler.CheckOrigin,
	}
	connection, err := upgrader.Upgrade(response, request, nil)
	if err != nil {
		return
	}
	defer connection.Close()
	observe(handler.Observer, Observation{Kind: ObservationConnectionOpened})
	closeCode := websocket.CloseNormalClosure
	defer func() {
		observe(handler.Observer, Observation{
			Kind:      ObservationConnectionClosed,
			CloseCode: closeCode,
		})
	}()

	pingEvery := handler.PingEvery
	if pingEvery <= 0 {
		pingEvery = 30 * time.Second
	}
	pongWait := handler.PongWait
	if pongWait <= 0 {
		pongWait = 60 * time.Second
	}
	if pongWait <= pingEvery {
		pongWait = 2 * pingEvery
	}
	writeWait := handler.WriteWait
	if writeWait <= 0 {
		writeWait = 5 * time.Second
	}
	readLimit := handler.ReadLimit
	if readLimit <= 0 {
		readLimit = 1024
	}
	connection.SetReadLimit(readLimit)
	_ = connection.SetReadDeadline(time.Now().Add(pongWait))
	connection.SetPongHandler(func(string) error {
		return connection.SetReadDeadline(time.Now().Add(pongWait))
	})

	readDone := make(chan websocketReadResult, 1)
	go readWebSocket(connection, readDone)

	ticker := time.NewTicker(pingEvery)
	defer ticker.Stop()

	for {
		select {
		case <-request.Context().Done():
			closeCode = websocket.CloseGoingAway
			writeWebSocketClose(connection, closeCode, "server shutting down", writeWait)
			return
		case result := <-readDone:
			closeCode = result.closeCode
			if result.reply {
				writeWebSocketClose(connection, result.closeCode, result.reason, writeWait)
			}
			if result.clientMessage {
				observe(handler.Observer, Observation{Kind: ObservationClientMessageRejected})
			}
			return
		case event, ok := <-subscription.Events():
			if !ok {
				closeCode = websocket.CloseTryAgainLater
				writeWebSocketClose(
					connection,
					closeCode,
					"reconnect and resync",
					writeWait,
				)
				return
			}
			_ = connection.SetWriteDeadline(time.Now().Add(writeWait))
			if err := connection.WriteJSON(event); err != nil {
				closeCode = websocket.CloseAbnormalClosure
				return
			}
			observe(handler.Observer, Observation{Kind: ObservationEventDelivered})
		case <-ticker.C:
			_ = connection.SetWriteDeadline(time.Now().Add(writeWait))
			if err := connection.WriteControl(
				websocket.PingMessage,
				nil,
				time.Now().Add(writeWait),
			); err != nil {
				closeCode = websocket.CloseAbnormalClosure
				return
			}
		}
	}
}

type websocketReadResult struct {
	closeCode     int
	reason        string
	reply         bool
	clientMessage bool
}

func readWebSocket(connection *websocket.Conn, done chan<- websocketReadResult) {
	for {
		_, _, err := connection.ReadMessage()
		if err != nil {
			result := websocketReadResult{closeCode: websocket.CloseAbnormalClosure}
			if errors.Is(err, websocket.ErrReadLimit) {
				result.closeCode = websocket.CloseMessageTooBig
			}
			var closeError *websocket.CloseError
			if errors.As(err, &closeError) {
				result.closeCode = closeError.Code
			}
			done <- result
			return
		}
		done <- websocketReadResult{
			closeCode:     websocket.ClosePolicyViolation,
			reason:        "client messages are not accepted",
			reply:         true,
			clientMessage: true,
		}
		return
	}
}

func writeWebSocketClose(
	connection *websocket.Conn,
	code int,
	reason string,
	timeout time.Duration,
) {
	_ = connection.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(timeout),
	)
}

func (handler WebSocketHandler) broadcaster() Broadcaster {
	if handler.Broadcaster != nil {
		return handler.Broadcaster
	}
	if handler.Hub != nil {
		return handler.Hub
	}
	return nil
}

func (handler WebSocketHandler) reject(
	response http.ResponseWriter,
	request *http.Request,
	status int,
	code, message string,
) {
	if handler.Reject != nil {
		handler.Reject(response, request, status, code, message)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{
		"error": map[string]any{
			"code":      code,
			"message":   message,
			"requestId": response.Header().Get("X-Request-Id"),
			"details":   nil,
		},
	})
}

func stringsBlank(value string) bool {
	for _, character := range value {
		if character != ' ' && character != '\t' && character != '\n' && character != '\r' {
			return false
		}
	}
	return true
}
