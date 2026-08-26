// Package ledger is the shared persistence core of Berry's per-aggregate event
// ledgers: the issue run ledger (run_events, 002/003) and the automation run
// ledger (automation_run_events, 021).
//
// Both tables have the same shape — an owner id, a per-owner sequence
// allocated by a SQL function inside the writing transaction, a public flag,
// and replay by sequence inside a retention window — so the sequence
// allocation, append, replay and cursor code lives here once. The owning
// repositories keep their own row types and payloads; this package only knows
// the columns every ledger shares and the scope columns each table adds.
package ledger

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrCursorExpired means a replay cursor names an event outside the owner's
// public ledger or older than the retention window.
var ErrCursorExpired = errors.New("event cursor expired")

// Querier is the pgx surface a ledger call needs: a pool outside a
// transaction, a pgx.Tx inside one.
type Querier interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// Table describes one ledger table. Every value is a literal defined in this
// package and interpolated into SQL; none of them ever comes from a caller.
type Table struct {
	// Name is the events table.
	Name string
	// OwnerColumn is the column holding the aggregate the sequence belongs to.
	OwnerColumn string
	// AllocateFunction is the SQL function that bumps the owner's sequence
	// counter and returns the value to write on the next event.
	AllocateFunction string
	// ScopeColumns are the NOT NULL uuid columns each row carries beside the
	// owner: the board and issue for run events, the workspace for automation
	// run events. Every Row supplies them in this order.
	ScopeColumns []string
}

// Runs is the issue run ledger written by repository/runs.
var Runs = Table{
	Name:             "run_events",
	OwnerColumn:      "run_id",
	AllocateFunction: "berry_allocate_run_event_sequence",
	ScopeColumns:     []string{"board_id", "issue_id"},
}

// AutomationRuns is the automation run ledger written by repository/automation.
var AutomationRuns = Table{
	Name:             "automation_run_events",
	OwnerColumn:      "automation_run_id",
	AllocateFunction: "berry_allocate_automation_run_event_sequence",
	ScopeColumns:     []string{"workspace_id"},
}

func (table Table) valid() bool {
	return table.Name != "" && table.OwnerColumn != "" && table.AllocateFunction != ""
}

// Row is one event to append.
type Row struct {
	ID         uuid.UUID
	OwnerID    uuid.UUID
	Scope      []uuid.UUID
	Sequence   int64
	Type       string
	Payload    json.RawMessage
	Public     bool
	OccurredAt time.Time
}

// Entry is one replayed event.
type Entry struct {
	ID         uuid.UUID
	OwnerID    uuid.UUID
	Scope      []uuid.UUID
	Sequence   int64
	Type       string
	Payload    json.RawMessage
	OccurredAt time.Time
}

// Sequence allocates the next sequence number for the owner. It must run in
// the transaction that inserts the event: the row update serialises concurrent
// appenders and rolls back with a failed insert.
func Sequence(ctx context.Context, tx Querier, table Table, ownerID uuid.UUID) (int64, error) {
	if !table.valid() || ownerID == uuid.Nil {
		return 0, errors.New("ledger sequence parameters are invalid")
	}
	var sequence int64
	if err := tx.QueryRow(
		ctx,
		`SELECT `+table.AllocateFunction+`($1)`,
		ownerID,
	).Scan(&sequence); err != nil {
		return 0, fmt.Errorf("allocate %s sequence", table.Name)
	}
	return sequence, nil
}

// NextOccurredAt keeps replay-by-time ordering consistent with the sequence at
// PostgreSQL's microsecond timestamp precision: the returned instant is never
// earlier than the owner's latest event. Callers lock the owner row first so
// appenders are serialised.
func NextOccurredAt(
	ctx context.Context,
	tx Querier,
	table Table,
	ownerID uuid.UUID,
	requested time.Time,
) (time.Time, error) {
	if !table.valid() || ownerID == uuid.Nil {
		return time.Time{}, errors.New("ledger event time parameters are invalid")
	}
	var occurredAt time.Time
	if err := tx.QueryRow(
		ctx,
		`SELECT GREATEST(
		            $2::timestamptz,
		            COALESCE(MAX(occurred_at) + INTERVAL '1 microsecond', $2::timestamptz)
		        )
		   FROM `+table.Name+`
		  WHERE `+table.OwnerColumn+` = $1`,
		ownerID,
		requested.UTC(),
	).Scan(&occurredAt); err != nil {
		return time.Time{}, fmt.Errorf("allocate %s event time", table.Name)
	}
	return occurredAt.UTC(), nil
}

