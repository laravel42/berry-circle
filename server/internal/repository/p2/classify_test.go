package p2

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// A batch move to todo that hits the approval gate must surface as a
// conflict the handler can name, not as an internal error.
func TestClassifyWriteMapsApprovalGateToErrApprovalRequired(t *testing.T) {
	t.Parallel()
	if err := classifyWrite("batch update issue", &pgconn.PgError{Code: "23001"}); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("23001 = %v, want ErrApprovalRequired", err)
	}
	if err := classifyWrite("batch update issue", &pgconn.PgError{Code: "23503"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("23503 = %v, want ErrNotFound", err)
	}
	if err := classifyWrite("batch update issue", &pgconn.PgError{Code: "23505"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("23505 = %v, want ErrConflict", err)
	}
}
