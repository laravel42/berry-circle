package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config contains validated process configuration. Secret-bearing fields must
// never be logged or returned from an HTTP handler.
type Config struct {
	Environment string
	ServiceName string
	LogLevel    slog.Level
	APIAddr     string

	DatabaseURL string

	ValkeyEnabled  bool
	ValkeyRequired bool
	ValkeyURL      string
	CacheFailOpen  bool

	OpenFangBaseURL string
	OpenFangAPIKey  string

	MetricsEnabled bool
	TrustedOrigins []string

	StorageBackend    string
	StorageLocalRoot  string
	StorageMaxBytes   int64
	S3Bucket          string
	S3Region          string
	S3Endpoint        string
	S3UsePathStyle    bool
	S3UsePathStyleSet bool
	S3AccessKeyID     string
	S3SecretAccessKey string
	S3SessionToken    string

	SessionTTL            time.Duration
	AllowPasswordlessAuth bool
	ShutdownTimeout       time.Duration
	RateLimitFailOpen     bool
	RealtimeBuffer        int
	RealtimeNodeID        string
	RealtimeRelayRequired bool
	RealtimeStreamMaxLen  int64
	RealtimeStreamTTL     time.Duration
	RealtimeReadBlock     time.Duration
}

// Load reads and validates an environment map. Errors identify fields without
// echoing their potentially secret values.
func Load(env map[string]string) (Config, error) {
	var cfg Config
	var problems []string

	cfg.Environment = value(env, "APP_ENV", "development")
	if cfg.Environment != "development" && cfg.Environment != "test" &&
		cfg.Environment != "production" {
		problems = append(problems, "APP_ENV")
	}
	cfg.ServiceName = value(env, "SERVICE_NAME", "berry-server")
	if strings.TrimSpace(cfg.ServiceName) == "" {
		problems = append(problems, "SERVICE_NAME")
	}

	level, err := parseLogLevel(value(env, "LOG_LEVEL", "info"))
	if err != nil {
		problems = append(problems, "LOG_LEVEL")
	}
	cfg.LogLevel = level

	cfg.APIAddr = value(env, "API_ADDR", "0.0.0.0:4000")
	if _, _, err := net.SplitHostPort(cfg.APIAddr); err != nil {
		problems = append(problems, "API_ADDR")
	}

	cfg.DatabaseURL = strings.TrimSpace(env["DATABASE_URL"])
	if cfg.DatabaseURL != "" && !hasURLScheme(cfg.DatabaseURL, "postgres", "postgresql") {
		problems = append(problems, "DATABASE_URL")
	}
	if cfg.Environment == "production" && cfg.DatabaseURL == "" {
		problems = append(problems, "DATABASE_URL (required in production)")
	}

	cfg.ValkeyEnabled = boolean(env, "VALKEY_ENABLED", false, &problems)
	cfg.ValkeyRequired = boolean(env, "VALKEY_REQUIRED", false, &problems)
	cfg.ValkeyURL = value(env, "VALKEY_URL", "redis://127.0.0.1:6379/0")
	cfg.CacheFailOpen = boolean(env, "CACHE_FAIL_OPEN", true, &problems)
	if cfg.ValkeyRequired && !cfg.ValkeyEnabled {
		problems = append(problems, "VALKEY_REQUIRED (requires VALKEY_ENABLED)")
	}
	if cfg.ValkeyEnabled && !hasURLScheme(cfg.ValkeyURL, "redis", "rediss", "valkey") {
		problems = append(problems, "VALKEY_URL")
	}

	cfg.OpenFangBaseURL = value(env, "OPENFANG_BASE_URL", "http://127.0.0.1:4200")
	if !hasURLScheme(cfg.OpenFangBaseURL, "http", "https") {
		problems = append(problems, "OPENFANG_BASE_URL")
	}
	cfg.OpenFangAPIKey = env["OPENFANG_API_KEY"]
	if cfg.Environment == "production" && strings.TrimSpace(cfg.OpenFangAPIKey) == "" {
		problems = append(problems, "OPENFANG_API_KEY (required in production)")
	}

	cfg.MetricsEnabled = boolean(env, "METRICS_ENABLED", true, &problems)
	cfg.TrustedOrigins = origins(env["TRUSTED_ORIGINS"], &problems)
	if len(cfg.TrustedOrigins) == 0 &&
		(cfg.Environment == "development" || cfg.Environment == "test") {
		cfg.TrustedOrigins = []string{"http://localhost:3000", "http://127.0.0.1:3000"}
	}

	cfg.StorageBackend = value(env, "STORAGE_BACKEND", "local")
	if cfg.StorageBackend != "local" && cfg.StorageBackend != "s3" {
		problems = append(problems, "STORAGE_BACKEND")
	}
	cfg.StorageLocalRoot = value(env, "STORAGE_LOCAL_ROOT", "./data/uploads")
	cfg.StorageMaxBytes = positiveInt64(
		env,
		"STORAGE_MAX_BYTES",
		25*1024*1024,
		&problems,
	)
	cfg.S3Bucket = strings.TrimSpace(env["S3_BUCKET"])
	cfg.S3Region = strings.TrimSpace(env["S3_REGION"])
	cfg.S3Endpoint = strings.TrimSpace(env["S3_ENDPOINT"])
	if legacyEndpoint := strings.TrimSpace(env["AWS_ENDPOINT_URL"]); cfg.S3Endpoint == "" {
		cfg.S3Endpoint = legacyEndpoint
	} else if legacyEndpoint != "" && legacyEndpoint != cfg.S3Endpoint {
		problems = append(problems, "S3_ENDPOINT, AWS_ENDPOINT_URL")
	}
	cfg.S3UsePathStyle = boolean(
		env,
		"S3_USE_PATH_STYLE",
		cfg.S3Endpoint != "",
		&problems,
	)
	if raw, ok := env["S3_USE_PATH_STYLE"]; ok && strings.TrimSpace(raw) != "" {
		cfg.S3UsePathStyleSet = true
	}
	cfg.S3AccessKeyID = strings.TrimSpace(env["AWS_ACCESS_KEY_ID"])
	cfg.S3SecretAccessKey = env["AWS_SECRET_ACCESS_KEY"]
	cfg.S3SessionToken = env["AWS_SESSION_TOKEN"]
	if cfg.StorageBackend == "s3" {
		if cfg.S3Bucket == "" {
			problems = append(problems, "S3_BUCKET")
		}
		if cfg.S3Region == "" {
			problems = append(problems, "S3_REGION")
		}
		if cfg.S3Endpoint != "" && !safeHTTPURL(cfg.S3Endpoint) {
			problems = append(problems, "S3_ENDPOINT")
		}
		hasAccessKey := cfg.S3AccessKeyID != ""
		hasSecretKey := strings.TrimSpace(cfg.S3SecretAccessKey) != ""
		if hasAccessKey != hasSecretKey {
			problems = append(problems, "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY")
		}
		if cfg.S3SessionToken != "" && !hasAccessKey {
			problems = append(problems, "AWS_SESSION_TOKEN")
		}
	}

	cfg.SessionTTL = duration(env, "SESSION_TTL", 30*24*time.Hour, &problems)
	cfg.AllowPasswordlessAuth = boolean(
		env,
		"AUTH_ALLOW_PASSWORDLESS_LOGIN",
		false,
		&problems,
	)
	if cfg.Environment == "production" && cfg.AllowPasswordlessAuth {
		problems = append(problems, "AUTH_ALLOW_PASSWORDLESS_LOGIN")
	}
	cfg.ShutdownTimeout = duration(
		env,
		"SHUTDOWN_TIMEOUT",
		15*time.Second,
		&problems,
	)
	cfg.RateLimitFailOpen = boolean(
		env,
		"RATE_LIMIT_FAIL_OPEN",
		false,
		&problems,
	)
	cfg.RealtimeBuffer = positiveInt(env, "REALTIME_BUFFER", 64, &problems)
	cfg.RealtimeNodeID = strings.TrimSpace(env["REALTIME_NODE_ID"])
	if cfg.RealtimeNodeID != "" && !safeIdentifier(cfg.RealtimeNodeID, 128) {
		problems = append(problems, "REALTIME_NODE_ID")
	}
	cfg.RealtimeRelayRequired = boolean(
		env,
		"REALTIME_RELAY_REQUIRED",
		cfg.ValkeyRequired,
		&problems,
	)
	if cfg.RealtimeRelayRequired && !cfg.ValkeyEnabled {
		problems = append(
			problems,
			"REALTIME_RELAY_REQUIRED (requires VALKEY_ENABLED)",
		)
	}
	cfg.RealtimeStreamMaxLen = positiveInt64(
		env,
		"REALTIME_STREAM_MAXLEN",
		10_000,
		&problems,
	)
	if cfg.RealtimeStreamMaxLen > 1_000_000 {
		problems = append(problems, "REALTIME_STREAM_MAXLEN")
	}
	cfg.RealtimeStreamTTL = duration(
		env,
		"REALTIME_STREAM_TTL",
		15*time.Minute,
		&problems,
	)
	if cfg.RealtimeStreamTTL < time.Second || cfg.RealtimeStreamTTL > 24*time.Hour {
		problems = append(problems, "REALTIME_STREAM_TTL")
	}
	cfg.RealtimeReadBlock = duration(
		env,
		"REALTIME_READ_BLOCK",
		5*time.Second,
		&problems,
	)
	if cfg.RealtimeReadBlock < 10*time.Millisecond ||
		cfg.RealtimeReadBlock >= cfg.RealtimeStreamTTL {
		problems = append(problems, "REALTIME_READ_BLOCK")
	}

	if len(problems) > 0 {
		return Config{}, fmt.Errorf(
			"invalid environment configuration: %s",
			strings.Join(unique(problems), ", "),
		)
	}
	return cfg, nil
}