// Append inserts one event row. The payload must already be valid JSON and the
// row must carry exactly the table's scope columns.
func Append(ctx context.Context, tx Querier, table Table, row Row) error {
	if !table.valid() {
		return errors.New("ledger table is invalid")
	}
	if row.ID == uuid.Nil || row.OwnerID == uuid.Nil || row.Type == "" {
		return errors.New("ledger event requires an id, an owner and a type")
	}
	if row.Sequence < 0 {
		return errors.New("ledger event sequence is negative")
	}
	if !json.Valid(row.Payload) {
		return errors.New("ledger event payload is invalid")
	}
	if len(row.Scope) != len(table.ScopeColumns) {
		return fmt.Errorf(
			"ledger event for %s carries %d scope values, want %d",
			table.Name, len(row.Scope), len(table.ScopeColumns),
		)
	}
	columns := []string{"id", table.OwnerColumn}
	columns = append(columns, table.ScopeColumns...)
	columns = append(columns, "sequence", "event_type", "payload", "public", "occurred_at")
	arguments := []any{row.ID, row.OwnerID}
	for _, scope := range row.Scope {
		if scope == uuid.Nil {
			return errors.New("ledger event scope is missing")
		}
		arguments = append(arguments, scope)
	}
	arguments = append(arguments, row.Sequence, row.Type, string(row.Payload), row.Public, row.OccurredAt.UTC())
	placeholders := make([]string, 0, len(arguments))
	for index := range arguments {
		placeholder := fmt.Sprintf("$%d", index+1)
		// payload arrives as text and is cast so the driver never has to
		// guess the jsonb parameter type.
		if columns[index] == "payload" {
			placeholder += "::jsonb"
		}
		placeholders = append(placeholders, placeholder)
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO `+table.Name+` (`+strings.Join(columns, ", ")+`)
		 VALUES (`+strings.Join(placeholders, ", ")+`)`,
		arguments...,
	); err != nil {
		return fmt.Errorf("persist %s event: %w", table.Name, err)
	}
	return nil
}

// Replay returns the owner's public events after one sequence, oldest first,
// inside the retention window that starts at cutoff.
func Replay(
	ctx context.Context,
	querier Querier,
	table Table,
	ownerID uuid.UUID,
	afterSequence int64,
	cutoff time.Time,
	limit int,
) ([]Entry, error) {
	if !table.valid() || ownerID == uuid.Nil {
		return nil, errors.New("ledger replay parameters are invalid")
	}
	if limit < 1 {
		return nil, errors.New("ledger replay limit is invalid")
	}
	selected := []string{"e.id", "e." + table.OwnerColumn, "e.sequence", "e.event_type", "e.payload", "e.occurred_at"}
	for _, column := range table.ScopeColumns {
		selected = append(selected, "e."+column)
	}
	rows, err := querier.Query(
		ctx,
		`SELECT `+strings.Join(selected, ", ")+`
		   FROM `+table.Name+` AS e
		  WHERE e.`+table.OwnerColumn+` = $1
		    AND e.public
		    AND e.sequence > $2
		    AND e.occurred_at >= $3
		  ORDER BY e.sequence ASC
		  LIMIT $4`,
		ownerID,
		afterSequence,
		cutoff,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list %s events", table.Name)
	}
	defer rows.Close()
	result := make([]Entry, 0, limit)
	for rows.Next() {
		var (
			entry   Entry
			payload []byte
		)
		entry.Scope = make([]uuid.UUID, len(table.ScopeColumns))
		destinations := []any{
			&entry.ID, &entry.OwnerID, &entry.Sequence, &entry.Type, &payload, &entry.OccurredAt,
		}
		for index := range entry.Scope {
			destinations = append(destinations, &entry.Scope[index])
		}
		if err := rows.Scan(destinations...); err != nil {
			return nil, fmt.Errorf("scan %s event", table.Name)
		}
		entry.Payload = append(json.RawMessage(nil), payload...)
		entry.OccurredAt = entry.OccurredAt.UTC()
		result = append(result, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate %s events", table.Name)
	}
	return result, nil
}

// ResolveCursor validates that a public cursor belongs to this owner and is
// inside the retention window, returning the sequence to replay after.
func ResolveCursor(
	ctx context.Context,
	querier Querier,
	table Table,
	ownerID, eventID uuid.UUID,
	cutoff time.Time,
) (int64, error) {
	if !table.valid() || ownerID == uuid.Nil {
		return 0, errors.New("ledger cursor parameters are invalid")
	}
	var sequence int64
	err := querier.QueryRow(
		ctx,
		`SELECT sequence
		   FROM `+table.Name+`
		  WHERE id = $1 AND `+table.OwnerColumn+` = $2 AND public AND occurred_at >= $3`,
		eventID,
		ownerID,
		cutoff,
	).Scan(&sequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrCursorExpired
	}
	if err != nil {
		return 0, fmt.Errorf("resolve %s cursor", table.Name)
	}
	return sequence, nil
}
