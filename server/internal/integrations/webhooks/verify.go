// Package webhooks verifies and normalises inbound provider events.
//
// A webhook endpoint is an unauthenticated door into Berry: anyone who learns
// the URL can post to it. Signature verification is therefore the only thing
// separating a provider's event from an attacker's, and it runs before the body
// is parsed, let alone acted on.
package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ErrInvalidSignature covers every verification failure. The reason is not
// distinguished to the caller: telling a prober which part of their forgery was
// wrong helps them fix it.
var ErrInvalidSignature = errors.New("webhooks: signature is not valid")

// maxSkew bounds how old a signed request may be. Without it a captured
// request stays replayable forever.
const maxSkew = 5 * time.Minute

// VerifyGitHub checks the X-Hub-Signature-256 header over the raw body.
//
// The raw body must be the bytes as received. Re-serialising parsed JSON
// changes key order and whitespace, and the signature would never match.
func VerifyGitHub(secret string, body []byte, header string) error {
	if secret == "" {
		return errors.New("webhooks: github secret is not configured")
	}
	// GitHub also sends a SHA-1 header for compatibility. It is deliberately
	// not accepted: offering a weaker algorithm lets a forger choose it.
	value, ok := strings.CutPrefix(header, "sha256=")
	if !ok {
		return ErrInvalidSignature
	}
	expected := hmac.New(sha256.New, []byte(secret))
	expected.Write(body)
	return compareHex(value, expected.Sum(nil))
}

// VerifySlack checks v0 request signing.
//
// The timestamp is part of the signed string and is also checked for freshness,
// so a captured request cannot be replayed once it ages out.
func VerifySlack(secret string, body []byte, timestamp, signature string, now time.Time) error {
	if secret == "" {
		return errors.New("webhooks: slack signing secret is not configured")
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return ErrInvalidSignature
	}
	age := now.Sub(time.Unix(seconds, 0))
	if age < 0 {
		age = -age
	}
	if age > maxSkew {
		return ErrInvalidSignature
	}
	value, ok := strings.CutPrefix(signature, "v0=")
	if !ok {
		return ErrInvalidSignature
	}
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "v0:%s:", timestamp)
	mac.Write(body)
	return compareHex(value, mac.Sum(nil))
}

// VerifyHMACSHA256Hex checks a plain hex HMAC-SHA256 body signature, which is
// what Linear and Notion-style webhooks use.
func VerifyHMACSHA256Hex(secret string, body []byte, signature string) error {
	if secret == "" {
		return errors.New("webhooks: secret is not configured")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return compareHex(strings.TrimPrefix(signature, "sha256="), mac.Sum(nil))
}

// compareHex decodes the presented signature and compares in constant time.
//
// Decoding first, rather than hex-encoding the expected value and comparing
// strings, keeps the comparison over fixed-length bytes: a string compare would
// leak length through timing before it leaked content.
func compareHex(presented string, expected []byte) error {
	decoded, err := hex.DecodeString(presented)
	if err != nil {
		return ErrInvalidSignature
	}
	if !hmac.Equal(decoded, expected) {
		return ErrInvalidSignature
	}
	return nil
}
