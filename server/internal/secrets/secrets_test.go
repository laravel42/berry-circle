package secrets

import (
	"bytes"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func newTestSealer(t *testing.T) *AESGCM {
	t.Helper()
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	sealer, err := NewFromBase64Key(key)
	if err != nil {
		t.Fatalf("NewFromBase64Key: %v", err)
	}
	return sealer
}

func TestSealedCredentialRoundTrips(t *testing.T) {
	sealer := newTestSealer(t)
	token := []byte("FAKE-TEST-FIXTURE-not-a-real-token")

	sealed, err := sealer.Seal(token)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if bytes.Contains(sealed, token) {
		t.Fatal("sealed value contains the plaintext token")
	}
	opened, err := sealer.Open(sealed)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !bytes.Equal(opened, token) {
		t.Errorf("round trip = %q, want %q", opened, token)
	}
}

// Sealing the same token twice must not produce the same bytes, or a reader of
// the table could tell that two workspaces connected the same account.
func TestSealingIsNotDeterministic(t *testing.T) {
	sealer := newTestSealer(t)
	token := []byte("FAKE-TEST-FIXTURE-slack")

	first, err := sealer.Seal(token)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	second, err := sealer.Seal(token)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if bytes.Equal(first, second) {
		t.Error("two seals of the same plaintext produced identical ciphertext")
	}
}

// An absent refresh token must stay absent rather than becoming an encrypted
// empty string, which would read as present in the column.
func TestEmptyPlaintextSealsToNothing(t *testing.T) {
	sealer := newTestSealer(t)
	sealed, err := sealer.Seal(nil)
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if sealed != nil {
		t.Errorf("Seal(nil) = %v, want nil", sealed)
	}
	opened, err := sealer.Open(nil)
	if err != nil || opened != nil {
		t.Errorf("Open(nil) = %v, %v; want nil, nil", opened, err)
	}
}

func TestTamperedCiphertextIsRejected(t *testing.T) {
	sealer := newTestSealer(t)
	sealed, err := sealer.Seal([]byte("secret"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	tampered := append([]byte(nil), sealed...)
	tampered[len(tampered)-1] ^= 0xff

	if _, err := sealer.Open(tampered); !errors.Is(err, ErrDecrypt) {
		t.Errorf("Open(tampered) error = %v, want ErrDecrypt", err)
	}
}

func TestAValueSealedWithAnotherKeyIsRejected(t *testing.T) {
	sealed, err := newTestSealer(t).Seal([]byte("secret"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if _, err := newTestSealer(t).Open(sealed); !errors.Is(err, ErrDecrypt) {
		t.Errorf("Open with a different key = %v, want ErrDecrypt", err)
	}
}

func TestTruncatedCiphertextIsRejected(t *testing.T) {
	sealer := newTestSealer(t)
	sealed, err := sealer.Seal([]byte("secret"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	for _, size := range []int{1, 4, sealer.aead.NonceSize()} {
		if _, err := sealer.Open(sealed[:size]); !errors.Is(err, ErrDecrypt) {
			t.Errorf("Open(truncated to %d) = %v, want ErrDecrypt", size, err)
		}
	}
}

// An unconfigured sealer must refuse rather than pass plaintext through. A
// caller that ignored this would write a live token to the column.
func TestAnUnconfiguredSealerRefuses(t *testing.T) {
	var sealer *AESGCM
	if _, err := sealer.Seal([]byte("secret")); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("Seal on nil sealer = %v, want ErrNotConfigured", err)
	}
	if _, err := sealer.Open([]byte("x")); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("Open on nil sealer = %v, want ErrNotConfigured", err)
	}
	if _, err := NewFromBase64Key(""); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("NewFromBase64Key(\"\") = %v, want ErrNotConfigured", err)
	}
}

func TestKeyLengthIsEnforced(t *testing.T) {
	short := base64.StdEncoding.EncodeToString([]byte("too-short"))
	_, err := NewFromBase64Key(short)
	if err == nil {
		t.Fatal("a short key was accepted")
	}
	// The key must never appear in an error a caller might log.
	if strings.Contains(err.Error(), short) {
		t.Errorf("error echoes the key material: %v", err)
	}
	if _, err := NewFromBase64Key("not base64!!"); err == nil {
		t.Error("invalid base64 was accepted")
	}
}
