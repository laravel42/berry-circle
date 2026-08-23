package realtime

import (
	"sync/atomic"
)

// ObservationKind is a bounded-cardinality realtime lifecycle signal.
type ObservationKind string

const (
	ObservationConnectionOpened      ObservationKind = "connection_opened"
	ObservationConnectionClosed      ObservationKind = "connection_closed"
	ObservationClientMessageRejected ObservationKind = "client_message_rejected"
	ObservationEventDelivered        ObservationKind = "event_delivered"
	ObservationSlowSubscriber        ObservationKind = "slow_subscriber"
	ObservationRelayConnected        ObservationKind = "relay_connected"
	ObservationRelayDisconnected     ObservationKind = "relay_disconnected"
	ObservationRelayPublishFailed    ObservationKind = "relay_publish_failed"
	ObservationRelayEventRejected    ObservationKind = "relay_event_rejected"
)

// Observation is suitable for a Prometheus adapter without tenant labels.
type Observation struct {
	Kind      ObservationKind
	CloseCode int
}

// Observer receives optional realtime metrics hooks.
type Observer interface {
	Observe(Observation)
}

func observe(observer Observer, observation Observation) {
	if observer != nil {
		observer.Observe(observation)
	}
}

// AtomicMetrics is a dependency-free observer useful for readiness snapshots
// and tests. Deployments may instead adapt Observer to Prometheus.
type AtomicMetrics struct {
	connections        atomic.Int64
	connectionOpens    atomic.Uint64
	connectionCloses   atomic.Uint64
	clientRejected     atomic.Uint64
	delivered          atomic.Uint64
	slowSubscribers    atomic.Uint64
	relayConnected     atomic.Bool
	relayDisconnects   atomic.Uint64
	relayPublishFailed atomic.Uint64
	relayRejected      atomic.Uint64
}

// Observe records one lifecycle signal.
func (metrics *AtomicMetrics) Observe(observation Observation) {
	if metrics == nil {
		return
	}
	switch observation.Kind {
	case ObservationConnectionOpened:
		metrics.connections.Add(1)
		metrics.connectionOpens.Add(1)
	case ObservationConnectionClosed:
		metrics.connections.Add(-1)
		metrics.connectionCloses.Add(1)
	case ObservationClientMessageRejected:
		metrics.clientRejected.Add(1)
	case ObservationEventDelivered:
		metrics.delivered.Add(1)
	case ObservationSlowSubscriber:
		metrics.slowSubscribers.Add(1)
	case ObservationRelayConnected:
		metrics.relayConnected.Store(true)
	case ObservationRelayDisconnected:
		metrics.relayConnected.Store(false)
		metrics.relayDisconnects.Add(1)
	case ObservationRelayPublishFailed:
		metrics.relayPublishFailed.Add(1)
	case ObservationRelayEventRejected:
		metrics.relayRejected.Add(1)
	}
}

// MetricsSnapshot is a stable, tenant-free metrics view.
type MetricsSnapshot struct {
	Connections        int64
	ConnectionOpens    uint64
	ConnectionCloses   uint64
	ClientRejected     uint64
	Delivered          uint64
	SlowSubscribers    uint64
	RelayConnected     bool
	RelayDisconnects   uint64
	RelayPublishFailed uint64
	RelayRejected      uint64
}

// Snapshot returns a race-safe metrics copy.
func (metrics *AtomicMetrics) Snapshot() MetricsSnapshot {
	if metrics == nil {
		return MetricsSnapshot{}
	}
	return MetricsSnapshot{
		Connections:        metrics.connections.Load(),
		ConnectionOpens:    metrics.connectionOpens.Load(),
		ConnectionCloses:   metrics.connectionCloses.Load(),
		ClientRejected:     metrics.clientRejected.Load(),
		Delivered:          metrics.delivered.Load(),
		SlowSubscribers:    metrics.slowSubscribers.Load(),
		RelayConnected:     metrics.relayConnected.Load(),
		RelayDisconnects:   metrics.relayDisconnects.Load(),
		RelayPublishFailed: metrics.relayPublishFailed.Load(),
		RelayRejected:      metrics.relayRejected.Load(),
	}
}
