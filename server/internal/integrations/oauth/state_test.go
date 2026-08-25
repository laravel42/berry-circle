package oauth

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestStateSecretsAreUnguessableAndUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		secret, err := NewSecret()
		if err != nil {
			t.Fatalf("NewSecret: %v", err)
		}
		if len(secret) < 40 {
			t.Fatalf("state secret is only %d chars; too little entropy", len(secret))
		}
		if seen[secret] {
			t.Fatal("NewSecret repeated a value")
		}
		seen[secret] = true
	}
}

// Only the hash is stored, so a leaked table read cannot complete a flow.
func TestOnlyTheHashIsStorable(t *testing.T) {
	secret, err := NewSecret()
	if err != nil {
		t.Fatalf("NewSecret: %v", err)
	}
	hash := HashSecret(secret)
	if len(hash) != 32 {
		t.Errorf("hash is %d bytes, want 32", len(hash))
	}
	if bytes.Contains(hash, []byte(secret)) {
		t.Error("the hash contains the secret")
	}
	if !bytes.Equal(hash, HashSecret(secret)) {
		t.Error("hashing is not deterministic")
	}
	other, _ := NewSecret()
	if bytes.Equal(hash, HashSecret(other)) {
		t.Error("two secrets hashed alike")
	}
}

func validState(now time.Time) State {
	return State{
		ID:          uuid.New(),
		WorkspaceID: uuid.New(),
		UserID:      uuid.New(),
		Provider:    "github",
		ExpiresAt:   now.Add(StateTTL),
	}
}

func TestValidateAcceptsAFreshIssuedState(t *testing.T) {
	now := time.Now()
	if err := Validate(validState(now), now); err != nil {
		t.Errorf("a fresh state was rejected: %v", err)
	}
}

// State Berry never issued is the signature of a forged callback.
func TestValidateRejectsUnknownState(t *testing.T) {
	if err := Validate(State{}, time.Now()); !errors.Is(err, ErrStateUnknown) {
		t.Errorf("err = %v, want ErrStateUnknown", err)
	}
}

func TestValidateRejectsExpiredState(t *testing.T) {
	now := time.Now()
	state := validState(now)
	state.ExpiresAt = now.Add(-time.Second)
	if err := Validate(state, now); !errors.Is(err, ErrStateExpired) {
		t.Errorf("err = %v, want ErrStateExpired", err)
	}
}

// A second callback with the same state is a replay.
func TestValidateRejectsReuse(t *testing.T) {
	now := time.Now()
	state := validState(now)
	consumed := now.Add(-time.Minute)
	state.ConsumedAt = &consumed
	if err := Validate(state, now); !errors.Is(err, ErrStateUsed) {
		t.Errorf("err = %v, want ErrStateUsed", err)
	}
}

// Reuse must be caught even when the state has also expired: checking expiry
// first would report the wrong reason and, worse, a caller ordering these
// differently could accept a replay inside the window.
func TestReuseIsCaughtBeforeExpiry(t *testing.T) {
	now := time.Now()
	state := validState(now)
	state.ExpiresAt = now.Add(-time.Hour)
	consumed := now.Add(-2 * time.Hour)
	state.ConsumedAt = &consumed
	if err := Validate(state, now); !errors.Is(err, ErrStateUsed) {
		t.Errorf("err = %v, want ErrStateUsed", err)
	}
}

// An open redirect hands the authorisation code to whoever the URI points at.
func TestRedirectMustBeAllowlisted(t *testing.T) {
	allowed := []string{"https://berry.example.com/integrations"}
	for name, candidate := range map[string]string{
		"exact":       "https://berry.example.com/integrations",
		"deeper path": "https://berry.example.com/integrations/github/callback",
	} {
		if err := AllowRedirect(candidate, allowed); err != nil {
			t.Errorf("%s was rejected: %v", name, err)
		}
	}
	for name, candidate := range map[string]string{
		"suffix host attack": "https://berry.example.com.evil.test/integrations",
		"other host":         "https://evil.test/integrations",
		"other path":         "https://berry.example.com/admin",
		"plain http":         "http://berry.example.com/integrations",
		"scheme mismatch":    "ftp://berry.example.com/integrations",
		"not a url":          "://nope",
		"empty":              "",
	} {
		if err := AllowRedirect(candidate, allowed); !errors.Is(err, ErrRedirectNotAllowed) {
			t.Errorf("%s was accepted: %v", name, err)
		}
	}
}

// Development runs over plain HTTP on loopback, and must keep working without
// weakening the rule for anything else.
func TestLoopbackMayUsePlainHTTP(t *testing.T) {
	allowed := []string{"http://localhost:3000/integrations"}
	if err := AllowRedirect("http://localhost:3000/integrations", allowed); err != nil {
		t.Errorf("loopback callback was rejected: %v", err)
	}
	if err := AllowRedirect("http://evil.test/integrations", allowed); !errors.Is(err, ErrRedirectNotAllowed) {
		t.Error("a non-loopback plain-http callback was accepted")
	}
}

func TestConstantTimeEqual(t *testing.T) {
	if !ConstantTimeEqual("abc", "abc") {
		t.Error("equal values compared unequal")
	}
	if ConstantTimeEqual("abc", "abd") || ConstantTimeEqual("abc", "abcd") {
		t.Error("unequal values compared equal")
	}
}
