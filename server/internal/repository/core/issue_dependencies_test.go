package core

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// A dependency reference is part of the issue resource, so it must serialise
// with the contract's lowercase keys, not Go field names.
func TestIssueDependencyRefSerialisesWithWireKeys(t *testing.T) {
	encoded, err := json.Marshal(IssueDependencyRef{ID: uuid.MustParse("11111111-1111-4111-8111-111111111111"), Identifier: "BER-7", Title: "Blocker", Status: "inProgress"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"id":"11111111-1111-4111-8111-111111111111","identifier":"BER-7","title":"Blocker","status":"inProgress"}`
	if string(encoded) != want {
		t.Fatalf("encoded = %s, want %s", encoded, want)
	}
}
