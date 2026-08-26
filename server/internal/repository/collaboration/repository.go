package collaboration

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/issueid"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Repository is the narrow, membership-aware persistence boundary for P2
// collaboration resources.
type Repository struct {
	Pool *pgxpool.Pool
}

// New validates the authoritative PostgreSQL dependency.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("collaboration repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

type database interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type issueAccess struct {
	IssueID     uuid.UUID
	WorkspaceID uuid.UUID
	BoardID     uuid.UUID
	Role        identity.Role
}

type commentAccess struct {
	CommentID   uuid.UUID
	IssueID     uuid.UUID
	WorkspaceID uuid.UUID
	BoardID     uuid.UUID
	Role        identity.Role
}

func authorizeIssueReference(
	ctx context.Context,
	queryer database,
	userID uuid.UUID,
	reference string,
	permission identity.Permission,
	lock bool,
) (issueAccess, error) {
	var (
		condition string
		arguments []any
	)
	if id, err := core.ParseUUID(reference); err == nil {
		condition = "issue.id = $2"
		arguments = []any{userID, id}
	} else {
		prefix, number, ok := issueid.Parse(reference)
		if !ok {
			return issueAccess{}, ErrNotFound
		}
		condition = "lower(workspace.settings->>'issuePrefix') = lower($2) AND issue.number = $3"
		arguments = []any{userID, prefix, number}
	}
	statement := `SELECT issue.id, board.workspace_id, board.id, membership.role::text
		FROM issues AS issue
		JOIN boards AS board ON board.id = issue.board_id
		 AND issue.deleted_at IS NULL
		JOIN workspaces AS workspace
		  ON workspace.id = board.workspace_id
		 AND workspace.deleted_at IS NULL
		JOIN workspace_memberships AS membership
		  ON membership.workspace_id = workspace.id
		 AND membership.user_id = $1
		WHERE ` + condition
	if lock {
		statement += ` FOR KEY SHARE OF issue, board, workspace, membership`
	}
	var (
		access issueAccess
		role   string
	)
	if err := queryer.QueryRow(ctx, statement, arguments...).Scan(
		&access.IssueID,
		&access.WorkspaceID,
		&access.BoardID,
		&role,
	); err != nil {
		return issueAccess{}, classifyReadError("authorize issue collaboration", err)
	}
	access.Role = identity.Role(role)
	if !access.Role.Allows(permission) {
		return issueAccess{}, ErrForbidden
	}
	return access, nil
}

func authorizeIssueID(
	ctx context.Context,
	queryer database,
	userID, issueID uuid.UUID,
	permission identity.Permission,
	lock bool,
) (issueAccess, error) {
	return authorizeIssueReference(
		ctx,
		queryer,
		userID,
		issueID.String(),
		permission,
		lock,
	)
}

func authorizeComment(
	ctx context.Context,
	queryer database,
	userID, commentID uuid.UUID,
	permission identity.Permission,
	lock bool,
) (commentAccess, error) {
	statement := `SELECT comment.id, comment.issue_id, board.workspace_id, board.id,
	                      membership.role::text
		FROM comments AS comment
		JOIN issues AS issue ON issue.id = comment.issue_id
		JOIN boards AS board ON board.id = issue.board_id
		JOIN workspaces AS workspace
		  ON workspace.id = board.workspace_id
		 AND workspace.deleted_at IS NULL
		JOIN workspace_memberships AS membership
		  ON membership.workspace_id = workspace.id
		 AND membership.user_id = $1
		WHERE comment.id = $2`
	if lock {
		statement += ` FOR KEY SHARE OF comment, issue, board, workspace, membership`
	}
	var (
		access commentAccess
		role   string
	)
	if err := queryer.QueryRow(ctx, statement, userID, commentID).Scan(
		&access.CommentID,
		&access.IssueID,
		&access.WorkspaceID,
		&access.BoardID,
		&role,
	); err != nil {
		return commentAccess{}, classifyReadError("authorize comment collaboration", err)
	}
	access.Role = identity.Role(role)
	if !access.Role.Allows(permission) {
		return commentAccess{}, ErrForbidden
	}
	return access, nil
}

func classifyReadError(operation string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return fmt.Errorf("%s: %w", operation, err)
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
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func validTargetKind(kind TargetKind) bool {
	return kind == TargetIssue || kind == TargetComment
}

func normalizedIssueReference(reference string) string {
	return strings.TrimSpace(reference)
}
