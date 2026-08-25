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

// SystemActorID is the user row seeded by migration 009 that automated runs
// are attributed to. runs.requested_by is a foreign key to users(id), so
// intake needs a real identity; this is it. It is not a login and no session
// is ever issued for it.
const SystemActorID = "00000000-0000-4000-8000-000000000001"

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

	// Temporal drives durable run orchestration and continuous task intake
	// (ADR-0005). Disabled selects the in-process dispatcher, which is a
	// supported configuration.
	TemporalEnabled     bool
	TemporalRequired    bool
	TemporalHostPort    string
	TemporalNamespace   string
	TemporalTaskQueue   string
	IntakeEnabled       bool
	IntakeInterval      time.Duration
	IntakeBatchSize     int
	IntakeMaxConcurrent int
	// IntakeActorID attributes automated runs to a real Berry user, because
	// runs.requested_by is a foreign key to users(id) and an audit trail that
	// cannot name who started a run is not an audit trail.
	IntakeActorID string
	// The built-in orchestrator runs on whatever model the deployment chose.
	// Berry does not pick an LLM for an operator, so provisioning is skipped
	// when these are unset and the orchestrator stays unavailable.
	OrchestratorProvider string
	OrchestratorModel    string

	// Infobip carries conversations and calls to people away from their
	// computer. Berry owns the conversation; this is transport only, so an
	// unconfigured Infobip degrades to in-app messaging rather than failing.
	InfobipEnabled       bool
	InfobipBaseURL       string
	InfobipAPIKey        string
	InfobipWhatsAppFrom  string
	InfobipSMSFrom       string
	InfobipWebhookSecret string

	// RuntimeWorkspaceRoot is where the runtime's workspaces volume is mounted
	// into this process, read-only. Empty disables artifact promotion, so a
	// deployment without the mount behaves as it did before ADR-0006 rather
	// than failing every run.
	RuntimeWorkspaceRoot string

	// Integrations connect a workspace to GitHub, Slack, Linear, Notion and
	// Gmail. Berry owns the credential; the runtime's MCP servers make the
	// calls. Enabled only when there is a key to seal tokens with, because a
	// deployment that cannot encrypt them must not collect them.
	IntegrationsEnabled          bool
	IntegrationEncryptionKey     string
	IntegrationCallbackBaseURL   string
	IntegrationRedirectAllowlist []string
	// GitHubAppSlug builds the app's install link. Without an installation a
	// user-to-server token reads only public repositories, and the install link
	// is the fix — so the slug is worth carrying just to be able to show it.
	GitHubAppSlug string
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

	cfg.TemporalEnabled = boolean(env, "TEMPORAL_ENABLED", false, &problems)
	cfg.TemporalRequired = boolean(
		env,
		"TEMPORAL_REQUIRED",
		cfg.TemporalEnabled,
		&problems,
	)
	if cfg.TemporalRequired && !cfg.TemporalEnabled {
		problems = append(
			problems,
			"TEMPORAL_REQUIRED (requires TEMPORAL_ENABLED)",
		)
	}
	cfg.TemporalHostPort = strings.TrimSpace(
		value(env, "TEMPORAL_HOSTPORT", "temporal:7233"),
	)
	cfg.TemporalNamespace = strings.TrimSpace(
		value(env, "TEMPORAL_NAMESPACE", "berry"),
	)
	cfg.TemporalTaskQueue = strings.TrimSpace(
		value(env, "TEMPORAL_TASK_QUEUE", "berry-runs"),
	)
	if cfg.TemporalEnabled {
		if _, _, err := net.SplitHostPort(cfg.TemporalHostPort); err != nil {
			problems = append(problems, "TEMPORAL_HOSTPORT")
		}
		if !safeIdentifier(cfg.TemporalNamespace, 255) {
			problems = append(problems, "TEMPORAL_NAMESPACE")
		}
		if !safeIdentifier(cfg.TemporalTaskQueue, 255) {
			problems = append(problems, "TEMPORAL_TASK_QUEUE")
		}
	}

	// Continuous intake pulls todo issues to available agents. It cannot run
	// without Temporal: the claim must be durable or work is lost on restart.
	cfg.IntakeEnabled = boolean(env, "INTAKE_ENABLED", false, &problems)
	if cfg.IntakeEnabled && !cfg.TemporalEnabled {
		problems = append(problems, "INTAKE_ENABLED (requires TEMPORAL_ENABLED)")
	}
	cfg.IntakeInterval = duration(env, "INTAKE_INTERVAL", 10*time.Second, &problems)
	if cfg.IntakeInterval < time.Second || cfg.IntakeInterval > time.Hour {
		problems = append(problems, "INTAKE_INTERVAL")
	}
	cfg.IntakeBatchSize = positiveInt(env, "INTAKE_BATCH_SIZE", 10, &problems)
	if cfg.IntakeBatchSize > 500 {
		problems = append(problems, "INTAKE_BATCH_SIZE")
	}
	// The ceiling on agent runs Berry will hold open at once. Every admitted
	// run costs provider tokens, so this is a spend control, not just a
	// throughput knob.
	cfg.IntakeMaxConcurrent = positiveInt(env, "INTAKE_MAX_CONCURRENT", 8, &problems)
	if cfg.IntakeMaxConcurrent > 1000 {
		problems = append(problems, "INTAKE_MAX_CONCURRENT")
	}
	// Defaults to the system actor seeded by migration 009, so intake works on
	// a fresh deployment without the operator inventing an identity.
	cfg.IntakeActorID = strings.TrimSpace(
		value(env, "INTAKE_ACTOR_ID", SystemActorID),
	)
	if cfg.IntakeEnabled && !isUUID(cfg.IntakeActorID) {
		problems = append(problems, "INTAKE_ACTOR_ID")
	}
	cfg.OrchestratorProvider = strings.TrimSpace(env["ORCHESTRATOR_PROVIDER"])
	cfg.OrchestratorModel = strings.TrimSpace(env["ORCHESTRATOR_MODEL"])

	cfg.InfobipEnabled = boolean(env, "INFOBIP_ENABLED", false, &problems)
	cfg.InfobipBaseURL = strings.TrimSpace(env["INFOBIP_BASE_URL"])
	cfg.InfobipAPIKey = strings.TrimSpace(env["INFOBIP_API_KEY"])
	cfg.InfobipWhatsAppFrom = strings.TrimSpace(env["INFOBIP_WHATSAPP_FROM"])
	cfg.InfobipSMSFrom = strings.TrimSpace(env["INFOBIP_SMS_FROM"])
	cfg.InfobipWebhookSecret = strings.TrimSpace(env["INFOBIP_WEBHOOK_SECRET"])

	// The key is the whole of the at-rest protection, so its absence disables
	// the feature rather than downgrading it. There is deliberately no
	// generated default: a key that appeared on its own would differ between
	// restarts and strand every token already stored under the previous one.
	cfg.RuntimeWorkspaceRoot = strings.TrimSpace(env["RUNTIME_WORKSPACE_ROOT"])
	cfg.GitHubAppSlug = strings.TrimSpace(env["GITHUB_APP_SLUG"])

	cfg.IntegrationEncryptionKey = strings.TrimSpace(env["INTEGRATION_ENCRYPTION_KEY"])
	cfg.IntegrationCallbackBaseURL = strings.TrimSpace(env["INTEGRATION_CALLBACK_BASE_URL"])
	cfg.IntegrationRedirectAllowlist = redirectAllowlist(
		env["INTEGRATION_REDIRECT_ALLOWLIST"], &problems)
	cfg.IntegrationsEnabled = cfg.IntegrationEncryptionKey != ""
	if cfg.IntegrationsEnabled {
		// Providers send an authorisation code wherever this points, so a wrong
		// or missing origin means codes land somewhere Berry does not control.
		if !safeHTTPURL(cfg.IntegrationCallbackBaseURL) {
			problems = append(problems, "INTEGRATION_CALLBACK_BASE_URL")
		}
		// Empty would leave a completed flow with nowhere to return the person.
		if len(cfg.IntegrationRedirectAllowlist) == 0 {
			problems = append(problems, "INTEGRATION_REDIRECT_ALLOWLIST")
		}
	}
	if cfg.InfobipEnabled {
		// The base URL is per-account, so there is no safe default to fall back
		// on — a wrong host would send customer messages somewhere unintended.
		if !safeHTTPURL(cfg.InfobipBaseURL) {
			problems = append(problems, "INFOBIP_BASE_URL")
		}
		if cfg.InfobipAPIKey == "" {
			problems = append(problems, "INFOBIP_API_KEY")
		}
		// Inbound webhooks create messages attributed to a user. Without a
		// shared secret anyone who finds the URL can post as that person.
		if cfg.InfobipWebhookSecret == "" {
			problems = append(problems, "INFOBIP_WEBHOOK_SECRET")
		}
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
		"temporalEnabled":        cfg.TemporalEnabled,
		"temporalRequired":       cfg.TemporalRequired,
		"intakeEnabled":          cfg.IntakeEnabled,
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

// value resolves a setting that has a meaningful default.
//
// A present-but-empty variable falls back rather than overriding. Compose
// idiomatically forwards optional settings as "${VAR:-}", which sets the key to
// an empty string; treating that as an explicit choice silently defeats every
// default this function exists to provide. Settings where empty is itself
// meaningful — optional credentials — read env[key] directly instead.
func value(env map[string]string, key, fallback string) string {
	if raw, ok := env[key]; ok && strings.TrimSpace(raw) != "" {
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

// redirectAllowlist parses the addresses Berry may return a browser to.
//
// Unlike a trusted origin, a redirect target keeps its path: the allowlist
// exists to name one settings page, not to open a whole host. Credentials in
// the URL and a fragment are both refused — the first is never legitimate here,
// and the second would be silently dropped on the wire while looking like it
// had been honoured.
func redirectAllowlist(raw string, problems *[]string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	result := make([]string, 0)
	for _, item := range strings.Split(raw, ",") {
		candidate := strings.TrimSpace(item)
		if candidate == "" {
			continue
		}
		parsed, err := url.Parse(candidate)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
			parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
			*problems = append(*problems, "INTEGRATION_REDIRECT_ALLOWLIST")
			continue
		}
		result = append(result, candidate)
	}
	return result
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

// isUUID reports whether a value is a canonical 36-character UUID. Kept local
// so the config package keeps its dependency-free boundary.
func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		isHex := (character >= '0' && character <= '9') ||
			(character >= 'a' && character <= 'f') ||
			(character >= 'A' && character <= 'F')
		if !isHex {
			return false
		}
	}
	return true
}
