package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"regexp"
)

// ErrInvalidCursor maps to the public INVALID_CURSOR code.
var ErrInvalidCursor = errors.New("invalid cursor")

var cursorScopePattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,99}$`)

type cursorEnvelope struct {
	Version int             `json:"v"`
	Scope   string          `json:"scope"`
	Key     json.RawMessage `json:"key"`
}

// EncodeCursor serializes the v1/scope/key envelope as opaque URL-safe data.
func EncodeCursor(scope string, key any) (string, error) {
	if !cursorScopePattern.MatchString(scope) {
		return "", ErrInvalidCursor
	}
	encodedKey, err := json.Marshal(key)
	if err != nil || bytes.Equal(encodedKey, []byte("null")) {
		return "", ErrInvalidCursor
	}
	body, err := json.Marshal(cursorEnvelope{
		Version: 1,
		Scope:   scope,
		Key:     encodedKey,
	})
	if err != nil {
		return "", ErrInvalidCursor
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

// DecodeCursor validates the version and scope before decoding the stable key.
func DecodeCursor(token, expectedScope string, key any) error {
	if token == "" || len(token) > 4096 || key == nil ||
		!cursorScopePattern.MatchString(expectedScope) {
		return ErrInvalidCursor
	}
	body, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(body) > 3072 {
		return ErrInvalidCursor
	}
	var envelope cursorEnvelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return ErrInvalidCursor
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidCursor
	}
	if envelope.Version != 1 || envelope.Scope != expectedScope ||
		len(envelope.Key) == 0 || bytes.Equal(envelope.Key, []byte("null")) {
		return ErrInvalidCursor
	}
	keyDecoder := json.NewDecoder(bytes.NewReader(envelope.Key))
	keyDecoder.DisallowUnknownFields()
	if err := keyDecoder.Decode(key); err != nil {
		return ErrInvalidCursor
	}
	if err := keyDecoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidCursor
	}
	return nil
}
