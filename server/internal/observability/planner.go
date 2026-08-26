package observability

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// PlannerMetrics are the plan pipeline instruments: how long each stage
// takes and how it ends, and how many tokens each model role consumes.
// Every method is nil-safe so a service built without metrics keeps working.
type PlannerMetrics struct {
	stageDuration *prometheus.HistogramVec
	tokens        *prometheus.CounterVec
}

// NewPlannerMetrics registers the planner instruments on the registry.
func NewPlannerMetrics(registerer prometheus.Registerer) (*PlannerMetrics, error) {
	metrics := &PlannerMetrics{
		stageDuration: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Namespace: "berry",
				Subsystem: "planner",
				Name:      "stage_duration_seconds",
				Help:      "Duration of one planner stage attempt, by stage and outcome.",
				Buckets:   []float64{0.05, 0.25, 1, 2.5, 5, 10, 20, 45, 90, 180},
			},
			[]string{"stage", "outcome"},
		),
		tokens: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Namespace: "berry",
				Subsystem: "planner",
				Name:      "tokens_total",
				Help:      "LLM tokens consumed by planner model roles, by role and direction.",
			},
			[]string{"role", "direction"},
		),
	}
	for _, collector := range []prometheus.Collector{metrics.stageDuration, metrics.tokens} {
		if err := registerer.Register(collector); err != nil {
			return nil, err
		}
	}
	return metrics, nil
}

// ObserveStage records one stage attempt.
func (metrics *PlannerMetrics) ObserveStage(stage, outcome string, duration time.Duration) {
	if metrics == nil {
		return
	}
	metrics.stageDuration.WithLabelValues(stage, outcome).Observe(duration.Seconds())
}

// CountTokens records one role call's usage.
func (metrics *PlannerMetrics) CountTokens(role string, input, output int64) {
	if metrics == nil {
		return
	}
	if input > 0 {
		metrics.tokens.WithLabelValues(role, "input").Add(float64(input))
	}
	if output > 0 {
		metrics.tokens.WithLabelValues(role, "output").Add(float64(output))
	}
}
