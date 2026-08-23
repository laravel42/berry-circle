package observability

import (
	"context"
	"io"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

const redacted = "[REDACTED]"

// NewLogger creates a structured JSON logger with recursive secret redaction.
func NewLogger(output io.Writer, level slog.Level, service, environment string) *slog.Logger {
	handler := slog.NewJSONHandler(output, &slog.HandlerOptions{Level: level})
	return slog.New(redactingHandler{next: handler}).With(
		"service",
		service,
		"environment",
		environment,
	)
}

type redactingHandler struct {
	next slog.Handler
}

func (handler redactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return handler.next.Enabled(ctx, level)
}

func (handler redactingHandler) Handle(ctx context.Context, record slog.Record) error {
	clean := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	record.Attrs(func(attr slog.Attr) bool {
		clean.AddAttrs(redactAttr(attr))
		return true
	})
	return handler.next.Handle(ctx, clean)
}

func (handler redactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	clean := make([]slog.Attr, 0, len(attrs))
	for _, attr := range attrs {
		clean = append(clean, redactAttr(attr))
	}
	return redactingHandler{next: handler.next.WithAttrs(clean)}
}

func (handler redactingHandler) WithGroup(name string) slog.Handler {
	return redactingHandler{next: handler.next.WithGroup(name)}
}

func redactAttr(attr slog.Attr) slog.Attr {
	attr.Value = attr.Value.Resolve()
	if sensitiveKey(attr.Key) {
		return slog.String(attr.Key, redacted)
	}
	if attr.Value.Kind() == slog.KindGroup {
		group := attr.Value.Group()
		clean := make([]slog.Attr, 0, len(group))
		for _, child := range group {
			clean = append(clean, redactAttr(child))
		}
		return slog.Group(attr.Key, attrsToAny(clean)...)
	}
	if attr.Value.Kind() == slog.KindString && strings.Contains(strings.ToLower(attr.Key), "url") {
		return slog.String(attr.Key, redactURL(attr.Value.String()))
	}
	return attr
}

func attrsToAny(attrs []slog.Attr) []any {
	result := make([]any, len(attrs))
	for index, attr := range attrs {
		result[index] = attr
	}
	return result
}

func sensitiveKey(key string) bool {
	normalized := strings.NewReplacer("_", "", "-", "", ".", "").Replace(
		strings.ToLower(key),
	)
	for _, term := range []string{
		"authorization",
		"cookie",
		"token",
		"secret",
		"password",
		"apikey",
		"sessionid",
	} {
		if strings.Contains(normalized, term) {
			return true
		}
	}
	return false
}

func redactURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if parsed.User != nil {
		parsed.User = nil
	}
	if parsed.RawQuery != "" {
		parsed.RawQuery = ""
		parsed.ForceQuery = false
	}
	return parsed.String()
}

// HTTPMetrics contains route-pattern-only HTTP instruments.
type HTTPMetrics struct {
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
	inFlight *prometheus.GaugeVec
}

// NewHTTPMetrics registers HTTP metrics on the supplied registry.
func NewHTTPMetrics(registerer prometheus.Registerer) (*HTTPMetrics, error) {
	metrics := &HTTPMetrics{
		requests: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Namespace: "berry",
				Subsystem: "http",
				Name:      "requests_total",
				Help:      "Completed HTTP requests by method, route pattern, and status.",
			},
			[]string{"method", "route", "status"},
		),
		duration: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Namespace: "berry",
				Subsystem: "http",
				Name:      "request_duration_seconds",
				Help:      "HTTP request duration by method and route pattern.",
				Buckets:   prometheus.DefBuckets,
			},
			[]string{"method", "route"},
		),
		inFlight: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Namespace: "berry",
				Subsystem: "http",
				Name:      "requests_in_flight",
				Help:      "Currently active HTTP requests by method.",
			},
			[]string{"method"},
		),
	}
	for _, collector := range []prometheus.Collector{
		metrics.requests,
		metrics.duration,
		metrics.inFlight,
	} {
		if err := registerer.Register(collector); err != nil {
			return nil, err
		}
	}
	return metrics, nil
}

// Begin marks one request in flight and returns a completion observer.
func (metrics *HTTPMetrics) Begin(method string) func(route, status string, elapsed time.Duration) {
	if metrics == nil {
		return func(string, string, time.Duration) {}
	}
	metrics.inFlight.WithLabelValues(method).Inc()
	started := time.Now()
	return func(route, status string, elapsed time.Duration) {
		metrics.inFlight.WithLabelValues(method).Dec()
		metrics.requests.WithLabelValues(method, route, status).Inc()
		if elapsed <= 0 {
			elapsed = time.Since(started)
		}
		metrics.duration.WithLabelValues(method, route).Observe(elapsed.Seconds())
	}
}

// SetupTracing installs W3C propagation and an exporter-free SDK provider.
// Later deployment lanes can add an exporter without changing call sites.
func SetupTracing(service string) (*sdktrace.TracerProvider, error) {
	res, err := resource.New(
		context.Background(),
		resource.WithAttributes(attribute.String("service.name", service)),
	)
	if err != nil {
		return nil, err
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.AlwaysSample())),
	)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(
		propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{},
			propagation.Baggage{},
		),
	)
	return provider, nil
}
