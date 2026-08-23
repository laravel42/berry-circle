package observability

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestLoggerRedactsSensitiveAttributesAndURLQueries(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	logger := NewLogger(&output, slog.LevelDebug, "test", "test")
	logger.Info(
		"request",
		"authorization",
		"Bearer top-secret",
		"headers",
		slog.GroupValue(slog.String("cookie", "session=top-secret")),
		"upstreamURL",
		"https://user:password@example.test/path?token=top-secret",
	)

	logged := output.String()
	if strings.Contains(logged, "top-secret") || strings.Contains(logged, "password") {
		t.Fatalf("logger exposed a secret: %s", logged)
	}
	if strings.Count(logged, redacted) < 2 {
		t.Fatalf("logger output = %s, want recursive redaction", logged)
	}
}
