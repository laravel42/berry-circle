package observability

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

func TestPlannerMetricsRegisterAndCount(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics, err := NewPlannerMetrics(registry)
	if err != nil {
		t.Fatalf("NewPlannerMetrics() error = %v", err)
	}
	metrics.ObserveStage("generate", "ok", 2*time.Second)
	metrics.CountTokens("planner", 1200, 300)
	metrics.CountTokens("planner", 0, 0)
	families, err := registry.Gather()
	if err != nil {
		t.Fatalf("Gather() error = %v", err)
	}
	seen := map[string]float64{}
	for _, family := range families {
		for _, metric := range family.GetMetric() {
			key := family.GetName()
			for _, label := range metric.GetLabel() {
				key += "|" + label.GetName() + "=" + label.GetValue()
			}
			switch {
			case metric.GetCounter() != nil:
				seen[key] = metric.GetCounter().GetValue()
			case metric.GetHistogram() != nil:
				seen[key] = float64(metric.GetHistogram().GetSampleCount())
			}
		}
	}
	if seen["berry_planner_tokens_total|direction=input|role=planner"] != 1200 || seen["berry_planner_tokens_total|direction=output|role=planner"] != 300 {
		t.Fatalf("token counters = %v", seen)
	}
	if seen["berry_planner_stage_duration_seconds|outcome=ok|stage=generate"] != 1 {
		t.Fatalf("stage histogram = %v", seen)
	}
	if _, err := NewPlannerMetrics(registry); err == nil {
		t.Fatal("double registration accepted")
	}
	var nilMetrics *PlannerMetrics
	nilMetrics.ObserveStage("x", "ok", time.Second)
	nilMetrics.CountTokens("x", 1, 1)
}
