package core

import (
	"reflect"
	"testing"
)

// The fields a patch names are what consumers key on, and a status set to the
// value the issue already has is not a move: reporting it would fire
// issue.started or issue.completed for a repeated PATCH.
func TestIssuePatchChangesReportsTouchedFieldsAndRealStatusMoves(t *testing.T) {
	t.Parallel()
	title := "Renamed"
	done := "done"
	inReview := "in_review"
	cases := []struct {
		name           string
		patch          IssuePatch
		current        string
		wantFields     []string
		wantPrevious   string
		wantNoPrevious bool
	}{
		{
			name:         "status move reports the previous status",
			patch:        IssuePatch{Status: &done},
			current:      "in_review",
			wantFields:   []string{"status"},
			wantPrevious: "in_review",
		},
		{
			name:           "same status is not a change",
			patch:          IssuePatch{Status: &inReview, Title: &title},
			current:        "in_review",
			wantFields:     []string{"title"},
			wantNoPrevious: true,
		},
		{
			name: "every other field is named on the wire",
			patch: IssuePatch{
				DescriptionSet: true,
				DueDateSet:     true,
				AssigneeSet:    true,
				ProjectSet:     true,
			},
			current:        "todo",
			wantFields:     []string{"description", "dueDate", "assignee", "project"},
			wantNoPrevious: true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			fields, previous := issuePatchChanges(testCase.patch, testCase.current)
			if !reflect.DeepEqual(fields, testCase.wantFields) {
				t.Fatalf("changed fields = %v, want %v", fields, testCase.wantFields)
			}
			if testCase.wantNoPrevious && previous != "" {
				t.Fatalf("previous status = %q, want none", previous)
			}
			if !testCase.wantNoPrevious && previous != testCase.wantPrevious {
				t.Fatalf("previous status = %q, want %q", previous, testCase.wantPrevious)
			}
		})
	}
}
