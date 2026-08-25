package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

type issueAdmissionRow struct {
	ID           uuid.UUID
	BoardID      uuid.UUID
	BoardSlug    string
	Number       int32
	Title        string
	Description  *string
	AssigneeType *string
	AssigneeID   *uuid.UUID
	ActiveRunID  *uuid.UUID
}

// Admit atomically persists assignment, queued ledger, active-run pointer, and
// sequence-zero run.created before any OpenFang request is possible.
func (repository *Repository) Admit(
	ctx context.Context,
	params AdmitParams,
) (Run, error) {
	if repository == nil || repository.Pool == nil ||
		params.RunID == uuid.Nil || params.CreatedEventID == uuid.Nil ||
		params.RequestedBy == uuid.Nil || params.WorkspaceID == uuid.Nil ||
		params.IssueRef == "" ||
		params.CreatedAt.IsZero() {
		return Run{}, errors.New("run admission parameters are invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Run{}, errors.New("begin run admission")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	issue, err := lockIssueForAdmission(
		ctx,
		tx,
		params.IssueRef,
		params.WorkspaceID,
	)
	if err != nil {
		return Run{}, err
	}
	if issue.ActiveRunID != nil {
		return Run{}, &ActiveRunError{RunID: *issue.ActiveRunID}
	}

	agentID := uuid.Nil
	if params.AgentID != nil {
		agentID = *params.AgentID
	} else if issue.AssigneeType != nil && *issue.AssigneeType == "agent" &&
		issue.AssigneeID != nil {
		agentID = *issue.AssigneeID
	}
	if agentID == uuid.Nil {
		return Run{}, ErrIssueHasNoAgent
	}

	var (
		upstreamAgentID uuid.UUID
		agentBoardID    *uuid.UUID
	)
	if err := tx.QueryRow(
		ctx,
		`SELECT openfang_agent_id, board_id
		   FROM agents
		  WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
		  FOR KEY SHARE`,
		agentID,
		params.WorkspaceID,
	).Scan(&upstreamAgentID, &agentBoardID); errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrAgentNotFound
	} else if err != nil {
		return Run{}, errors.New("validate run agent")
	}
	if agentBoardID != nil && *agentBoardID != issue.BoardID {
		return Run{}, ErrAgentNotFound
	}

	assignmentChanged := issue.AssigneeType == nil || *issue.AssigneeType != "agent" ||
		issue.AssigneeID == nil || *issue.AssigneeID != agentID
	if params.AgentID != nil && assignmentChanged {
		if params.AssignmentID == uuid.Nil {
			return Run{}, errors.New("run assignment ID is required")
		}
		if _, err := tx.Exec(
			ctx,
			`UPDATE issues
			    SET assignee_type = 'agent',
			        assignee_id = $2,
			        updated_at = $3
			  WHERE id = $1`,
			issue.ID,
			agentID,
			params.CreatedAt,
		); err != nil {
			return Run{}, classifyAdmissionWrite("assign run agent", err)
		}
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO assignments (
				id, issue_id, assignee_type, assignee_id, assigned_by, created_at
			 ) VALUES ($1, $2, 'agent', $3, $4, $5)`,
			params.AssignmentID,
			issue.ID,
			agentID,
			params.RequestedBy,
			params.CreatedAt,
		); err != nil {
			return Run{}, classifyAdmissionWrite("record run assignment", err)
		}
	}

	origin, err := json.Marshal(map[string]any{
		"actorType": "user",
		"actorId":   params.RequestedBy,
		"requestId": params.RequestID,
	})
	if err != nil {
		return Run{}, errors.New("encode run origin")
	}
	run := Run{
		ID:              params.RunID,
		IssueID:         issue.ID,
		BoardID:         issue.BoardID,
		AgentID:         agentID,
		UpstreamAgentID: upstreamAgentID,
		Status:          StatusQueued,
		Sequence:        0,
		Output:          "",
		DispatchState:   DispatchPending,
		CreatedAt:       params.CreatedAt.UTC(),
		UpdatedAt:       params.CreatedAt.UTC(),
	}
	if params.RequestID != "" {
		run.RequestID = &params.RequestID
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO runs (
			id, issue_id, board_id, agent_id, status, sequence,
			upstream_agent_id, origin, dispatch_state, dispatch_version,
			instructions, output, requested_by, request_id, traceparent,
			created_at, updated_at
		 ) VALUES (
			$1, $2, $3, $4, 'queued', 0,
			$5, $6::jsonb, 'pending', 0,
			$7, '', $8, $9, $10, $11, $11
		 )`,
		run.ID,
		run.IssueID,
		run.BoardID,
		run.AgentID,
		run.UpstreamAgentID.String(),
		string(origin),
		params.Instructions,
		params.RequestedBy,
		nullableString(params.RequestID),
		nullableString(params.TraceParent),
		run.CreatedAt,
	); err != nil {
		return Run{}, classifyAdmissionWrite("insert queued run", err)
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE issues
		    SET active_run_id = $2, updated_at = $3
		  WHERE id = $1 AND active_run_id IS NULL`,
		run.IssueID,
		run.ID,
		run.CreatedAt,
	); err != nil {
		return Run{}, classifyAdmissionWrite("set issue active run", err)
	}

	payload, err := lifecyclePayload(run)
	if err != nil {
		return Run{}, err
	}
	sequence := int64(0)
	runID := run.ID
	event := Event{
		ID:         params.CreatedEventID,
		Type:       "run.created",
		OccurredAt: run.CreatedAt,
		BoardID:    run.BoardID,
		IssueID:    run.IssueID,
		RunID:      &runID,
		Sequence:   &sequence,
		Payload:    payload,
	}
	if err := insertPublicEvent(ctx, tx, event); err != nil {
		return Run{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, errors.New("commit run admission")
	}
	return run, nil
}

func lockIssueForAdmission(
	ctx context.Context,
	tx pgx.Tx,
	reference string,
	workspaceID uuid.UUID,
) (issueAdmissionRow, error) {
	where := "i.id = $1"
	var argument any
	if id, err := core.ParseUUID(reference); err == nil {
		argument = id
	} else {
		slug, number, ok := splitIssueReference(reference)
		if !ok {
			return issueAdmissionRow{}, ErrNotFound
		}
		where = "lower(b.slug) = lower($1) AND i.number = $2"
		argument = slug
		var result issueAdmissionRow
		err := tx.QueryRow(
			ctx,
			`SELECT i.id, i.board_id, b.slug, i.number, i.title, i.description,
			        i.assignee_type::text, i.assignee_id, i.active_run_id
			   FROM issues AS i
			   JOIN boards AS b ON b.id = i.board_id
			  WHERE `+where+` AND b.workspace_id = $3
			    AND i.deleted_at IS NULL
			  FOR UPDATE OF i`,
			argument,
			number,
			workspaceID,
		).Scan(
			&result.ID,
			&result.BoardID,
			&result.BoardSlug,
			&result.Number,
			&result.Title,
			&result.Description,
			&result.AssigneeType,
			&result.AssigneeID,
			&result.ActiveRunID,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return issueAdmissionRow{}, ErrNotFound
		}
		if err != nil {
			return issueAdmissionRow{}, errors.New("lock run issue")
		}
		return result, nil
	}

	var result issueAdmissionRow
	err := tx.QueryRow(
		ctx,
		`SELECT i.id, i.board_id, b.slug, i.number, i.title, i.description,
		        i.assignee_type::text, i.assignee_id, i.active_run_id
		   FROM issues AS i
		   JOIN boards AS b ON b.id = i.board_id
		  WHERE `+where+` AND b.workspace_id = $2
		    AND i.deleted_at IS NULL
		  FOR UPDATE OF i`,
		argument,
		workspaceID,
	).Scan(
		&result.ID,
		&result.BoardID,
		&result.BoardSlug,
		&result.Number,
		&result.Title,
		&result.Description,
		&result.AssigneeType,
		&result.AssigneeID,
		&result.ActiveRunID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return issueAdmissionRow{}, ErrNotFound
	}
	if err != nil {
		return issueAdmissionRow{}, errors.New("lock run issue")
	}
	return result, nil
}

func classifyAdmissionWrite(operation string, err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrAgentNotFound
		case "23505":
			if strings.Contains(postgresError.ConstraintName, "active") {
				return ErrConflict
			}
			return ErrConflict
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
