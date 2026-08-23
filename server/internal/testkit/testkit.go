// Package testkit contains deterministic helpers shared by endpoint tests.
package testkit

import (
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Clock is a concurrency-safe deterministic clock.
type Clock struct {
	mu  sync.Mutex
	now time.Time
}

// NewClock creates a clock at instant.
func NewClock(instant time.Time) *Clock {
	return &Clock{now: instant.UTC()}
}

// Now returns the current test instant.
func (clock *Clock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

// Advance moves the test clock forward.
func (clock *Clock) Advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(duration)
}

// IDs returns a deterministic sequence of UUIDs.
type IDs struct {
	mu     sync.Mutex
	values []uuid.UUID
}

// NewIDs creates a deterministic ID generator.
func NewIDs(values ...uuid.UUID) *IDs {
	return &IDs{values: append([]uuid.UUID(nil), values...)}
}

// New returns the next configured UUID and panics if a test under-provisioned.
func (ids *IDs) New() uuid.UUID {
	ids.mu.Lock()
	defer ids.mu.Unlock()
	if len(ids.values) == 0 {
		panic("testkit IDs exhausted")
	}
	value := ids.values[0]
	ids.values = ids.values[1:]
	return value
}

// DecodeJSON decodes a response and fails the current test on malformed JSON.
func DecodeJSON[T any](t testing.TB, body io.Reader) T {
	t.Helper()
	var value T
	if err := json.NewDecoder(body).Decode(&value); err != nil {
		t.Fatalf("decode JSON response: %v", err)
	}
	return value
}
