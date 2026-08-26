package observability

import (
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

func TestAutomationMetricsRegisterAndAreNilSafe(t *testing.T) {
	t.Parallel()
	var none *AutomationMetrics
	none.ObserveDispatchLag(time.Second)
	none.CountDispatch("matched")
	none.CountRun("failed")
	none.SetExpiryRun(time.Now())

	registry := prometheus.NewRegistry()
	metrics, err := NewAutomationMetrics(registry)
	if err != nil {
		t.Fatalf("NewAutomationMetrics() error = %v", err)
	}
	metrics.ObserveDispatchLag(-time.Second)
	metrics.CountDispatch("matched")
	metrics.CountDispatch("matched")
	metrics.CountRun("succeeded")
	metrics.SetExpiryRun(time.Unix(1_700_000_000, 0))
	families, err := registry.Gather()
	if err != nil {
		t.Fatalf("Gather() error = %v", err)
	}
	values := map[string]float64{}
	var gathered []string
	for _, family := range families {
		gathered = append(gathered, family.GetName())
		for _, metric := range family.GetMetric() {
			switch {
			case metric.GetGauge() != nil:
				values[family.GetName()] = metric.GetGauge().GetValue()
			case metric.GetCounter() != nil:
				values[family.GetName()] += metric.GetCounter().GetValue()
			}
		}
	}
	for _, name := range []string{
		"berry_triggerdispatch_lag_seconds", "berry_triggerdispatch_events_total",
		"berry_automation_runs_total", "berry_approvals_expiry_last_run_timestamp",
	} {
		if !strings.Contains(strings.Join(gathered, ","), name) {
			t.Fatalf("metric %s not registered; got %v", name, gathered)
		}
	}
	if values["berry_triggerdispatch_lag_seconds"] != 0 {
		t.Fatalf("lag = %v, want a negative lag clamped to zero", values["berry_triggerdispatch_lag_seconds"])
	}
	if values["berry_triggerdispatch_events_total"] != 2 || values["berry_automation_runs_total"] != 1 {
		t.Fatalf("counters = %v", values)
	}
	if values["berry_approvals_expiry_last_run_timestamp"] != 1_700_000_000 {
		t.Fatalf("expiry = %v", values["berry_approvals_expiry_last_run_timestamp"])
	}
	if _, err := NewAutomationMetrics(registry); err == nil {
		t.Fatal("registering twice must fail")
	}
}
