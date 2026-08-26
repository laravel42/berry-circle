package core

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// IssueDependencyRef is one end of a dependency edge as a reader sees it.
type IssueDependencyRef struct {
	ID         uuid.UUID `json:"id"`
	Identifier string    `json:"identifier"`
	Title      string    `json:"title"`
	// Status is the wire status of the referenced issue.
	Status string `json:"status"`
}

// IssueDependencies is everything an issue waits on and everything waiting on
// it, both oldest edge first.
type IssueDependencies struct {
	DependsOn []IssueDependencyRef
	Blocks    []IssueDependencyRef
}

// AddIssueDependencyParams is one "IssueID waits on DependsOnIssueID" edge.
type AddIssueDependencyParams struct {
	WorkspaceID      uuid.UUID
	IssueID          uuid.UUID
	DependsOnIssueID uuid.UUID
	CreatedBy        uuid.UUID
	CreatedAt        time.Time
}

// AddIssueDependency records one edge. The database trigger refuses a cycle
// (ErrDependencyCycle) and an edge that crosses workspaces (ErrNotFound); an
// edge that already exists is not an error, because asking twice for the
// same ordering is the same request.
func (repository *Repository) AddIssueDependency(
	ctx context.Context,
	params AddIssueDependencyParams,
) error {
	return InsertIssueDependency(ctx, repository.Pool, params)
}

// InsertIssueDependency is AddIssueDependency inside a caller's transaction,
// which is how a plan compile writes every edge beside the issues it created.
func InsertIssueDependency(
	ctx context.Context,
	execer interface {
		Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	},
	params AddIssueDependencyParams,
) error {
	if params.WorkspaceID == uuid.Nil || params.IssueID == uuid.Nil || params.DependsOnIssueID == uuid.Nil {
		return errors.New("issue dependency parameters are invalid")
	}
	if params.IssueID == params.DependsOnIssueID {
		return ErrDependencyCycle
	}
	var createdBy *uuid.UUID
	if params.CreatedBy != uuid.Nil {
		createdBy = &params.CreatedBy
	}
	createdAt := params.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now()
	}
	if _, err := execer.Exec(
		ctx,
		`INSERT INTO issue_dependencies (
		    workspace_id, issue_id, depends_on_issue_id, kind, created_by, created_at
		 ) VALUES ($1, $2, $3, 'blocks', $4, $5)
		 ON CONFLICT (issue_id, depends_on_issue_id) DO NOTHING`,
		params.WorkspaceID,
		params.IssueID,
		params.DependsOnIssueID,
		createdBy,
		createdAt.UTC(),
	); err != nil {
		return classifyDependencyWrite("add issue dependency", err)
	}
	return nil
}

