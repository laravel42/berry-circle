package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"strings"
)

const (
	tokenBytes             = 32
	personalTokenIDBytes   = 12
	PersonalTokenPrefix    = "berry_pat_"
	personalTokenSeparator = "_"
)

// GeneratedPersonalToken is split into an indexed public identifier and a
// high-entropy secret. Only SecretHash is persisted.
type GeneratedPersonalToken struct {
	Token      string
	PublicID   string
	SecretHash [sha256.Size]byte
}

// GenerateToken returns 256 bits encoded as unpadded base64url.
func GenerateToken(random io.Reader) (string, error) {
	if random == nil {
		random = rand.Reader
	}
	raw := make([]byte, tokenBytes)
	if _, err := io.ReadFull(random, raw); err != nil {
		return "", errors.New("generate session token")
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// HashToken returns the lowercase SHA-256 value persisted in sessions.token_hash.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// DigestToken returns the binary SHA-256 digest used by one-time secret stores.
func DigestToken(token string) [sha256.Size]byte {
	return sha256.Sum256([]byte(token))
}

// GeneratePersonalToken creates berry_pat_<public-id>_<secret>. The public
// identifier supports one indexed lookup; the secret retains 256 bits.
func GeneratePersonalToken(random io.Reader) (GeneratedPersonalToken, error) {
	if random == nil {
		random = rand.Reader
	}
	publicRaw := make([]byte, personalTokenIDBytes)
	if _, err := io.ReadFull(random, publicRaw); err != nil {
		return GeneratedPersonalToken{}, errors.New("generate personal token identifier")
	}
	secretRaw := make([]byte, tokenBytes)
	if _, err := io.ReadFull(random, secretRaw); err != nil {
		return GeneratedPersonalToken{}, errors.New("generate personal token secret")
	}
	publicID := base64.RawURLEncoding.EncodeToString(publicRaw)
	secret := base64.RawURLEncoding.EncodeToString(secretRaw)
	return GeneratedPersonalToken{
		Token:      PersonalTokenPrefix + publicID + personalTokenSeparator + secret,
		PublicID:   publicID,
		SecretHash: sha256.Sum256([]byte(secret)),
	}, nil
}

// ParsePersonalToken validates and separates Berry's personal bearer format.
func ParsePersonalToken(token string) (string, string, error) {
	if !strings.HasPrefix(token, PersonalTokenPrefix) {
		return "", "", ErrUnauthenticated
	}
	remainder := strings.TrimPrefix(token, PersonalTokenPrefix)

	// Split on position rather than on the first separator. Both halves are
	// base64url and that alphabet includes '_', so cutting at the first one
	// lands inside the public identifier whenever it happens to contain one.
	// Both halves are fixed width, so the separator's index is known: 60% of
	// every token this package issued was refused by this function.
	publicLen := base64.RawURLEncoding.EncodedLen(personalTokenIDBytes)
	secretLen := base64.RawURLEncoding.EncodedLen(tokenBytes)
	if len(remainder) != publicLen+len(personalTokenSeparator)+secretLen ||
		!strings.HasPrefix(remainder[publicLen:], personalTokenSeparator) {
		return "", "", ErrUnauthenticated
	}
	publicID := remainder[:publicLen]
	secret := remainder[publicLen+len(personalTokenSeparator):]
	publicRaw, publicErr := base64.RawURLEncoding.DecodeString(publicID)
	secretRaw, secretErr := base64.RawURLEncoding.DecodeString(secret)
	if publicErr != nil || secretErr != nil ||
		len(publicRaw) != personalTokenIDBytes || len(secretRaw) != tokenBytes {
		return "", "", ErrUnauthenticated
	}
	return publicID, secret, nil
}

// IsPersonalToken reports whether a credential claims Berry's PAT namespace.
// Claimed-but-malformed PATs must never fall through to session verification.
func IsPersonalToken(token string) bool {
	return strings.HasPrefix(token, PersonalTokenPrefix)
}

// ParseAuthorization accepts exactly one strict session or personal bearer.
//
// Scheme casing, extra whitespace, padding, and additional credentials are
// rejected so every malformed credential has the same authentication result.
func ParseAuthorization(header string) (string, error) {
	if !strings.HasPrefix(header, "Bearer ") ||
		strings.Count(header, " ") != 1 {
		return "", ErrUnauthenticated
	}
	token := strings.TrimPrefix(header, "Bearer ")
	if IsPersonalToken(token) {
		if _, _, err := ParsePersonalToken(token); err != nil {
			return "", ErrUnauthenticated
		}
		return token, nil
	}
	if len(token) != base64.RawURLEncoding.EncodedLen(tokenBytes) {
		return "", ErrUnauthenticated
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(decoded) != tokenBytes {
		return "", ErrUnauthenticated
	}
	return token, nil
}
