package integrations

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/integrations/core"
)

// Audit statuses, mirroring the column constraint.
const (
	AuditStarted          = "started"
	AuditSucceeded        = "succeeded"
	AuditFailed           = "failed"
	AuditDenied           = "denied"
	AuditAwaitingApproval = "awaiting_approval"
)

// Approval outcomes, mirroring the column constraint.
const (
	ApprovalNotRequired = "not_required"
	ApprovalPending     = "pending"
	ApprovalApproved    = "approved"
	ApprovalRejected    = "rejected"
)

// summaryLimit bounds what a summary may carry into the audit table.
//
// Summaries are for a person scanning history, not a replay log. Truncating
// keeps an oversized provider payload — which may embed content, and has been
// known to embed a credential — from being copied wholesale into a row that
// operators read casually.
const summaryLimit = 2000

// AuditEntry opens an audit record before a call is attempted.
type AuditEntry struct {
	WorkspaceID  uuid.UUID
	ConnectionID *uuid.UUID
	AgentID      *uuid.UUID
	UserID       *uuid.UUID
	RunID        *uuid.UUID
	Provider     string
	Tool         string
	Effect       core.Effect
	InputSummary string
	Status       string
	Approval     string
}

// AuditResult closes an audit record once the call returns.
type AuditResult struct {
	Status        string
	Approval      string
	ResultSummary string
	ExternalIDs   []string
	ExternalURL   string
	ErrorCode     string
	ErrorMessage  string
}

// BeginAudit writes the record before the call happens.
//
// Written first, deliberately: a call that hangs, crashes the process, or is
// killed mid-flight still leaves evidence that it was attempted. An audit
// trail that only records completions cannot answer "what was running when
// this went wrong".
func (repository *Repository) BeginAudit(
	ctx context.Context,
	entry AuditEntry,
	now time.Time,
) (uuid.UUID, error) {
	status := entry.Status
	if status == "" {
		status = AuditStarted
	}
	approval := entry.Approval
	if approval == "" {
		approval = ApprovalNotRequired
	}

	var id uuid.UUID
	err := repository.Pool.QueryRow(
		ctx,
		`INSERT INTO integration_audit_events (
			workspace_id, connection_id, agent_id, user_id, run_id,
			provider, tool, effect, input_summary, status, approval_status, started_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		 RETURNING id`,
		entry.WorkspaceID, entry.ConnectionID, entry.AgentID, entry.UserID, entry.RunID,
		entry.Provider, entry.Tool, string(entry.Effect),
		nullIfEmpty(truncate(entry.InputSummary)), status, approval, now.UTC(),
	).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("begin audit: %w", err)
	}
	return id, nil
}

// CompleteAudit closes a record the call has finished with.
//
// The duration is computed from the stored start rather than passed in, so a
// caller cannot report a call as faster than it was, and the two columns the
// completion constraint ties together are always written as a pair.
func (repository *Repository) CompleteAudit(
	ctx context.Context,
	auditID uuid.UUID,
	result AuditResult,
	now time.Time,
) error {
	status := result.Status
	if status == "" {
		status = AuditSucceeded
	}
	externalIDs := result.ExternalIDs
	if externalIDs == nil {
		externalIDs = []string{}
	}

	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE integration_audit_events
		    SET status          = $2,
		        approval_status = COALESCE(NULLIF($3, ''), approval_status),
		        result_summary  = $4,
		        external_ids    = $5,
		        external_url    = $6,
		        error_code      = $7,
		        error_message   = $8,
		        completed_at    = $9,
		        duration_ms     = GREATEST(0, (EXTRACT(EPOCH FROM ($9 - started_at)) * 1000)::bigint)
		  WHERE id = $1`,
		auditID, status, result.Approval,
		nullIfEmpty(truncate(result.ResultSummary)), externalIDs,
		nullIfEmpty(result.ExternalURL),
		nullIfEmpty(result.ErrorCode), nullIfEmpty(truncate(result.ErrorMessage)),
		now.UTC(),
	)
	if err != nil {
		return fmt.Errorf("complete audit: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// AuditRecord is one row as read back for the activity view.
type AuditRecord struct {
	ID            uuid.UUID
	AgentID       *uuid.UUID
	UserID        *uuid.UUID
	RunID         *uuid.UUID
	Provider      string
	Tool          string
	Effect        core.Effect
	InputSummary  string
	ResultSummary string
	Status        string
	Approval      string
	ExternalIDs   []string
	ExternalURL   string
	ErrorCode     string
	StartedAt     time.Time
	CompletedAt   *time.Time
	DurationMS    *int64
}

// ListAudit returns recent integration activity for a workspace, newest first.
//
// Never selects error_message: the detail is kept for support, but the list a
// person browses does not need it, and provider errors are the likeliest place
// for a stray token to have been recorded.
func (repository *Repository) ListAudit(
	ctx context.Context,
	workspaceID uuid.UUID,
	limit int,
) ([]AuditRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT id, agent_id, user_id, run_id, provider, tool, effect,
		        coalesce(input_summary, ''), coalesce(result_summary, ''),
		        status, approval_status, external_ids, coalesce(external_url, ''),
		        coalesce(error_code, ''), started_at, completed_at, duration_ms
		   FROM integration_audit_events
		  WHERE workspace_id = $1
		  ORDER BY started_at DESC, id DESC
		  LIMIT $2`,
		workspaceID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	defer rows.Close()

	records := make([]AuditRecord, 0, limit)
	for rows.Next() {
		var (
			record AuditRecord
			effect string
		)
		if err := rows.Scan(
			&record.ID, &record.AgentID, &record.UserID, &record.RunID,
			&record.Provider, &record.Tool, &effect,
			&record.InputSummary, &record.ResultSummary,
			&record.Status, &record.Approval, &record.ExternalIDs, &record.ExternalURL,
			&record.ErrorCode, &record.StartedAt, &record.CompletedAt, &record.DurationMS,
		); err != nil {
			return nil, fmt.Errorf("scan audit: %w", err)
		}
		record.Effect = core.Effect(effect)
		records = append(records, record)
	}
	return records, rows.Err()
}

// truncate bounds a summary without splitting a multi-byte rune.
func truncate(value string) string {
	if len(value) <= summaryLimit {
		return value
	}
	runes := []rune(value)
	if len(runes) <= summaryLimit {
		return value
	}
	return string(runes[:summaryLimit]) + "…"
}