// FromEnv validates the current process environment.
func FromEnv() (Config, error) {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		key, raw, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = raw
		}
	}
	return Load(env)
}

// SafeSummary returns only non-secret booleans and process metadata.
func (cfg Config) SafeSummary() map[string]any {
	return map[string]any{
		"environment":            cfg.Environment,
		"service":                cfg.ServiceName,
		"databaseConfigured":     cfg.DatabaseURL != "",
		"valkeyEnabled":          cfg.ValkeyEnabled,
		"valkeyRequired":         cfg.ValkeyRequired,
		"realtimeRelayRequired":  cfg.RealtimeRelayRequired,
		"realtimeNodeConfigured": cfg.RealtimeNodeID != "",
		"metricsEnabled":         cfg.MetricsEnabled,
		"storageBackend":         cfg.StorageBackend,
		"s3EndpointConfigured":   cfg.S3Endpoint != "",
		"openFangConfigured":     cfg.OpenFangBaseURL != "",
	}
}

func value(env map[string]string, key, fallback string) string {
	if raw, ok := env[key]; ok {
		return raw
	}
	return fallback
}

func boolean(
	env map[string]string,
	key string,
	fallback bool,
	problems *[]string,
) bool {
	raw, ok := env[key]
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	default:
		*problems = append(*problems, key)
		return fallback
	}
}

