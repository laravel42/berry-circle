package identity

import (
	"crypto/rand"
	"strings"
	"testing"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
)

// An invitation token is berry_inv_<secret> where the secret is unpadded
// base64url — an alphabet that includes '_'. The prefix is fixed length, so
// there is nothing for a separator check to disambiguate, and one refused
// roughly half of every token this service issued.

// acceptGuard is the shape check Service.AcceptInvitation applies before it
// touches the database.
func acceptGuard(token string) bool {
	if !strings.HasPrefix(token, InvitationTokenPrefix) {
		return false
	}
	secret := strings.TrimPrefix(token, InvitationTokenPrefix)
	decoded, err := coreauth.ParseAuthorization("Bearer " + secret)
	return err == nil && decoded == secret
}

func TestEveryIssuedInvitationTokenIsAccepted(t *testing.T) {
	const trials = 5000
	for i := 0; i < trials; i++ {
		secret, err := coreauth.GenerateToken(rand.Reader)
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		token := InvitationTokenPrefix + secret
		if !acceptGuard(token) {
			t.Fatalf("issued token %q was refused by its own guard", token)
		}
	}
}

func TestInvitationTokenWhoseSecretIsAllSeparators(t *testing.T) {
	// 0xFF encodes as '_' in base64url: the worst case the alphabet allows,
	// and deterministic where the loop above is statistical.
	secret, err := coreauth.GenerateToken(constantReader{0xFF})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if !strings.Contains(secret, "_") {
		t.Fatalf("expected separators in the secret, got %q", secret)
	}
	if !acceptGuard(InvitationTokenPrefix + secret) {
		t.Fatalf("refused a token this service would issue: %q", secret)
	}
}

func TestMalformedInvitationTokensAreStillRefused(t *testing.T) {
	valid, err := coreauth.GenerateToken(rand.Reader)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	for name, token := range map[string]string{
		"no prefix":        valid,
		"wrong prefix":     "berry_pat_" + valid,
		"empty":            "",
		"prefix only":      InvitationTokenPrefix,
		"short secret":     InvitationTokenPrefix + valid[:len(valid)-1],
		"long secret":      InvitationTokenPrefix + valid + "A",
		"invalid alphabet": InvitationTokenPrefix + "*" + valid[1:],
		"embedded space":   InvitationTokenPrefix + " " + valid[1:],
	} {
		if acceptGuard(token) {
			t.Errorf("%s: accepted %q", name, token)
		}
	}
}

type constantReader struct{ value byte }

func (reader constantReader) Read(buffer []byte) (int, error) {
	for i := range buffer {
		buffer[i] = reader.value
	}
	return len(buffer), nil
}
