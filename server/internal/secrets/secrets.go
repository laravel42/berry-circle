// Package secrets seals credentials Berry must be able to read back.
//
// Berry's only prior secret handling is `personal_api_tokens.secret_hash`, a
// one-way hash: the product never needs the original, so nothing reversible was
// required. Integration credentials are different — an access token has to be
// replayed to the provider on every call — so they need encryption rather than
// hashing, and that is the gap this package fills.
//
// One sealer, used by every integration, rather than encryption logic repeated
// per provider: a mistake in a shared implementation is one bug, while the same
// mistake copied five times is five that drift.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

// KeyBytes is the required key length. AES-256 only.
const KeyBytes = 32

// ErrNotConfigured means no key was supplied. Callers must treat this as fatal
// for any path that stores a credential rather than falling back to plaintext.
var ErrNotConfigured = errors.New("secrets: encryption key is not configured")

// ErrDecrypt covers every failure to open a sealed value — wrong key, truncated
// input, tampered ciphertext. The cause is deliberately not distinguished:
// telling a caller which of those happened is an oracle.
var ErrDecrypt = errors.New("secrets: could not decrypt")

// Sealer encrypts and decrypts credential material.
type Sealer interface {
	Seal(plaintext []byte) ([]byte, error)
	Open(sealed []byte) ([]byte, error)
}

// AESGCM seals with AES-256-GCM. The nonce is random per call and prefixed to
// the ciphertext, so sealing the same token twice yields different bytes and a
// reader cannot tell that two workspaces connected the same account.
type AESGCM struct {
	aead cipher.AEAD
}

// NewAESGCM builds a sealer from a raw 32-byte key.
func NewAESGCM(key []byte) (*AESGCM, error) {
	if len(key) != KeyBytes {
		return nil, fmt.Errorf("secrets: key must be %d bytes, got %d", KeyBytes, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("secrets: build cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("secrets: build gcm: %w", err)
	}
	return &AESGCM{aead: aead}, nil
}

// NewFromBase64Key builds a sealer from a base64-encoded 32-byte key, which is
// how the key travels in configuration.
func NewFromBase64Key(encoded string) (*AESGCM, error) {
	if encoded == "" {
		return nil, ErrNotConfigured
	}
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		// The key itself is never echoed, here or anywhere.
		return nil, errors.New("secrets: key is not valid base64")
	}
	return NewAESGCM(key)
}

// Seal encrypts plaintext. An empty input seals to nothing rather than to an
// encrypted empty string, so an absent refresh token stays absent in the column
// instead of becoming a value that looks present.
func (sealer *AESGCM) Seal(plaintext []byte) ([]byte, error) {
	if sealer == nil || sealer.aead == nil {
		return nil, ErrNotConfigured
	}
	if len(plaintext) == 0 {
		return nil, nil
	}
	nonce := make([]byte, sealer.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("secrets: read nonce: %w", err)
	}
	return sealer.aead.Seal(nonce, nonce, plaintext, nil), nil
}

// Open decrypts a value produced by Seal.
func (sealer *AESGCM) Open(sealed []byte) ([]byte, error) {
	if sealer == nil || sealer.aead == nil {
		return nil, ErrNotConfigured
	}
	if len(sealed) == 0 {
		return nil, nil
	}
	nonceSize := sealer.aead.NonceSize()
	if len(sealed) < nonceSize+1 {
		return nil, ErrDecrypt
	}
	plaintext, err := sealer.aead.Open(nil, sealed[:nonceSize], sealed[nonceSize:], nil)
	if err != nil {
		return nil, ErrDecrypt
	}
	return plaintext, nil
}

// GenerateKey returns a new base64 key, for operators bootstrapping a
// deployment. Berry never generates one implicitly: a key that appears on its
// own would differ between restarts and silently strand every stored token.
func GenerateKey() (string, error) {
	key := make([]byte, KeyBytes)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return "", fmt.Errorf("secrets: generate key: %w", err)
	}
	return base64.StdEncoding.EncodeToString(key), nil
}
