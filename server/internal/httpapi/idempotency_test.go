package httpapi

import (
	"testing"
)

func TestValidateIdempotencyKey(t *testing.T) {
	t.Parallel()

	if err := ValidateIdempotencyKey("0123456789abcdef"); err != nil {
		t.Fatalf("ValidateIdempotencyKey(valid) error = %v", err)
	}
	for _, key := range []string{
		"short",
		"0123456789abcde\n",
		"0123456789abcde ",
		string(make([]byte, 129)),
	} {
		if err := ValidateIdempotencyKey(key); err == nil {
			t.Errorf("ValidateIdempotencyKey(%q) accepted an invalid key", key)
		}
	}
}

func TestFingerprintJSONCanonicalizesObjectWhitespaceAndOrder(t *testing.T) {
	t.Parallel()

	first, err := FingerprintJSON([]byte(`{"title":"Berry","count":1}`))
	if err != nil {
		t.Fatalf("FingerprintJSON(first) error = %v", err)
	}
	second, err := FingerprintJSON([]byte("{\n  \"count\": 1, \"title\": \"Berry\"\n}"))
	if err != nil {
		t.Fatalf("FingerprintJSON(second) error = %v", err)
	}
	if first != second {
		t.Fatal("equivalent JSON objects produced different fingerprints")
	}
	different, err := FingerprintJSON([]byte(`{"title":"Other","count":1}`))
	if err != nil {
		t.Fatalf("FingerprintJSON(different) error = %v", err)
	}
	if first == different {
		t.Fatal("different JSON objects produced the same fingerprint")
	}
}

func TestFingerprintJSONRejectsTrailingValue(t *testing.T) {
	t.Parallel()

	if _, err := FingerprintJSON([]byte(`{} {}`)); err == nil {
		t.Fatal("FingerprintJSON() accepted multiple JSON values")
	}
}
