package cache

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrMiss reports an absent disposable cache value.
var ErrMiss = errors.New("cache miss")

var keyPart = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// Key is a validated, versioned Berry cache key.
type Key string

// NewKey creates berry:<owner>:v1:<parts...>. Tenant-aware owners must include
// the workspace identifier in parts.
func NewKey(owner string, parts ...string) (Key, error) {
	all := append([]string{owner, "v1"}, parts...)
	for _, part := range all {
		if !keyPart.MatchString(part) {
			return "", errors.New("cache key contains an invalid component")
		}
	}
	return Key("berry:" + strings.Join(all, ":")), nil
}

// Store is the small disposable-cache contract consumed by domain packages.
type Store interface {
	Get(context.Context, Key) ([]byte, error)
	Set(context.Context, Key, []byte, time.Duration) error
	Delete(context.Context, Key) error
}

// Client wraps the Valkey-compatible go-redis client.
type Client struct {
	raw *redis.Client
}

// Open connects to Valkey and verifies it with PING.
func Open(ctx context.Context, rawURL string) (*Client, error) {
	if strings.HasPrefix(rawURL, "valkey://") {
		rawURL = "redis://" + strings.TrimPrefix(rawURL, "valkey://")
	}
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, errors.New("open Valkey: VALKEY_URL is invalid")
	}
	raw := redis.NewClient(options)
	if err := raw.Ping(ctx).Err(); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("ping Valkey: %w", err)
	}
	return &Client{raw: raw}, nil
}

// Raw exposes the command client to bounded platform primitives such as the
// fixed-window rate limiter. Product packages should use Store instead.
func (client *Client) Raw() *redis.Client {
	if client == nil {
		return nil
	}
	return client.raw
}

// Get returns ErrMiss when no value exists.
func (client *Client) Get(ctx context.Context, key Key) ([]byte, error) {
	if client == nil || client.raw == nil {
		return nil, errors.New("cache unavailable")
	}
	value, err := client.raw.Get(ctx, string(key)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrMiss
	}
	if err != nil {
		return nil, fmt.Errorf("get cache value: %w", err)
	}
	return value, nil
}

// Set stores a value with a required positive expiry.
func (client *Client) Set(
	ctx context.Context,
	key Key,
	value []byte,
	ttl time.Duration,
) error {
	if client == nil || client.raw == nil {
		return errors.New("cache unavailable")
	}
	if ttl <= 0 {
		return errors.New("cache TTL must be positive")
	}
	if err := client.raw.Set(ctx, string(key), value, ttl).Err(); err != nil {
		return fmt.Errorf("set cache value: %w", err)
	}
	return nil
}

// Delete invalidates one cache value.
func (client *Client) Delete(ctx context.Context, key Key) error {
	if client == nil || client.raw == nil {
		return errors.New("cache unavailable")
	}
	if err := client.raw.Del(ctx, string(key)).Err(); err != nil {
		return fmt.Errorf("delete cache value: %w", err)
	}
	return nil
}

// Ping checks Valkey availability.
func (client *Client) Ping(ctx context.Context) error {
	if client == nil || client.raw == nil {
		return errors.New("Valkey is not configured")
	}
	if err := client.raw.Ping(ctx).Err(); err != nil {
		return errors.New("Valkey ping failed")
	}
	return nil
}

// Close releases the Valkey connection pool.
func (client *Client) Close() error {
	if client == nil || client.raw == nil {
		return nil
	}
	return client.raw.Close()
}

// Readiness only fails for an absent or unhealthy client when Valkey is
// configured as required.
type Readiness struct {
	Client   *Client
	Required bool
}

// Check evaluates Valkey readiness.
func (checker Readiness) Check(ctx context.Context) error {
	if !checker.Required {
		return nil
	}
	if checker.Client == nil {
		return errors.New("required Valkey is unavailable")
	}
	return checker.Client.Ping(ctx)
}

// FailOpen converts optional cache outages into misses while preserving
// authoritative PostgreSQL-backed behavior.
type FailOpen struct {
	Backend Store
	Enabled bool
	Logger  *slog.Logger
}

// Get delegates or returns a miss when optional cache access fails.
func (cache FailOpen) Get(ctx context.Context, key Key) ([]byte, error) {
	if cache.Backend == nil {
		if cache.Enabled {
			return nil, ErrMiss
		}
		return nil, errors.New("cache unavailable")
	}
	value, err := cache.Backend.Get(ctx, key)
	if err != nil && cache.Enabled && !errors.Is(err, ErrMiss) {
		cache.logFailure("get")
		return nil, ErrMiss
	}
	return value, err
}

// Set delegates or ignores an optional cache outage.
func (cache FailOpen) Set(
	ctx context.Context,
	key Key,
	value []byte,
	ttl time.Duration,
) error {
	if cache.Backend == nil {
		if cache.Enabled {
			return nil
		}
		return errors.New("cache unavailable")
	}
	if err := cache.Backend.Set(ctx, key, value, ttl); err != nil {
		if cache.Enabled {
			cache.logFailure("set")
			return nil
		}
		return err
	}
	return nil
}

// Delete delegates or ignores an optional cache outage.
func (cache FailOpen) Delete(ctx context.Context, key Key) error {
	if cache.Backend == nil {
		if cache.Enabled {
			return nil
		}
		return errors.New("cache unavailable")
	}
	if err := cache.Backend.Delete(ctx, key); err != nil {
		if cache.Enabled {
			cache.logFailure("delete")
			return nil
		}
		return err
	}
	return nil
}

func (cache FailOpen) logFailure(operation string) {
	if cache.Logger != nil {
		cache.Logger.Warn("optional cache operation failed", "operation", operation)
	}
}
