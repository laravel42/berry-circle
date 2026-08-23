package identity

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MembershipRole resolves active membership and is the shared HTTP/realtime
// workspace-authorization seam.
func (repository *Repository) MembershipRole(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
) (Role, error) {
	var role string
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT m.role::text
		   FROM workspace_memberships AS m
		   JOIN workspaces AS w ON w.id = m.workspace_id
		  WHERE m.workspace_id = $1
		    AND m.user_id = $2
		    AND w.deleted_at IS NULL`,
		workspaceID,
		userID,
	).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", errors.New("resolve workspace membership")
	}
	return Role(role), nil
}

// WorkspaceMemberEmailExists prevents redundant invitations without exposing
// membership details to callers outside the already-authorized service path.
func (repository *Repository) WorkspaceMemberEmailExists(
	ctx context.Context,
	workspaceID uuid.UUID,
	email string,
) (bool, error) {
	var exists bool
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT EXISTS (
			SELECT 1
			  FROM workspace_memberships AS m
			  JOIN users AS u ON u.id = m.user_id
			 WHERE m.workspace_id = $1 AND lower(u.email) = lower($2)
		)`,
		workspaceID,
		email,
	).Scan(&exists); err != nil {
		return false, errors.New("check workspace member email")
	}
	return exists, nil
}

const membershipProjection = `
	m.workspace_id, m.user_id, m.role::text,
	u.email, u.name, u.avatar_url, m.joined_at, m.updated_at`

// ListMembers returns a stable name/id page after authorization.
func (repository *Repository) ListMembers(
	ctx context.Context,
	workspaceID uuid.UUID,
	after *NameCursor,
	limit int,
) ([]Membership, error) {
	if limit < 1 {
		return nil, errors.New("list members: invalid limit")
	}
	afterEnabled := after != nil
	var afterName any
	var afterID any
	if after != nil {
		afterName = after.Name
		afterID = after.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+membershipProjection+`
		   FROM workspace_memberships AS m
		   JOIN users AS u ON u.id = m.user_id
		  WHERE m.workspace_id = $1
		    AND (NOT $2::boolean OR
		        (lower(u.name), u.id) > (lower($3::text), $4::uuid))
		  ORDER BY lower(u.name) ASC, u.id ASC
		  LIMIT $5`,
		workspaceID,
		afterEnabled,
		afterName,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list workspace members")
	}
	defer rows.Close()
	result := make([]Membership, 0, limit)
	for rows.Next() {
		member, err := scanMembership(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, member)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate workspace members")
	}
	return result, nil
}

// UpdateMemberRole applies the matrix under row locks and protects the final
// owner against concurrent demotions.
func (repository *Repository) UpdateMemberRole(
	ctx context.Context,
	workspaceID, actorID, targetID uuid.UUID,
	next Role,
) (Membership, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Membership{}, errors.New("begin member role update")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	roles, err := lockMembershipRoles(ctx, tx, workspaceID, actorID, targetID)
	if err != nil {
		return Membership{}, err
	}
	actorRole, actorOK := roles[actorID]
	targetRole, targetOK := roles[targetID]
	if !actorOK {
		return Membership{}, ErrNotFound
	}
	if !targetOK {
		return Membership{}, ErrNotFound
	}
	if !actorRole.Allows(PermissionMembersManage) {
		return Membership{}, ErrForbidden
	}
	if actorRole != RoleOwner &&
		(targetRole == RoleOwner || targetRole == RoleAdmin ||
			next == RoleOwner || next == RoleAdmin) {
		return Membership{}, ErrForbidden
	}
	if targetRole == RoleOwner && next != RoleOwner {
		owners, err := lockOwners(ctx, tx, workspaceID)
		if err != nil {
			return Membership{}, err
		}
		if owners < 2 {
			return Membership{}, ErrLastOwner
		}
	}
	member, err := scanMembership(tx.QueryRow(
		ctx,
		`UPDATE workspace_memberships AS m
		    SET role = $3
		   FROM users AS u
		  WHERE m.workspace_id = $1
		    AND m.user_id = $2
		    AND u.id = m.user_id
		  RETURNING `+membershipProjection,
		workspaceID,
		targetID,
		string(next),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Membership{}, ErrNotFound
	}
	if err != nil {
		return Membership{}, errors.New("update member role")
	}
	if err := tx.Commit(ctx); err != nil {
		return Membership{}, errors.New("commit member role update")
	}
	return member, nil
}

// RemoveMember applies the same role matrix and owner invariant as role changes.
func (repository *Repository) RemoveMember(
	ctx context.Context,
	workspaceID, actorID, targetID uuid.UUID,
) error {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("begin member removal")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	roles, err := lockMembershipRoles(ctx, tx, workspaceID, actorID, targetID)
	if err != nil {
		return err
	}
	actorRole, actorOK := roles[actorID]
	targetRole, targetOK := roles[targetID]
	if !actorOK || !targetOK {
		return ErrNotFound
	}
	if !actorRole.Allows(PermissionMembersManage) {
		return ErrForbidden
	}
	if actorRole != RoleOwner && (targetRole == RoleOwner || targetRole == RoleAdmin) {
		return ErrForbidden
	}
	if targetRole == RoleOwner {
		owners, err := lockOwners(ctx, tx, workspaceID)
		if err != nil {
			return err
		}
		if owners < 2 {
			return ErrLastOwner
		}
	}
	tag, err := tx.Exec(
		ctx,
		`DELETE FROM workspace_memberships
		  WHERE workspace_id = $1 AND user_id = $2`,
		workspaceID,
		targetID,
	)
	if err != nil {
		return errors.New("remove workspace member")
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE users SET last_workspace_id = NULL
		  WHERE id = $1 AND last_workspace_id = $2`,
		targetID,
		workspaceID,
	); err != nil {
		return errors.New("clear removed member workspace")
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit member removal")
	}
	return nil
}

func lockMembershipRoles(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID, actorID, targetID uuid.UUID,
) (map[uuid.UUID]Role, error) {
	rows, err := tx.Query(
		ctx,
		`SELECT user_id, role::text
		   FROM workspace_memberships
		  WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])
		  FOR UPDATE`,
		workspaceID,
		[]uuid.UUID{actorID, targetID},
	)
	if err != nil {
		return nil, errors.New("lock workspace memberships")
	}
	defer rows.Close()
	result := make(map[uuid.UUID]Role, 2)
	for rows.Next() {
		var (
			userID uuid.UUID
			role   string
		)
		if err := rows.Scan(&userID, &role); err != nil {
			return nil, errors.New("scan locked workspace membership")
		}
		result[userID] = Role(role)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate locked workspace memberships")
	}
	return result, nil
}

func lockOwners(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID) (int, error) {
	rows, err := tx.Query(
		ctx,
		`SELECT user_id
		   FROM workspace_memberships
		  WHERE workspace_id = $1 AND role = 'owner'
		  FOR UPDATE`,
		workspaceID,
	)
	if err != nil {
		return 0, errors.New("lock workspace owners")
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, errors.New("iterate workspace owners")
	}
	return count, nil
}

func scanMembership(row scanner) (Membership, error) {
	var (
		member Membership
		role   string
	)
	if err := row.Scan(
		&member.WorkspaceID,
		&member.UserID,
		&role,
		&member.Email,
		&member.Name,
		&member.AvatarURL,
		&member.JoinedAt,
		&member.UpdatedAt,
	); err != nil {
		return Membership{}, err
	}
	member.Role = Role(role)
	return member, nil
}
