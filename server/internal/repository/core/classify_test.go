package core

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// The 010 plan gate and the 020 issue_start gate both raise restrict_violation
// when an issue is moved to todo before its approval. Without this mapping a
// manual PATCH on a gated issue is an internal error instead of a 409.
func TestClassifyWriteErrorMapsApprovalGateToErrApprovalRequired(t *testing.T) {
	t.Parallel()
	cases := []struct {
		code string
		want error
	}{
		{code: "23001", want: ErrApprovalRequired},
		{code: "23503", want: ErrNotFound},
		{code: "23505", want: ErrConflict},
		{code: "23P01", want: ErrConflict},
	}
	for _, testCase := range cases {
		err := classifyWriteError("update issue", &pgconn.PgError{Code: testCase.code})
		if !errors.Is(err, testCase.want) {
			t.Errorf("classifyWriteError(%s) = %v, want %v", testCase.code, err, testCase.want)
		}
	}
	other := classifyWriteError("update issue", &pgconn.PgError{Code: "23514"})
	if errors.Is(other, ErrApprovalRequired) || errors.Is(other, ErrConflict) || errors.Is(other, ErrNotFound) {
		t.Fatalf("an unrelated check violation was classified as a known error: %v", other)
	}
	if classifyWriteError("noop", nil) != nil {
		t.Fatal("nil error was wrapped")
	}
}

// The dependency trigger reports a cycle as check_violation and a
// cross-workspace edge as foreign_key_violation. A dependency write is the one
// place a check violation means "cycle", so the mapping is local to it.
func TestClassifyDependencyWriteDistinguishesCyclesFromMissingIssues(t *testing.T) {
	t.Parallel()
	if err := classifyDependencyWrite("add", &pgconn.PgError{Code: "23514"}); !errors.Is(err, ErrDependencyCycle) {
		t.Fatalf("23514 = %v, want ErrDependencyCycle", err)
	}
	if err := classifyDependencyWrite("add", &pgconn.PgError{Code: "23503"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("23503 = %v, want ErrNotFound", err)
	}
	if err := classifyDependencyWrite("add", &pgconn.PgError{Code: "23505"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("23505 = %v, want ErrConflict", err)
	}
}
