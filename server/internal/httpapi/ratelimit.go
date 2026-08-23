package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/laravel42/berry-circle/server/internal/cache"
)

// RateDecision describes one fixed-window budget check.
type RateDecision struct {
	Allowed   bool
	Remaining int64
	ResetAt   time.Time
}

// RateLimiter is implemented by Valkey in production and memory in tests.
type RateLimiter interface {
	Allow(context.Context, string, int64, time.Duration) (RateDecision, error)
}

var fixedWindowScript = redis.NewScript(`
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return {current, ttl}
`)

// ValkeyRateLimiter is a shared fixed-window IP limiter.
type ValkeyRateLimiter struct {
	Client *cache.Client
	Now    func() time.Time
}

// Allow consumes one Valkey-backed budget unit.
func (limiter ValkeyRateLimiter) Allow(
	ctx context.Context,
	subject string,
	limit int64,
	window time.Duration,
) (RateDecision, error) {
	if limiter.Client == nil || limiter.Client.Raw() == nil {
		return RateDecision{}, errors.New("rate limiter is unavailable")
	}
	if limit <= 0 || window <= 0 {
		return RateDecision{}, errors.New("rate limit and window must be positive")
	}
	sum := sha256.Sum256([]byte(subject))
	key, err := cache.NewKey("rate", hex.EncodeToString(sum[:16]))
	if err != nil {
		return RateDecision{}, err
	}
	value, err := fixedWindowScript.Run(
		ctx,
		limiter.Client.Raw(),
		[]string{string(key)},
		window.Milliseconds(),
	).Result()
	if err != nil {
		return RateDecision{}, fmt.Errorf("check rate limit: %w", err)
	}
	parts, ok := value.([]any)
	if !ok || len(parts) != 2 {
		return RateDecision{}, errors.New("rate limiter returned an invalid result")
	}
	count, ok := parts[0].(int64)
	if !ok {
		return RateDecision{}, errors.New("rate limiter count is invalid")
	}
	ttlMillis, ok := parts[1].(int64)
	if !ok || ttlMillis < 0 {
		ttlMillis = window.Milliseconds()
	}
	now := time.Now
	if limiter.Now != nil {
		now = limiter.Now
	}
	return RateDecision{
		Allowed:   count <= limit,
		Remaining: max(limit-count, 0),
		ResetAt:   now().Add(time.Duration(ttlMillis) * time.Millisecond),
	}, nil
}

type memoryWindow struct {
	count   int64
	resetAt time.Time
}

// MemoryRateLimiter is deterministic and process-local for tests.
type MemoryRateLimiter struct {
	mu      sync.Mutex
	windows map[string]memoryWindow
	Now     func() time.Time
}

// NewMemoryRateLimiter creates an empty test limiter.
func NewMemoryRateLimiter(now func() time.Time) *MemoryRateLimiter {
	if now == nil {
		now = time.Now
	}
	return &MemoryRateLimiter{
		windows: make(map[string]memoryWindow),
		Now:     now,
	}
}

// Allow consumes one in-memory budget unit.
func (limiter *MemoryRateLimiter) Allow(
	ctx context.Context,
	subject string,
	limit int64,
	window time.Duration,
) (RateDecision, error) {
	if err := ctx.Err(); err != nil {
		return RateDecision{}, err
	}
	if limiter == nil || limit <= 0 || window <= 0 {
		return RateDecision{}, errors.New("rate limiter configuration is invalid")
	}
	now := limiter.Now()
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	entry, exists := limiter.windows[subject]
	if !exists || !entry.resetAt.After(now) {
		entry = memoryWindow{resetAt: now.Add(window)}
	}
	entry.count++
	limiter.windows[subject] = entry
	return RateDecision{
		Allowed:   entry.count <= limit,
		Remaining: max(limit-entry.count, 0),
		ResetAt:   entry.resetAt,
	}, nil
}

// RateLimitByIP applies a budget using the directly connected client IP. Proxy
// header trust belongs in a separately configured deployment boundary.
func RateLimitByIP(
	limiter RateLimiter,
	limit int64,
	window time.Duration,
	failOpen bool,
	logger *slog.Logger,
) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			var (
				decision RateDecision
				err      error
			)
			if limiter == nil {
				err = errors.New("rate limiter is unavailable")
			} else {
				decision, err = limiter.Allow(
					request.Context(),
					clientIP(request.RemoteAddr),
					limit,
					window,
				)
			}
			if err != nil {
				if failOpen {
					logger.Warn("rate limiter unavailable; allowing request")
					next.ServeHTTP(response, request)
					return
				}
				WriteError(
					response,
					request,
					http.StatusServiceUnavailable,
					"DEPENDENCY_UNAVAILABLE",
					"Request rate limiting is unavailable.",
					nil,
				)
				return
			}
			response.Header().Set(
				"X-RateLimit-Remaining",
				strconv.FormatInt(decision.Remaining, 10),
			)
			if !decision.Allowed {
				retryAfter := max(
					int(math.Ceil(time.Until(decision.ResetAt).Seconds())),
					1,
				)
				response.Header().Set("Retry-After", strconv.Itoa(retryAfter))
				WriteError(
					response,
					request,
					http.StatusTooManyRequests,
					"RATE_LIMITED",
					"Too many requests.",
					nil,
				)
				return
			}
			next.ServeHTTP(response, request)
		})
	}
}

func clientIP(remoteAddress string) string {
	host, _, err := net.SplitHostPort(remoteAddress)
	if err == nil {
		return host
	}
	if remoteAddress == "" {
		return "unknown"
	}
	return remoteAddress
}
