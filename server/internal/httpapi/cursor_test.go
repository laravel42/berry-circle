package httpapi

import (
	"errors"
	"testing"
)

func TestCursorRoundTrip(t *testing.T) {
	t.Parallel()

	type key struct {
		UpdatedAt string `json:"updatedAt"`
		ID        string `json:"id"`
	}
	want := key{UpdatedAt: "2026-08-22T12:00:00Z", ID: "issue-1"}
	token, err := EncodeCursor("issues.list", want)
	if err != nil {
		t.Fatalf("EncodeCursor() error = %v", err)
	}
	var got key
	if err := DecodeCursor(token, "issues.list", &got); err != nil {
		t.Fatalf("DecodeCursor() error = %v", err)
	}
	if got != want {
		t.Fatalf("decoded key = %#v, want %#v", got, want)
	}
}

func TestCursorRejectsWrongScopeAndMalformedTokens(t *testing.T) {
	t.Parallel()

	token, err := EncodeCursor("issues.list", map[string]string{"id": "issue-1"})
	if err != nil {
		t.Fatalf("EncodeCursor() error = %v", err)
	}
	var key map[string]string
	if err := DecodeCursor(token, "boards.list", &key); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("DecodeCursor(wrong scope) error = %v, want ErrInvalidCursor", err)
	}
	for _, malformed := range []string{"", "not base64!", "e30"} {
		if err := DecodeCursor(malformed, "issues.list", &key); !errors.Is(err, ErrInvalidCursor) {
			t.Errorf("DecodeCursor(%q) error = %v, want ErrInvalidCursor", malformed, err)
		}
	}
}
