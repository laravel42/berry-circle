package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"
	"time"
)

func sign(secret, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestGitHubSignatureIsVerified(t *testing.T) {
	const secret, body = "s3cr3t", `{"action":"opened"}`
	good := "sha256=" + sign(secret, body)

	if err := VerifyGitHub(secret, []byte(body), good); err != nil {
		t.Fatalf("a valid signature was rejected: %v", err)
	}
	for name, header := range map[string]string{
		"wrong digest":   "sha256=" + sign("other-secret", body),
		"missing prefix": sign(secret, body),
		"not hex":        "sha256=zzzz",
		"empty":          "",
		// GitHub still sends a SHA-1 header; accepting it would let a forger
		// choose the weaker algorithm.
		"legacy sha1": "sha1=" + sign(secret, body),
	} {
		if err := VerifyGitHub(secret, []byte(body), header); !errors.Is(err, ErrInvalidSignature) {
			t.Errorf("%s: err = %v, want ErrInvalidSignature", name, err)
		}
	}
}

// A body that differs by one byte must fail, or the signature guarantees
// nothing about what was actually sent.
func TestGitHubSignatureCoversTheBody(t *testing.T) {
	const secret, body = "s3cr3t", `{"action":"opened"}`
	header := "sha256=" + sign(secret, body)
	if err := VerifyGitHub(secret, []byte(`{"action":"closed"}`), header); !errors.Is(err, ErrInvalidSignature) {
		t.Errorf("a modified body verified: %v", err)
	}
}

func TestAnUnconfiguredSecretRefuses(t *testing.T) {
	if err := VerifyGitHub("", []byte("{}"), "sha256=abcd"); err == nil {
		t.Error("verification passed with no secret configured")
	}
	if err := VerifyHMACSHA256Hex("", []byte("{}"), "abcd"); err == nil {
		t.Error("verification passed with no secret configured")
	}
	if err := VerifySlack("", []byte("{}"), "1", "v0=abcd", time.Now()); err == nil {
		t.Error("verification passed with no secret configured")
	}
}

func TestSlackSignatureIsVerified(t *testing.T) {
	const secret, body = "slack-signing-secret", `token=x&team_id=T1`
	now := time.Unix(1_700_000_000, 0)
	timestamp := fmt.Sprintf("%d", now.Unix())
	good := "v0=" + sign(secret, "v0:"+timestamp+":"+body)

	if err := VerifySlack(secret, []byte(body), timestamp, good, now); err != nil {
		t.Fatalf("a valid signature was rejected: %v", err)
	}
	if err := VerifySlack(secret, []byte(body), timestamp, "v0="+sign("other", "x"), now); !errors.Is(err, ErrInvalidSignature) {
		t.Error("a forged signature verified")
	}
	if err := VerifySlack(secret, []byte(body), timestamp, sign(secret, body), now); !errors.Is(err, ErrInvalidSignature) {
		t.Error("a signature without the v0 prefix verified")
	}
}

// Without a freshness check a captured request stays replayable forever.
func TestSlackRejectsAStaleOrFutureTimestamp(t *testing.T) {
	const secret, body = "slack-signing-secret", `payload`
	signedAt := time.Unix(1_700_000_000, 0)
	timestamp := fmt.Sprintf("%d", signedAt.Unix())
	header := "v0=" + sign(secret, "v0:"+timestamp+":"+body)

	for name, now := range map[string]time.Time{
		"replayed an hour later": signedAt.Add(time.Hour),
		"dated an hour ahead":    signedAt.Add(-time.Hour),
	} {
		if err := VerifySlack(secret, []byte(body), timestamp, header, now); !errors.Is(err, ErrInvalidSignature) {
			t.Errorf("%s: err = %v, want ErrInvalidSignature", name, err)
		}
	}
	// Still inside the window.
	if err := VerifySlack(secret, []byte(body), timestamp, header, signedAt.Add(time.Minute)); err != nil {
		t.Errorf("a fresh request was rejected: %v", err)
	}
	if err := VerifySlack(secret, []byte(body), "not-a-number", header, signedAt); !errors.Is(err, ErrInvalidSignature) {
		t.Error("a non-numeric timestamp verified")
	}
}

// The timestamp is inside the signed string, so moving it must invalidate.
func TestSlackSignatureBindsTheTimestamp(t *testing.T) {
	const secret, body = "slack-signing-secret", `payload`
	signedAt := time.Unix(1_700_000_000, 0)
	header := "v0=" + sign(secret, "v0:"+fmt.Sprintf("%d", signedAt.Unix())+":"+body)

	other := fmt.Sprintf("%d", signedAt.Add(time.Minute).Unix())
	if err := VerifySlack(secret, []byte(body), other, header, signedAt); !errors.Is(err, ErrInvalidSignature) {
		t.Error("a signature verified against a different timestamp")
	}
}

func TestPlainHMACSignatureIsVerified(t *testing.T) {
	const secret, body = "linear-secret", `{"action":"update"}`
	if err := VerifyHMACSHA256Hex(secret, []byte(body), sign(secret, body)); err != nil {
		t.Fatalf("a valid signature was rejected: %v", err)
	}
	// A prefixed form is tolerated because providers differ on it.
	if err := VerifyHMACSHA256Hex(secret, []byte(body), "sha256="+sign(secret, body)); err != nil {
		t.Errorf("a prefixed signature was rejected: %v", err)
	}
	if err := VerifyHMACSHA256Hex(secret, []byte(body), sign("other", body)); !errors.Is(err, ErrInvalidSignature) {
		t.Error("a forged signature verified")
	}
}
