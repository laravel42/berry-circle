package auth

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

// A personal token is berry_pat_<publicID>_<secret> where both halves are
// base64url — an alphabet that contains '_'. Parsing by searching for the
// separator therefore cuts in the wrong place whenever a half happens to
// contain one, which it does most of the time.

func TestEveryIssuedPersonalTokenParses(t *testing.T) {
	// The regression that motivates the fixed-width split. At the first-
	// separator implementation this failed on roughly 6 of every 10 tokens:
	// they were issued, shown to the user once, and never authenticated.
	const trials = 5000
	for i := 0; i < trials; i++ {
		generated, err := GeneratePersonalToken(rand.Reader)
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		publicID, secret, err := ParsePersonalToken(generated.Token)
		if err != nil {
			t.Fatalf("issued token %q was refused by its own parser: %v", generated.Token, err)
		}
		if publicID != generated.PublicID {
			t.Fatalf("public identifier round-tripped as %q, want %q", publicID, generated.PublicID)
		}
		if sha256.Sum256([]byte(secret)) != generated.SecretHash {
			t.Fatalf("secret round-tripped to a different digest")
		}
	}
}

func TestPersonalTokenSplitsAtTheFixedWidthEvenWhenBothHalvesAreSeparators(t *testing.T) {
	// 0xFF is base64url index 63, which encodes as '_'. This is the worst
	// case the alphabet allows: a token made almost entirely of separators.
	publicID := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xFF}, personalTokenIDBytes))
	secret := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xFF}, tokenBytes))
	if !strings.Contains(publicID, "_") || !strings.Contains(secret, "_") {
		t.Fatalf("expected separators in both halves, got %q and %q", publicID, secret)
	}

	gotPublic, gotSecret, err := ParsePersonalToken(
		PersonalTokenPrefix + publicID + personalTokenSeparator + secret,
	)
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	if gotPublic != publicID {
		t.Fatalf("public identifier = %q, want %q", gotPublic, publicID)
	}
	if gotSecret != secret {
		t.Fatalf("secret = %q, want %q", gotSecret, secret)
	}
}

func TestMalformedPersonalTokensAreStillRefused(t *testing.T) {
	valid, err := GeneratePersonalToken(rand.Reader)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	remainder := strings.TrimPrefix(valid.Token, PersonalTokenPrefix)
	publicLen := base64.RawURLEncoding.EncodedLen(personalTokenIDBytes)

	for name, token := range map[string]string{
		"no prefix":         remainder,
		"wrong prefix":      "berry_pat" + remainder,
		"no separator":      PersonalTokenPrefix + strings.Replace(remainder, "_", "", 1),
		"empty":             "",
		"prefix only":       PersonalTokenPrefix,
		"short secret":      PersonalTokenPrefix + remainder[:len(remainder)-1],
		"long secret":       PersonalTokenPrefix + remainder + "A",
		"invalid alphabet":  PersonalTokenPrefix + "*" + remainder[1:],
		"separator missing": PersonalTokenPrefix + remainder[:publicLen] + "A" + remainder[publicLen+1:],
	} {
		if _, _, err := ParsePersonalToken(token); err == nil {
			t.Errorf("%s: accepted %q", name, token)
		}
	}
}

func TestParsingIsAShapeCheckNotAuthentication(t *testing.T) {
	// A well-formed token that was never issued parses successfully: parsing
	// only separates the halves. Rejecting it is the store's job, which looks
	// the public identifier up and compares the secret's digest. Pinned so a
	// later reader does not mistake a successful parse for a verified caller.
	publicID := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x01}, personalTokenIDBytes))
	secret := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x02}, tokenBytes))

	if _, _, err := ParsePersonalToken(
		PersonalTokenPrefix + publicID + personalTokenSeparator + secret,
	); err != nil {
		t.Fatalf("a well-formed token should parse: %v", err)
	}
}
