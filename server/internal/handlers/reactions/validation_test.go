package reactions

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidEmojiAcceptsOneUnicodeEmojiSequence(t *testing.T) {
	t.Parallel()
	for _, value := range []string{
		"😀",
		"❤️",
		"👍🏽",
		"👩‍💻",
		"🏳️‍🌈",
		"🇭🇷",
		"1️⃣",
	} {
		if !validEmoji(value) {
			t.Errorf("validEmoji(%q) = false", value)
		}
	}
}

func TestValidEmojiRejectsTextAndMultipleSequences(t *testing.T) {
	t.Parallel()
	for _, value := range []string{
		"",
		"ok",
		"é",
		"界",
		"😀😀",
		"🇭",
		" 👍",
		"👍 ",
		"👍\n",
		"👍x",
	} {
		if validEmoji(value) {
			t.Errorf("validEmoji(%q) = true", value)
		}
	}
}

func TestParseEmojiBodyRejectsUnknownFields(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(
		http.MethodPost,
		"/",
		strings.NewReader(`{"emoji":"😀","extra":true}`),
	)
	response := httptest.NewRecorder()

	if _, ok := parseEmojiBody(response, request); ok {
		t.Fatal("parseEmojiBody() accepted an unknown field")
	}
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", response.Code, response.Body)
	}
}