// RemoveIssueDependency deletes one edge. ErrNotFound when it did not exist.
func (repository *Repository) RemoveIssueDependency(
	ctx context.Context,
	issueID, dependsOnIssueID uuid.UUID,
) error {
	if issueID == uuid.Nil || dependsOnIssueID == uuid.Nil {
		return errors.New("issue dependency parameters are invalid")
	}
	tag, err := repository.Pool.Exec(
		ctx,
		`DELETE FROM issue_dependencies WHERE issue_id = $1 AND depends_on_issue_id = $2`,
		issueID,
		dependsOnIssueID,
	)
	if err != nil {
		return fmt.Errorf("remove issue dependency: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ListIssueDependencies reads both directions for one issue. Deleted issues
// on the other end are hidden, the same way every issue read hides them.
func (repository *Repository) ListIssueDependencies(
	ctx context.Context,
	issueID uuid.UUID,
) (IssueDependencies, error) {
	if issueID == uuid.Nil {
		return IssueDependencies{}, errors.New("issue dependency issue is required")
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT edge.issue_id, edge.depends_on_issue_id,
		        other.id, berry_issue_identifier(board.workspace_id, other.number),
		        other.title, other.status::text
		   FROM issue_dependencies AS edge
		   JOIN issues AS other
		     ON other.id = CASE WHEN edge.issue_id = $1 THEN edge.depends_on_issue_id ELSE edge.issue_id END
		    AND other.deleted_at IS NULL
		   JOIN boards AS board ON board.id = other.board_id
		  WHERE edge.issue_id = $1 OR edge.depends_on_issue_id = $1
		  ORDER BY edge.created_at ASC, other.id ASC`,
		issueID,
	)
	if err != nil {
		return IssueDependencies{}, fmt.Errorf("list issue dependencies: %w", err)
	}
	defer rows.Close()
	result := IssueDependencies{
		DependsOn: []IssueDependencyRef{},
		Blocks:    []IssueDependencyRef{},
	}
	for rows.Next() {
		var (
			dependent uuid.UUID
			blocker   uuid.UUID
			ref       IssueDependencyRef
			status    string
		)
		if err := rows.Scan(&dependent, &blocker, &ref.ID, &ref.Identifier, &ref.Title, &status); err != nil {
			return IssueDependencies{}, errors.New("scan issue dependency")
		}
		ref.Status = dbStatusToAPI(status)
		if dependent == issueID {
			result.DependsOn = append(result.DependsOn, ref)
		} else {
			result.Blocks = append(result.Blocks, ref)
		}
	}
	if err := rows.Err(); err != nil {
		return IssueDependencies{}, errors.New("iterate issue dependencies")
	}
	return result, nil
}

// HasOpenBlockers reports whether any issue this one depends on is still
// open. Done and cancelled blockers no longer block; deleted ones never do.
func HasOpenBlockers(
	ctx context.Context,
	queryer interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	},
	issueID uuid.UUID,
) (bool, error) {
	var open bool
	if err := queryer.QueryRow(
		ctx,
		`SELECT EXISTS (
		    SELECT 1
		      FROM issue_dependencies AS edge
		      JOIN issues AS blocker ON blocker.id = edge.depends_on_issue_id
		     WHERE edge.issue_id = $1
		       AND blocker.deleted_at IS NULL
		       AND blocker.status NOT IN ('done', 'cancelled')
		)`,
		issueID,
	).Scan(&open); err != nil {
		return false, errors.New("check issue blockers")
	}
	return open, nil
}

// classifyDependencyWrite is local to dependency edges: only there does a
// check violation mean "cycle" (the trigger's own error), while a foreign key
// violation covers both an unknown issue and a cross-workspace edge.
func classifyDependencyWrite(operation string, err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23514":
			return ErrDependencyCycle
		case "23503":
			return ErrNotFound
		case "23505", "23P01":
			return ErrConflict
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}

// DependencyRelease is what releasing a blocker's dependents produced.
type DependencyRelease struct {
	// Released holds the issue.updated facts of every dependent that moved
	// from blocked to todo, for the caller to publish after commit.
	Released []IssueMutationEvent
	// Gated names dependents an approval gate refused to release; they stay
	// blocked until the approval resolves, which releases them itself.
	Gated []uuid.UUID
}

// ReleaseDependents moves every issue that waited only on blockerID from
// blocked to todo, once none of its blockers is still open. Each dependent is
// its own transaction so one refusal cannot roll back another's release, and
// each moves under a row lock so a person's concurrent edit is honoured: a
// dependent someone already moved elsewhere is left where they put it.
//
// The 010 and 020 triggers still fire: a dependent whose start needs an
// approval is reported as gated rather than forced past the gate.
func (repository *Repository) ReleaseDependents(
	ctx context.Context,
	blockerID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) (DependencyRelease, error) {
	if blockerID == uuid.Nil {
		return DependencyRelease{}, errors.New("dependency release needs a blocker")
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT edge.issue_id FROM issue_dependencies AS edge
		  WHERE edge.depends_on_issue_id = $1
		  ORDER BY edge.created_at ASC, edge.issue_id ASC`,
		blockerID,
	)
	if err != nil {
		return DependencyRelease{}, fmt.Errorf("list dependents: %w", err)
	}
	var dependents []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return DependencyRelease{}, errors.New("scan dependent")
		}
		dependents = append(dependents, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return DependencyRelease{}, errors.New("iterate dependents")
	}
	var result DependencyRelease
	for _, dependent := range dependents {
		events, err := repository.releaseDependent(ctx, dependent, now, newID)
		if errors.Is(err, ErrApprovalRequired) {
			result.Gated = append(result.Gated, dependent)
			continue
		}
		if err != nil {
			return result, err
		}
		result.Released = append(result.Released, events...)
	}
	return result, nil
}

func (repository *Repository) releaseDependent(
	ctx context.Context,
	issueID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) ([]IssueMutationEvent, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin dependency release: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	var status string
	if err := tx.QueryRow(
		ctx,
		`SELECT status::text FROM issues WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
		issueID,
	).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("lock dependent: %w", err)
	}
	if status != "blocked" {
		return nil, nil
	}
	open, err := HasOpenBlockers(ctx, tx, issueID)
	if err != nil || open {
		return nil, err
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE issues SET status = 'todo', updated_at = $2 WHERE id = $1`,
		issueID, now.UTC(),
	); err != nil {
		return nil, classifyWriteError("release dependent", err)
	}
	events, err := RecordIssueEvents(ctx, tx, IssueEventParams{
		IssueID:        issueID,
		Kind:           IssueEventUpdated,
		ChangedFields:  []string{"status"},
		PreviousStatus: "blocked",
		OccurredAt:     now,
		NewID:          newID,
	})
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit dependency release: %w", err)
	}
	return events, nil
}
