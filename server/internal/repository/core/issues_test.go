package core

import (
	"testing"

	"github.com/google/uuid"
)

func TestIssueWorkflowPreservesHumanReviewGate(t *testing.T) {
	t.Parallel()
	for _, transition := range []struct {
		from string
		to   string
		want bool
	}{
		{from: "backlog", to: "todo", want: true},
		{from: "todo", to: "in_progress", want: true},
		{from: "in_progress", to: "in_review", want: true},
		{from: "in_review", to: "done", want: true},
		{from: "backlog", to: "done", want: false},
		{from: "in_progress", to: "done", want: false},
		{from: "done", to: "todo", want: false},
		{from: "cancelled", to: "backlog", want: true},
	} {
		if got := canTransition(transition.from, transition.to); got != transition.want {
			t.Errorf(
				"canTransition(%q, %q) = %t, want %t",
				transition.from,
				transition.to,
				got,
				transition.want,
			)
		}
	}
}

func TestIssueStatusWireMapping(t *testing.T) {
	t.Parallel()
	if got := apiStatusToDB("inProgress"); got != "in_progress" {
		t.Fatalf("apiStatusToDB(inProgress) = %q", got)
	}
	if got := dbStatusToAPI("in_review"); got != "inReview" {
		t.Fatalf("dbStatusToAPI(in_review) = %q", got)
	}
}

func TestParseUUIDRequiresCanonicalRFC4122Text(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	if parsed, err := ParseUUID(id.String()); err != nil || parsed != id {
		t.Fatalf("ParseUUID(canonical) = %s, %v", parsed, err)
	}
	for _, value := range []string{
		"{" + id.String() + "}",
		"urn:uuid:" + id.String(),
		id.String()[:8] + id.String()[9:13] + id.String()[14:18] +
			id.String()[19:23] + id.String()[24:],
		"00000000-0000-0000-0000-000000000000",
	} {
		if _, err := ParseUUID(value); err == nil {
			t.Errorf("ParseUUID(%q) accepted a non-canonical UUID", value)
		}
	}
}
