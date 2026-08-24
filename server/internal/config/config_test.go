package config

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestLoadParsesExplicitFalseBooleans(t *testing.T) {
	t.Parallel()

	cfg, err := Load(map[string]string{
		"METRICS_ENABLED":      "false",
		"VALKEY_ENABLED":       "0",
		"CACHE_FAIL_OPEN":      "off",
		"RATE_LIMIT_FAIL_OPEN": "no",
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.MetricsEnabled || cfg.ValkeyEnabled || cfg.CacheFailOpen ||
		cfg.RateLimitFailOpen {
		t.Fatalf("explicit false values parsed as true: %#v", cfg.SafeSummary())
	}
}

func TestLoadRejectsInvalidBooleanWithoutEchoingValue(t *testing.T) {
	t.Parallel()

	const secretLikeValue = "definitely-not-a-boolean-secret"
	_, err := Load(map[string]string{"VALKEY_ENABLED": secretLikeValue})
	if err == nil {
		t.Fatal("Load() accepted an invalid boolean")
	}
	if !strings.Contains(err.Error(), "VALKEY_ENABLED") {
		t.Fatalf("Load() error = %q, want field name", err)
	}
	if strings.Contains(err.Error(), secretLikeValue) {
		t.Fatalf("Load() error exposed the field value: %q", err)
	}
}

func TestLoadRequiresProductionDatabaseAndUpstreamKey(t *testing.T) {
	t.Parallel()

	_, err := Load(map[string]string{"APP_ENV": "production"})
	if err == nil {
		t.Fatal("Load() accepted production without required configuration")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("Load() error = %q, want DATABASE_URL", err)
	}
	if !strings.Contains(err.Error(), "OPENFANG_API_KEY") {
		t.Errorf("Load() error = %q, want OPENFANG_API_KEY", err)
	}
}

func TestLoadNormalizesTrustedOriginsAndDurations(t *testing.T) {
	t.Parallel()

	cfg, err := Load(map[string]string{
		"TRUSTED_ORIGINS":  "https://berry.example/, http://localhost:3000, https://berry.example",
		"SESSION_TTL":      "12h",
		"SHUTDOWN_TIMEOUT": "20s",
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(cfg.TrustedOrigins) != 2 {
		t.Fatalf("TrustedOrigins = %#v, want two unique origins", cfg.TrustedOrigins)
	}
	if cfg.SessionTTL != 12*time.Hour {
		t.Errorf("SessionTTL = %s, want 12h", cfg.SessionTTL)
	}
	if cfg.ShutdownTimeout != 20*time.Second {
		t.Errorf("ShutdownTimeout = %s, want 20s", cfg.ShutdownTimeout)
	}
}

func TestLoadDefaultsDevelopmentTrustedOrigins(t *testing.T) {
	t.Parallel()

	cfg, err := Load(map[string]string{})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(cfg.TrustedOrigins) != 2 {
		t.Fatalf("TrustedOrigins = %#v, want development defaults", cfg.TrustedOrigins)
	}

	production, err := Load(map[string]string{
		"APP_ENV":          "production",
		"DATABASE_URL":     "postgres://berry:secret@db/berry",
		"OPENFANG_API_KEY": "upstream-secret",
	})
	if err != nil {
		t.Fatalf("Load(production) error = %v", err)
	}
	if len(production.TrustedOrigins) != 0 {
		t.Fatalf("production TrustedOrigins = %#v, want empty", production.TrustedOrigins)
	}
}

func TestLoadRejectsPasswordlessProductionAuth(t *testing.T) {
	t.Parallel()

	_, err := Load(map[string]string{
		"APP_ENV":                       "production",
		"DATABASE_URL":                  "postgres://berry:secret@db/berry",
		"OPENFANG_API_KEY":              "upstream-secret",
		"AUTH_ALLOW_PASSWORDLESS_LOGIN": "true",
	})
	if err == nil || !strings.Contains(err.Error(), "AUTH_ALLOW_PASSWORDLESS_LOGIN") {
		t.Fatalf("Load() error = %v, want passwordless production rejection", err)
	}
	if strings.Contains(err.Error(), "upstream-secret") ||
		strings.Contains(err.Error(), "berry:secret") {
		t.Fatalf("Load() error exposed a secret: %q", err)
	}
}

func TestLoadParsesS3CompatibleEndpointWithoutExposingCredentials(t *testing.T) {
	t.Parallel()

	const secret = "minio-secret-value"
	cfg, err := Load(map[string]string{
		"STORAGE_BACKEND":       "s3",
		"S3_BUCKET":             "berry",
		"S3_REGION":             "us-east-1",
		"AWS_ENDPOINT_URL":      "http://127.0.0.1:9000",
		"AWS_ACCESS_KEY_ID":     "minio",
		"AWS_SECRET_ACCESS_KEY": secret,
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.S3Endpoint != "http://127.0.0.1:9000" || !cfg.S3UsePathStyle {
		t.Fatalf("S3 endpoint config = %#v", cfg.SafeSummary())
	}
	summary := fmt.Sprint(cfg.SafeSummary())
	if strings.Contains(summary, secret) || strings.Contains(summary, "minio") {
		t.Fatalf("SafeSummary() exposed S3 credentials: %s", summary)
	}
}

func TestLoadRejectsIncompleteS3CredentialsWithoutEchoingValues(t *testing.T) {
	t.Parallel()

	const secret = "do-not-echo"
	_, err := Load(map[string]string{
		"STORAGE_BACKEND":       "s3",
		"S3_BUCKET":             "berry",
		"S3_REGION":             "us-east-1",
		"AWS_SECRET_ACCESS_KEY": secret,
	})
	if err == nil || !strings.Contains(err.Error(), "AWS_ACCESS_KEY_ID") {
		t.Fatalf("Load() error = %v, want incomplete credential rejection", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("Load() exposed a credential: %v", err)
	}
}

func TestLoadParsesRealtimeRelayBoundsAndCompatibilityDefaults(t *testing.T) {
	t.Parallel()

	cfg, err := Load(map[string]string{
		"VALKEY_ENABLED":         "true",
		"VALKEY_REQUIRED":        "true",
		"REALTIME_NODE_ID":       "node-a",
		"REALTIME_STREAM_MAXLEN": "2500",
		"REALTIME_STREAM_TTL":    "10m",
		"REALTIME_READ_BLOCK":    "2s",
	})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.RealtimeRelayRequired || cfg.RealtimeNodeID != "node-a" ||
		cfg.RealtimeStreamMaxLen != 2500 ||
		cfg.RealtimeStreamTTL != 10*time.Minute ||
		cfg.RealtimeReadBlock != 2*time.Second {
		t.Fatalf("realtime config = %#v", cfg.SafeSummary())
	}
}

func TestLoadRejectsUnsafeRealtimeRelayConfiguration(t *testing.T) {
	t.Parallel()

	_, err := Load(map[string]string{
		"REALTIME_RELAY_REQUIRED": "true",
		"REALTIME_NODE_ID":        "../node",
		"REALTIME_STREAM_TTL":     "1s",
		"REALTIME_READ_BLOCK":     "1s",
	})
	if err == nil {
		t.Fatal("Load() accepted unsafe realtime relay configuration")
	}
	for _, field := range []string{
		"REALTIME_RELAY_REQUIRED",
		"REALTIME_NODE_ID",
		"REALTIME_READ_BLOCK",
	} {
		if !strings.Contains(err.Error(), field) {
			t.Errorf("Load() error = %q, want %s", err, field)
		}
	}
}
