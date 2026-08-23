package identity

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
)

func TestPostgresWorkspaceBoundaryAndPersonalTokenLifecycle(t *testing.T) {
	databaseURL := os.Getenv("BERRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BERRY_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open BERRY_TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping BERRY_TEST_DATABASE_URL: %v", err)
	}
	now := time.Date(2026, time.August, 22, 13, 0, 0, 0, time.UTC)
	ownerID, viewerID, outsiderID := uuid.New(), uuid.New(), uuid.New()
	workspaceID := uuid.New()
	boardID := uuid.New()
	userIDs := []uuid.UUID{ownerID, viewerID, outsiderID}
	t.Cleanup(func() {
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM personal_api_tokens WHERE user_id = ANY($1::uuid[])`,
			userIDs,
		)
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM boards WHERE id = $1`,
			boardID,
		)
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM workspaces WHERE id = $1`,
			workspaceID,
		)
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM users WHERE id = ANY($1::uuid[])`,
			userIDs,
		)
	})
	for index, userID := range userIDs {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO users (id, email, name, role, created_at, updated_at)
			 VALUES ($1, $2, $3, 'member', $4, $4)`,
			userID,
			fmt.Sprintf("%s@berry.test", userID),
			fmt.Sprintf("Identity Test %d", index),
			now,
		); err != nil {
			t.Fatalf("seed user %d: %v", index, err)
		}
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspaces (
		    id, name, slug, created_by, created_at, updated_at
		 ) VALUES ($1, 'Identity Test', $2, $3, $4, $4)`,
		workspaceID,
		"identity-"+workspaceID.String()[:8],
		ownerID,
		now,
	); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspace_memberships (
		    workspace_id, user_id, role, joined_at, updated_at
		 ) VALUES
		    ($1, $2, 'owner', $4, $4),
		    ($1, $3, 'viewer', $4, $4)`,
		workspaceID,
		ownerID,
		viewerID,
		now,
	); err != nil {
		t.Fatalf("seed memberships: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO boards (
		    id, workspace_id, name, slug, columns, created_by, created_at, updated_at
		 ) VALUES ($1, $2, 'Identity Board', $3, '[]'::jsonb, $4, $5, $5)`,
		boardID,
		workspaceID,
		"id-"+boardID.String()[:8],
		ownerID,
		now,
	); err != nil {
		t.Fatalf("seed workspace board: %v", err)
	}

	service, err := NewService(ServiceOptions{
		Pool:   pool,
		Now:    func() time.Time { return now },
		NewID:  uuid.New,
		Random: bytes.NewReader(bytes.Repeat([]byte{0x61}, 256)),
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	if _, err := service.GetWorkspace(ctx, viewerID, workspaceID); err != nil {
		t.Fatalf("viewer GetWorkspace() error = %v", err)
	}
	if _, err := service.GetWorkspace(ctx, outsiderID, workspaceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider GetWorkspace() error = %v, want ErrNotFound", err)
	}
	if scope, err := service.AuthorizeBoard(
		ctx,
		viewerID,
		boardID,
		PermissionProductRead,
	); err != nil || scope.WorkspaceID != workspaceID {
		t.Fatalf("viewer AuthorizeBoard(read) scope=%#v error=%v", scope, err)
	}
	if _, err := service.AuthorizeBoard(
		ctx,
		viewerID,
		boardID,
		PermissionProductWrite,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer AuthorizeBoard(write) error = %v, want ErrForbidden", err)
	}
	if _, err := service.AuthorizeBoard(
		ctx,
		outsiderID,
		boardID,
		PermissionProductRead,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider AuthorizeBoard() error = %v, want ErrNotFound", err)
	}
	if _, err := service.UpdateWorkspace(
		ctx,
		viewerID,
		workspaceID,
		WorkspacePatch{Name: pointer("Forbidden")},
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer UpdateWorkspace() error = %v, want ErrForbidden", err)
	}
	if _, err := service.UpdateMemberRole(
		ctx,
		outsiderID,
		workspaceID,
		viewerID,
		RoleMember,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider UpdateMemberRole() error = %v, want ErrNotFound", err)
	}
	if _, err := service.UpdateMemberRole(
		ctx,
		viewerID,
		workspaceID,
		viewerID,
		RoleMember,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer UpdateMemberRole() error = %v, want ErrForbidden", err)
	}
	if _, err := service.UpdateMemberRole(
		ctx,
		ownerID,
		workspaceID,
		ownerID,
		RoleMember,
	); !errors.Is(err, ErrLastOwner) {
		t.Fatalf("last owner demotion error = %v, want ErrLastOwner", err)
	}
	if _, err := service.CreateInvitation(
		ctx,
		ownerID,
		workspaceID,
		fmt.Sprintf("%s@berry.test", viewerID),
		RoleMember,
		now.Add(24*time.Hour),
		"identity-invite-member-key",
		sha256.Sum256([]byte("existing-member-invite")),
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("invite existing member error = %v, want ErrConflict", err)
	}

	fingerprint := sha256.Sum256([]byte("identity-token-request"))
	issue, err := service.CreatePersonalToken(
		ctx,
		ownerID,
		"integration",
		nil,
		"identity-token-idempotency-key",
		fingerprint,
	)
	if err != nil {
		t.Fatalf("CreatePersonalToken() error = %v", err)
	}
	if issue.Secret == "" {
		t.Fatal("new token response omitted one-time secret")
	}
	var (
		publicID   string
		secretHash []byte
	)
	if err := pool.QueryRow(
		ctx,
		`SELECT public_id, secret_hash
		   FROM personal_api_tokens
		  WHERE id = $1`,
		issue.Token.ID,
	).Scan(&publicID, &secretHash); err != nil {
		t.Fatalf("read stored token: %v", err)
	}
	_, secret, err := coreauth.ParsePersonalToken(issue.Secret)
	if err != nil {
		t.Fatalf("ParsePersonalToken() error = %v", err)
	}
	expectedHash := sha256.Sum256([]byte(secret))
	if len(secretHash) != sha256.Size || !bytes.Equal(secretHash, expectedHash[:]) {
		t.Fatalf("stored personal token digest length=%d or value mismatch", len(secretHash))
	}
	if !stringsHasPublicID(issue.Secret, publicID) {
		t.Fatalf("issued token does not carry public ID %q", publicID)
	}

	authenticator, err := service.Authenticator(rejectingSessionResolver{})
	if err != nil {
		t.Fatalf("Authenticator() error = %v", err)
	}
	credential, err := authenticator.ResolveCredential(ctx, issue.Secret)
	if err != nil {
		t.Fatalf("ResolveCredential() error = %v", err)
	}
	if credential.User.ID != ownerID ||
		credential.Kind != coreauth.CredentialPersonalToken {
		t.Fatalf("credential = %#v", credential)
	}
	var lastUsedAt *time.Time
	if err := pool.QueryRow(
		ctx,
		`SELECT last_used_at FROM personal_api_tokens WHERE id = $1`,
		issue.Token.ID,
	).Scan(&lastUsedAt); err != nil {
		t.Fatalf("read last_used_at: %v", err)
	}
	if lastUsedAt == nil || !lastUsedAt.Equal(now) {
		t.Fatalf("last_used_at=%v, want %s", lastUsedAt, now)
	}
	if err := service.RevokePersonalToken(ctx, ownerID, issue.Token.ID); err != nil {
		t.Fatalf("RevokePersonalToken() error = %v", err)
	}
	if _, err := authenticator.ResolveCredential(
		ctx,
		issue.Secret,
	); !errors.Is(err, coreauth.ErrUnauthenticated) {
		t.Fatalf("ResolveCredential(revoked) error = %v, want unauthenticated", err)
	}
}

func pointer[T any](value T) *T {
	return &value
}

func stringsHasPublicID(token, publicID string) bool {
	return len(publicID) > 0 &&
		len(token) > len(publicID) &&
		token[len(coreauth.PersonalTokenPrefix):len(coreauth.PersonalTokenPrefix)+len(publicID)] == publicID
}

type rejectingSessionResolver struct{}

func (rejectingSessionResolver) ResolveSession(
	context.Context,
	string,
) (coreauth.User, error) {
	return coreauth.User{}, coreauth.ErrUnauthenticated
}
