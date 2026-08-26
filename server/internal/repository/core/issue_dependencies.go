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
	ID         uuid.UUID
	Identifier string
	Title      string
	// Status is the wire status of the referenced issue.
	Status string
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
