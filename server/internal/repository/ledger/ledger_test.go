package ledger

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// recorder captures the statement Append builds so the column list can be
// asserted without a database.
type recorder struct {
	sql  string
	args []any
}

func (record *recorder) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	record.sql, record.args = sql, args
	return pgconn.CommandTag{}, nil
}

func (*recorder) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("not used")
}

func (*recorder) QueryRow(context.Context, string, ...any) pgx.Row { return nil }

// Each table declares which scope columns a row must carry; a row that
// supplies the wrong number would either fail the NOT NULL constraint or, worse,
// land its ids in the wrong columns.
func TestAppendWritesEveryScopeColumnOfTheTable(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	record := &recorder{}
	row := Row{
		ID: uuid.New(), OwnerID: uuid.New(), Scope: []uuid.UUID{uuid.New(), uuid.New()},
		Sequence: 3, Type: "run.output.delta", Payload: json.RawMessage(`{"text":"x"}`),
		Public: true, OccurredAt: now,
	}
	if err := Append(context.Background(), record, Runs, row); err != nil {
		t.Fatalf("Append(runs) error = %v", err)
	}
	for _, column := range []string{"run_events", "run_id", "board_id", "issue_id", "sequence", "event_type", "payload", "public", "occurred_at"} {
		if !strings.Contains(record.sql, column) {
			t.Errorf("run_events insert lacks %q: %s", column, record.sql)
		}
	}
	if len(record.args) != 9 {
		t.Fatalf("run_events insert carries %d arguments, want 9", len(record.args))
	}

	row.Scope = row.Scope[:1]
	if err := Append(context.Background(), record, AutomationRuns, row); err != nil {
		t.Fatalf("Append(automation runs) error = %v", err)
	}
	if !strings.Contains(record.sql, "automation_run_events") || !strings.Contains(record.sql, "workspace_id") {
		t.Errorf("automation_run_events insert is wrong: %s", record.sql)
	}
	if len(record.args) != 8 {
		t.Fatalf("automation_run_events insert carries %d arguments, want 8", len(record.args))
	}

	row.Scope = nil
	if err := Append(context.Background(), record, AutomationRuns, row); err == nil {
		t.Fatal("Append accepted a row without its scope column")
	}
	row.Scope = []uuid.UUID{uuid.New()}
	row.Payload = json.RawMessage(`{not json`)
	if err := Append(context.Background(), record, AutomationRuns, row); err == nil {
		t.Fatal("Append accepted an invalid payload")
	}
}

