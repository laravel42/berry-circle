package core

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository owns the temporary hand-written pgx boundary for Berry core data.
//
// TODO(sqlc): move these isolated statements into pkg/db/queries after Berry
// selects a policy-compatible sqlc generator. Do not hand-edit pkg/db/gen.
type Repository struct {
	Pool *pgxpool.Pool
}

// New requires the authoritative PostgreSQL pool.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("core repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

func decodeColumns(encoded []byte) ([]BoardColumn, error) {
	var columns []BoardColumn
	if err := json.Unmarshal(encoded, &columns); err != nil {
		return nil, fmt.Errorf("decode board columns: %w", err)
	}
	return columns, nil
}

func encodeColumns(columns []BoardColumn) ([]byte, error) {
	encoded, err := json.Marshal(columns)
	if err != nil {
		return nil, fmt.Errorf("encode board columns: %w", err)
	}
	return encoded, nil
}

func classifyWriteError(operation string, err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrNotFound
		case "23505", "23P01":
			return ErrConflict
		case "23001":
			return ErrApprovalRequired
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}
