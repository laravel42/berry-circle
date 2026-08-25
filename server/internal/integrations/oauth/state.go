// Package oauth carries the parts of an authorisation flow Berry owns.
//
// The provider owns the consent screen; Berry owns proving that the callback it
// receives belongs to a flow it started, for a workspace it knows, and has not
// already been used.
package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

// StateTTL bounds how long an authorisation may sit half-finished. Long enough
// for a person to read a consent screen, short enough that an abandoned flow
// stops being usable.
const StateTTL = 10 * time.Minute

var (
	// ErrStateUnknown means the callback presented state Berry never issued —
	// the signature of a cross-site request forgery.
	ErrStateUnknown = errors.New("oauth: state was not issued by this server")
	// ErrStateExpired means the flow sat too long.
	ErrStateExpired = errors.New("oauth: state has expired")
	// ErrStateUsed means the state was already redeemed. A second callback with
	// the same state is a replay.
	ErrStateUsed = errors.New("oauth: state has already been used")
	// ErrRedirectNotAllowed means the callback URI is not one Berry serves.
	ErrRedirectNotAllowed = errors.New("oauth: redirect uri is not allowed")
)

// State is an issued, unredeemed authorisation.
type State struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	UserID      uuid.UUID
	Provider    string
	RedirectURI string
	Scopes      []string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	ConsumedAt  *time.Time
}

// NewSecret returns an opaque state value for the authorisation URL.
//
// 32 bytes from crypto/rand: the value is the whole CSRF defence, so it has to
// be unguessable rather than merely unique.
func NewSecret() (string, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", fmt.Errorf("oauth: generate state: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// HashSecret reduces a state value to what is stored.
//
// Only the hash is persisted, so a leaked database read does not let an
// attacker complete a flow that somebody else started.
func HashSecret(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// Validate checks an issued state against the callback that presented it.
//
// Order matters: existence, then expiry, then reuse. A caller that skipped
// straight to marking it consumed would accept an expired flow.
func Validate(state State, now time.Time) error {
	if state.ID == uuid.Nil {
		return ErrStateUnknown
	}
	if state.ConsumedAt != nil {
		return ErrStateUsed
	}
	if !state.ExpiresAt.After(now) {
		return ErrStateExpired
	}
	return nil
}

// ConstantTimeEqual compares two state values without leaking their contents
// through timing. Used where a value is compared outside the database.
func ConstantTimeEqual(presented, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) == 1
}

// AllowRedirect reports whether a callback URI may be used.
//
// An open redirect here would hand an attacker the authorisation code: the
// provider sends the code wherever the redirect points, so the set of
// acceptable destinations must be closed, not merely validated for shape.
func AllowRedirect(candidate string, allowed []string) error {
	parsed, err := url.Parse(candidate)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ErrRedirectNotAllowed
	}
	if parsed.Scheme != "https" && !isLoopback(parsed.Hostname()) {
		// Plain HTTP is tolerated only on loopback, where development runs.
		return ErrRedirectNotAllowed
	}
	for _, base := range allowed {
		if base == "" {
			continue
		}
		// Exact origin plus path prefix. A prefix match on the whole URL would
		// let "https://berry.example.com.evil.test/" pass against
		// "https://berry.example.com/".
		allowedURL, err := url.Parse(base)
		if err != nil {
			continue
		}
		if !strings.EqualFold(allowedURL.Scheme, parsed.Scheme) {
			continue
		}
		if !strings.EqualFold(allowedURL.Host, parsed.Host) {
			continue
		}
		if allowedURL.Path == "" || strings.HasPrefix(parsed.Path, allowedURL.Path) {
			return nil
		}
	}
	return ErrRedirectNotAllowed
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