// The three writer lanes encode different envelopes; the reader must recover
// the scope of every one, including the issue a comment names inside its
// payload rather than beside it.
func TestDecodeEnvelopeReadsEveryLane(t *testing.T) {
	t.Parallel()
	id, workspaceID, boardID, issueID, runID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	cases := []struct {
		name     string
		envelope map[string]any
		want     Event
	}{
		{
			name: "run lane names board, issue, run and sequence",
			envelope: map[string]any{
				"boardId": boardID, "issueId": issueID, "runId": runID, "sequence": 4,
				"payload": map[string]any{"startedAt": "x"},
			},
			want: Event{BoardID: boardID, IssueID: issueID, RunID: &runID},
		},
		{
			name: "collaboration lane names the workspace and the issue in the payload",
			envelope: map[string]any{
				"workspaceId": workspaceID, "aggregateType": "comment", "aggregateId": uuid.New(),
				"payload": map[string]any{"comment": map[string]any{"issueId": issueID}},
			},
			want: Event{WorkspaceID: workspaceID, IssueID: issueID},
		},
		{
			name: "approval lane names the issue at the top of the payload",
			envelope: map[string]any{
				"workspaceId": workspaceID, "aggregateType": "approval", "aggregateId": uuid.New(),
				"payload": map[string]any{"issueId": issueID, "approvalId": uuid.New()},
			},
			want: Event{WorkspaceID: workspaceID, IssueID: issueID},
		},
		{
			name: "board-less fact leaves every scope but the workspace empty",
			envelope: map[string]any{
				"workspaceId": workspaceID, "aggregateType": "goal", "aggregateId": uuid.New(),
				"payload": map[string]any{"goal": map[string]any{"id": uuid.New()}},
			},
			want: Event{WorkspaceID: workspaceID},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			testCase.envelope["id"] = id
			testCase.envelope["type"] = "any.topic"
			testCase.envelope["occurredAt"] = "2026-08-25T12:00:00.000001Z"
			encoded, err := json.Marshal(testCase.envelope)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			got, err := DecodeEnvelope(encoded)
			if err != nil {
				t.Fatalf("DecodeEnvelope() error = %v", err)
			}
			if got.ID != id || got.Type != "any.topic" {
				t.Fatalf("identity = %s %s", got.ID, got.Type)
			}
			if got.WorkspaceID != testCase.want.WorkspaceID || got.BoardID != testCase.want.BoardID || got.IssueID != testCase.want.IssueID {
				t.Fatalf("scope = workspace %s board %s issue %s, want %s %s %s",
					got.WorkspaceID, got.BoardID, got.IssueID,
					testCase.want.WorkspaceID, testCase.want.BoardID, testCase.want.IssueID)
			}
			if (got.RunID == nil) != (testCase.want.RunID == nil) {
				t.Fatalf("runId = %v, want %v", got.RunID, testCase.want.RunID)
			}
		})
	}
	if _, err := DecodeEnvelope([]byte(`{"id":"nope","type":"x","occurredAt":"2026-08-25T12:00:00Z","payload":{}}`)); err == nil {
		t.Fatal("DecodeEnvelope accepted a malformed id")
	}
	if _, err := DecodeEnvelope([]byte(`{"id":"` + id.String() + `","type":"x","occurredAt":"yesterday","payload":{}}`)); err == nil {
		t.Fatal("DecodeEnvelope accepted a malformed timestamp")
	}
}

// Only the two scope columns this package defines may reach the SQL text.
func TestOutboxReplayRefusesAnUnknownScope(t *testing.T) {
	t.Parallel()
	if _, err := ReplayOutbox(context.Background(), &recorder{}, OutboxScope("topic"), uuid.New(), []string{"x"}, nil, time.Time{}, 10); err == nil {
		t.Fatal("ReplayOutbox accepted an unknown scope column")
	}
	if _, err := ResolveOutboxCursor(context.Background(), &recorder{}, OutboxScope("payload"), uuid.New(), []string{"x"}, uuid.New(), time.Time{}); err == nil {
		t.Fatal("ResolveOutboxCursor accepted an unknown scope column")
	}
	if _, err := ReplayOutbox(context.Background(), &recorder{}, OutboxScopeBoard, uuid.New(), nil, nil, time.Time{}, 10); err == nil {
		t.Fatal("ReplayOutbox accepted an empty topic list")
	}
}

// A fact without a board must store NULL, not the nil uuid, or the board
// replay's partial index would match it.
func TestWriteOutboxStoresNullForABoardlessFact(t *testing.T) {
	t.Parallel()
	record := &recorder{}
	nilBoard := uuid.Nil
	event, err := WriteOutbox(context.Background(), record, OutboxEvent{
		ID: uuid.New(), Topic: "goal.created", AggregateType: "goal", AggregateID: uuid.New(),
		WorkspaceID: uuid.New(), BoardID: &nilBoard, OccurredAt: time.Now(),
	})
	if err != nil {
		t.Fatalf("WriteOutbox() error = %v", err)
	}
	if board, ok := record.args[5].(*uuid.UUID); !ok || board != nil {
		t.Fatalf("board_id argument = %#v, want a nil *uuid.UUID", record.args[5])
	}
	if event.BoardID != uuid.Nil || event.Type != "goal.created" {
		t.Fatalf("returned event = %#v", event)
	}
	if _, err := WriteOutbox(context.Background(), record, OutboxEvent{ID: uuid.New()}); err == nil {
		t.Fatal("WriteOutbox accepted an event without a workspace and topic")
	}
}
