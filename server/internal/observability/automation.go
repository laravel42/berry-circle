package observability

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// AutomationMetrics are the workflow execution instruments: how far behind
// the trigger dispatcher is, what it did with each event, how runs end, and
// when the approval expiry sweep last ran. Every method is nil-safe so a
// service built without metrics keeps working.
type AutomationMetrics struct {
	dispatchLag    prometheus.Gauge
	dispatchEvents *prometheus.CounterVec
	runs           *prometheus.CounterVec
	expiryLastRun  prometheus.Gauge
}

// NewAutomationMetrics registers the workflow instruments on the registry.
func NewAutomationMetrics(registerer prometheus.Registerer) (*AutomationMetrics, error) {
	metrics := &AutomationMetrics{
		dispatchLag: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "berry",
			Subsystem: "triggerdispatch",
			Name:      "lag_seconds",
			Help:      "Age of the oldest outbox event the trigger dispatcher has not receipted.",
		}),
		dispatchEvents: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Namespace: "berry",
				Subsystem: "triggerdispatch",
				Name:      "events_total",
				Help:      "Outbox events the trigger dispatcher receipted, by outcome.",
			},
			[]string{"outcome"},
		),
		runs: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Namespace: "berry",
				Subsystem: "automation",
				Name:      "runs_total",
				Help:      "Workflow runs that reached a terminal status, by status.",
			},
			[]string{"status"},
		),
		expiryLastRun: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: "berry",
			Subsystem: "approvals",
			Name:      "expiry_last_run_timestamp",
			Help:      "Unix time of the last successful approval expiry sweep.",
		}),
	}
	for _, collector := range []prometheus.Collector{
		metrics.dispatchLag,
		metrics.dispatchEvents,
		metrics.runs,
		metrics.expiryLastRun,
	} {
		if err := registerer.Register(collector); err != nil {
			return nil, err
		}
	}
	return metrics, nil
}

// ObserveDispatchLag records the age of the oldest unreceipted event.
func (metrics *AutomationMetrics) ObserveDispatchLag(lag time.Duration) {
	if metrics == nil {
		return
	}
	if lag < 0 {
		lag = 0
	}
	metrics.dispatchLag.Set(lag.Seconds())
}

// CountDispatch records one receipted event.
func (metrics *AutomationMetrics) CountDispatch(outcome string) {
	if metrics == nil {
		return
	}
	metrics.dispatchEvents.WithLabelValues(outcome).Inc()
}

// CountRun records one run reaching a terminal status.
func (metrics *AutomationMetrics) CountRun(status string) {
	if metrics == nil {
		return
	}
	metrics.runs.WithLabelValues(status).Inc()
}

// SetExpiryRun records when the approval expiry sweep last succeeded.
func (metrics *AutomationMetrics) SetExpiryRun(at time.Time) {
	if metrics == nil {
		return
	}
	metrics.expiryLastRun.Set(float64(at.Unix()))
}