func duration(
	env map[string]string,
	key string,
	fallback time.Duration,
	problems *[]string,
) time.Duration {
	raw, ok := env[key]
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed <= 0 {
		*problems = append(*problems, key)
		return fallback
	}
	return parsed
}

func positiveInt(
	env map[string]string,
	key string,
	fallback int,
	problems *[]string,
) int {
	raw, ok := env[key]
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		*problems = append(*problems, key)
		return fallback
	}
	return parsed
}

func positiveInt64(
	env map[string]string,
	key string,
	fallback int64,
	problems *[]string,
) int64 {
	raw, ok := env[key]
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || parsed <= 0 {
		*problems = append(*problems, key)
		return fallback
	}
	return parsed
}

func parseLogLevel(raw string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return slog.LevelInfo, errors.New("unsupported log level")
	}
}

func hasURLScheme(raw string, allowed ...string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	for _, scheme := range allowed {
		if strings.EqualFold(parsed.Scheme, scheme) {
			return true
		}
	}
	return false
}

func safeHTTPURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != "" &&
		parsed.User == nil &&
		parsed.RawQuery == "" &&
		parsed.Fragment == ""
}

func safeIdentifier(value string, maxBytes int) bool {
	if value == "" || len(value) > maxBytes || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '-' || character == '_' || character == '.' {
			continue
		}
		return false
	}
	return true
}

func origins(raw string, problems *[]string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	seen := make(map[string]struct{})
	result := make([]string, 0)
	for _, item := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(item)
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
			parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" ||
			parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
			*problems = append(*problems, "TRUSTED_ORIGINS")
			continue
		}
		normalized := parsed.Scheme + "://" + parsed.Host
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func unique(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, item := range values {
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		result = append(result, item)
	}
	return result
}
