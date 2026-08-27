package identity

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/issueid"
)

const InvitationTokenPrefix = "berry_inv_"

// ServiceOptions make time, IDs, randomness, and persistence deterministic.
type ServiceOptions struct {
	Pool       *pgxpool.Pool
	Repository *Repository
	Now        func() time.Time
	NewID      func() uuid.UUID
	Random     io.Reader
}

// Service owns P1 identity and workspace product rules.
type Service struct {
	repository *Repository
	now        func() time.Time
	newID      func() uuid.UUID
	random     io.Reader
	personal   *coreauth.PersonalTokenResolver
}

// NewService constructs the lifecycle-independent identity service.
func NewService(options ServiceOptions) (*Service, error) {
	repository := options.Repository
	if repository == nil {
		var err error
		repository, err = NewRepository(options.Pool)
		if err != nil {
			return nil, err
		}
	}
	if options.Now == nil {
		return nil, errors.New("identity service clock is nil")
	}
	if options.NewID == nil {
		return nil, errors.New("identity service ID generator is nil")
	}
	if options.Random == nil {
		return nil, errors.New("identity service random source is nil")
	}
	personal, err := coreauth.NewPersonalTokenResolver(repository, options.Now)
	if err != nil {
		return nil, err
	}
	return &Service{
		repository: repository,
		now:        options.Now,
		newID:      options.NewID,
		random:     options.Random,
		personal:   personal,
	}, nil
}

// Authenticator adds personal bearer tokens to an existing session resolver
// without changing the interfaces consumed by established handlers.
func (service *Service) Authenticator(
	sessions coreauth.SessionResolver,
) (coreauth.CompositeResolver, error) {
	if sessions == nil {
		return coreauth.CompositeResolver{}, errors.New("session resolver is nil")
	}
	return coreauth.CompositeResolver{
		Sessions: sessions,
		Personal: service.personal,
	}, nil
}

// AuthorizeWorkspace returns membership role or a hidden not-found result.
func (service *Service) AuthorizeWorkspace(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	permission Permission,
) (Role, error) {
	role, err := service.repository.MembershipRole(ctx, workspaceID, userID)
	if err != nil {
		return "", err
	}
	if !role.Allows(permission) {
		return role, ErrForbidden
	}
	return role, nil
}

// AuthorizeBoard hides missing and cross-workspace boards behind ErrNotFound.
func (service *Service) AuthorizeBoard(
	ctx context.Context,
	userID, boardID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.BoardScope(ctx, userID, boardID)
	return authorizeScope(scope, err, permission)
}

// AuthorizeIssue hides missing and cross-workspace issues behind ErrNotFound.
func (service *Service) AuthorizeIssue(
	ctx context.Context,
	userID, issueID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.IssueScope(ctx, userID, issueID)
	return authorizeScope(scope, err, permission)
}

// AuthorizeIssueReference is the hidden workspace seam for nested routes that
// receive either an issue UUID or a workspace-prefix issue identifier.
func (service *Service) AuthorizeIssueReference(
	ctx context.Context,
	userID uuid.UUID,
	reference string,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.IssueReferenceScope(ctx, userID, reference)
	return authorizeScope(scope, err, permission)
}

// AuthorizeComment hides missing and cross-workspace comments behind
// ErrNotFound.
func (service *Service) AuthorizeComment(
	ctx context.Context,
	userID, commentID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.CommentScope(ctx, userID, commentID)
	return authorizeScope(scope, err, permission)
}

// AuthorizeRun hides missing and cross-workspace runs behind ErrNotFound.
func (service *Service) AuthorizeRun(
	ctx context.Context,
	userID, runID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.RunScope(ctx, userID, runID)
	return authorizeScope(scope, err, permission)
}

// AuthorizeAgent hides missing, unattributed, and cross-workspace agents.
func (service *Service) AuthorizeAgent(
	ctx context.Context,
	userID, agentID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.AgentScope(ctx, userID, agentID)
	return authorizeScope(scope, err, permission)
}

// AuthorizeGoal hides missing, archived and cross-workspace goals behind
// ErrNotFound.
func (service *Service) AuthorizeGoal(
	ctx context.Context,
	userID, goalID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.GoalScope(ctx, userID, goalID)
	return authorizeScope(scope, err, permission)
}

// AuthorizePlan hides missing and cross-workspace plans behind ErrNotFound.
func (service *Service) AuthorizePlan(
	ctx context.Context,
	userID, planID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.PlanScope(ctx, userID, planID)
	return authorizeScope(scope, err, permission)
}

// AuthorizeApproval hides missing and cross-workspace approvals behind
// ErrNotFound. Whether the caller is the addressee is a product rule decided
// by the approvals service, not a membership question.
func (service *Service) AuthorizeApproval(
	ctx context.Context,
	userID, approvalID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.ApprovalScope(ctx, userID, approvalID)
	return authorizeScope(scope, err, permission)
}

// AuthorizeAutomation hides missing and cross-workspace workflows behind
// ErrNotFound.
func (service *Service) AuthorizeAutomation(
	ctx context.Context,
	userID, automationID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.AutomationScope(ctx, userID, automationID)
	return authorizeScope(scope, err, permission)
}

// AuthorizeAutomationRun hides missing and cross-workspace workflow runs
// behind ErrNotFound.
func (service *Service) AuthorizeAutomationRun(
	ctx context.Context,
	userID, runID uuid.UUID,
	permission Permission,
) (Scope, error) {
	scope, err := service.repository.AutomationRunScope(ctx, userID, runID)
	return authorizeScope(scope, err, permission)
}

// ValidateAssignee hides assignees outside the owning workspace.
func (service *Service) ValidateAssignee(
	ctx context.Context,
	workspaceID uuid.UUID,
	actorType string,
	actorID uuid.UUID,
) error {
	exists, err := service.repository.AssigneeExistsInWorkspace(
		ctx,
		workspaceID,
		actorType,
		actorID,
	)
	if err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func authorizeScope(
	scope Scope,
	err error,
	permission Permission,
) (Scope, error) {
	if err != nil {
		return Scope{}, err
	}
	if !scope.Role.Allows(permission) {
		return Scope{}, ErrForbidden
	}
	return scope, nil
}

// Bootstrap returns the account and first bounded workspace shell page.
func (service *Service) Bootstrap(
	ctx context.Context,
	userID uuid.UUID,
) (Bootstrap, error) {
	profile, current, err := service.repository.GetProfile(ctx, userID)
	if err != nil {
		return Bootstrap{}, err
	}
	workspaces, err := service.repository.ListWorkspaces(ctx, userID, nil, 100)
	if err != nil {
		return Bootstrap{}, err
	}
	if current != nil {
		if _, err := service.repository.GetWorkspace(ctx, *current, userID); errors.Is(
			err,
			ErrNotFound,
		) {
			current = nil
		} else if err != nil {
			return Bootstrap{}, err
		}
	}
	return Bootstrap{
		Profile:            profile,
		Workspaces:         workspaces,
		CurrentWorkspaceID: current,
	}, nil
}

func (service *Service) GetProfile(
	ctx context.Context,
	userID uuid.UUID,
) (Profile, error) {
	profile, _, err := service.repository.GetProfile(ctx, userID)
	return profile, err
}

func (service *Service) UpdateProfile(
	ctx context.Context,
	userID uuid.UUID,
	patch ProfilePatch,
) (Profile, error) {
	return service.repository.UpdateProfile(ctx, userID, patch, service.now().UTC())
}

func (service *Service) UpdateUserSettings(
	ctx context.Context,
	userID uuid.UUID,
	patch UserSettingsPatch,
) (UserSettings, error) {
	profile, _, err := service.repository.GetProfile(ctx, userID)
	if err != nil {
		return UserSettings{}, err
	}
	next := profile.Settings
	if patch.Theme != nil {
		next.Theme = *patch.Theme
	}
	if patch.Timezone != nil {
		next.Timezone = *patch.Timezone
	}
	if patch.ReducedMotion != nil {
		next.ReducedMotion = *patch.ReducedMotion
	}
	return service.repository.UpdateUserSettings(ctx, userID, next, service.now().UTC())
}

func (service *Service) UpdateOnboarding(
	ctx context.Context,
	userID uuid.UUID,
	state OnboardingState,
) (OnboardingState, *time.Time, error) {
	return service.repository.UpdateOnboarding(ctx, userID, state, service.now().UTC())
}

func (service *Service) ListWorkspaces(
	ctx context.Context,
	userID uuid.UUID,
	after *TimeCursor,
	limit int,
) ([]Workspace, error) {
	return service.repository.ListWorkspaces(ctx, userID, after, limit)
}

func (service *Service) CreateWorkspace(
	ctx context.Context,
	userID uuid.UUID,
	name, slug string,
	description *string,
	idempotencyKey string,
	fingerprint [sha256.Size]byte,
) (Workspace, bool, error) {
	return service.repository.CreateWorkspace(ctx, CreateWorkspaceParams{
		ID:          service.newID(),
		ActorID:     userID,
		Name:        name,
		Slug:        slug,
		Description: description,
		Settings: WorkspaceSettings{
			IssuePrefix:        issueid.PrefixFromName(name, slug),
			DefaultRole:        RoleMember,
			AllowMemberInvites: false,
		},
		IdempotencyKeyHash: coreauth.DigestToken(idempotencyKey),
		Fingerprint:        fingerprint,
		CreatedAt:          service.now().UTC(),
	})
}

func (service *Service) GetWorkspace(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
) (Workspace, error) {
	return service.repository.GetWorkspace(ctx, workspaceID, userID)
}

func (service *Service) UpdateWorkspace(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	patch WorkspacePatch,
) (Workspace, error) {
	workspace, err := service.repository.GetWorkspace(ctx, workspaceID, userID)
	if err != nil {
		return Workspace{}, err
	}
	if !workspace.Role.Allows(PermissionWorkspaceUpdate) {
		return Workspace{}, ErrForbidden
	}
	updated, err := service.repository.UpdateWorkspace(
		ctx,
		workspaceID,
		patch,
		service.now().UTC(),
	)
	updated.Role = workspace.Role
	return updated, err
}

func (service *Service) DeleteWorkspace(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
) error {
	if _, err := service.AuthorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		PermissionWorkspaceDelete,
	); err != nil {
		return err
	}
	return service.repository.DeleteWorkspace(ctx, workspaceID, service.now().UTC())
}

func (service *Service) SelectWorkspace(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
) error {
	return service.repository.SelectWorkspace(
		ctx,
		userID,
		workspaceID,
		service.now().UTC(),
	)
}

func (service *Service) UpdateWorkspaceSettings(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	patch WorkspaceSettingsPatch,
) (WorkspaceSettings, error) {
	workspace, err := service.repository.GetWorkspace(ctx, workspaceID, userID)
	if err != nil {
		return WorkspaceSettings{}, err
	}
	if !workspace.Role.Allows(PermissionSettingsWrite) {
		return WorkspaceSettings{}, ErrForbidden
	}
	next := workspace.Settings
	if patch.IssuePrefix != nil {
		next.IssuePrefix = *patch.IssuePrefix
	}
	if patch.DefaultRole != nil {
		next.DefaultRole = *patch.DefaultRole
	}
	if patch.AllowMemberInvites != nil {
		next.AllowMemberInvites = *patch.AllowMemberInvites
	}
	return service.repository.UpdateWorkspaceSettings(
		ctx,
		workspaceID,
		next,
		service.now().UTC(),
	)
}

func (service *Service) ListMembers(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	after *NameCursor,
	limit int,
) ([]Membership, error) {
	if _, err := service.AuthorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		PermissionMembersRead,
	); err != nil {
		return nil, err
	}
	return service.repository.ListMembers(ctx, workspaceID, after, limit)
}

func (service *Service) UpdateMemberRole(
	ctx context.Context,
	userID, workspaceID, targetID uuid.UUID,
	role Role,
) (Membership, error) {
	if !role.Valid() {
		return Membership{}, errors.New("invalid workspace role")
	}
	return service.repository.UpdateMemberRole(ctx, workspaceID, userID, targetID, role)
}

func (service *Service) RemoveMember(
	ctx context.Context,
	userID, workspaceID, targetID uuid.UUID,
) error {
	return service.repository.RemoveMember(ctx, workspaceID, userID, targetID)
}

func (service *Service) CreateInvitation(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	email string,
	role Role,
	expiresAt time.Time,
	idempotencyKey string,
	fingerprint [sha256.Size]byte,
) (InvitationIssue, error) {
	workspace, err := service.repository.GetWorkspace(ctx, workspaceID, userID)
	if err != nil {
		return InvitationIssue{}, err
	}
	allowed := workspace.Role.Allows(PermissionInvitationsWrite)
	if !allowed && workspace.Role == RoleMember &&
		workspace.Settings.AllowMemberInvites &&
		(role == RoleMember || role == RoleViewer) {
		allowed = true
	}
	if !allowed {
		return InvitationIssue{}, ErrForbidden
	}
	if role == RoleOwner ||
		(workspace.Role != RoleOwner && role == RoleAdmin) {
		return InvitationIssue{}, ErrForbidden
	}
	existing, err := service.repository.WorkspaceMemberEmailExists(
		ctx,
		workspaceID,
		email,
	)
	if err != nil {
		return InvitationIssue{}, err
	}
	if existing {
		return InvitationIssue{}, ErrConflict
	}
	secret, err := coreauth.GenerateToken(service.random)
	if err != nil {
		return InvitationIssue{}, err
	}
	raw := InvitationTokenPrefix + secret
	invitation, replayed, err := service.repository.CreateInvitation(
		ctx,
		CreateInvitationParams{
			ID:                 service.newID(),
			WorkspaceID:        workspaceID,
			ActorID:            userID,
			Email:              email,
			Role:               role,
			TokenHash:          coreauth.DigestToken(raw),
			IdempotencyKeyHash: coreauth.DigestToken(idempotencyKey),
			Fingerprint:        fingerprint,
			ExpiresAt:          expiresAt,
			CreatedAt:          service.now().UTC(),
		},
	)
	if err != nil {
		return InvitationIssue{}, err
	}
	if replayed {
		raw = ""
	}
	return InvitationIssue{Invitation: invitation, Token: raw, Replayed: replayed}, nil
}

func (service *Service) ListWorkspaceInvitations(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	after *TimeCursor,
	limit int,
) ([]Invitation, error) {
	if _, err := service.AuthorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		PermissionInvitationsRead,
	); err != nil {
		return nil, err
	}
	return service.repository.ListWorkspaceInvitations(ctx, workspaceID, after, limit)
}

func (service *Service) RevokeInvitation(
	ctx context.Context,
	userID, workspaceID, invitationID uuid.UUID,
) error {
	if _, err := service.AuthorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		PermissionInvitationsWrite,
	); err != nil {
		return err
	}
	return service.repository.RevokeInvitation(
		ctx,
		workspaceID,
		invitationID,
		service.now().UTC(),
	)
}

func (service *Service) ListPersonalInvitations(
	ctx context.Context,
	userID uuid.UUID,
	after *TimeCursor,
	limit int,
) ([]Invitation, error) {
	profile, _, err := service.repository.GetProfile(ctx, userID)
	if err != nil {
		return nil, err
	}
	return service.repository.ListPersonalInvitations(
		ctx,
		strings.ToLower(profile.Email),
		service.now().UTC(),
		after,
		limit,
	)
}

func (service *Service) AcceptInvitation(
	ctx context.Context,
	userID, invitationID uuid.UUID,
	token string,
) (Membership, error) {
	if !strings.HasPrefix(token, InvitationTokenPrefix) {
		return Membership{}, ErrInvitationInvalid
	}
	// Everything after the fixed-length prefix is the secret. There is nothing
	// to disambiguate here, so no separator check: the secret is base64url,
	// that alphabet contains '_', and refusing tokens that happen to hold one
	// rejected 48% of every invitation this service issued. ParseAuthorization
	// still enforces the exact 43-character, 32-byte shape.
	secret := strings.TrimPrefix(token, InvitationTokenPrefix)
	decoded, err := coreauth.ParseAuthorization("Bearer " + secret)
	if err != nil || decoded != secret {
		return Membership{}, ErrInvitationInvalid
	}
	profile, _, err := service.repository.GetProfile(ctx, userID)
	if err != nil {
		return Membership{}, err
	}
	return service.repository.AcceptInvitation(
		ctx,
		invitationID,
		userID,
		strings.ToLower(profile.Email),
		coreauth.DigestToken(token),
		service.now().UTC(),
	)
}

func (service *Service) CreatePersonalToken(
	ctx context.Context,
	userID uuid.UUID,
	name string,
	expiresAt *time.Time,
	idempotencyKey string,
	fingerprint [sha256.Size]byte,
) (PersonalTokenIssue, error) {
	generated, err := coreauth.GeneratePersonalToken(service.random)
	if err != nil {
		return PersonalTokenIssue{}, err
	}
	token, replayed, err := service.repository.CreatePersonalToken(
		ctx,
		CreatePersonalTokenParams{
			ID:                 service.newID(),
			UserID:             userID,
			Name:               name,
			PublicID:           generated.PublicID,
			SecretHash:         generated.SecretHash,
			IdempotencyKeyHash: coreauth.DigestToken(idempotencyKey),
			Fingerprint:        fingerprint,
			ExpiresAt:          expiresAt,
			CreatedAt:          service.now().UTC(),
		},
	)
	if err != nil {
		return PersonalTokenIssue{}, err
	}
	secret := generated.Token
	if replayed {
		secret = ""
	}
	return PersonalTokenIssue{Token: token, Secret: secret, Replayed: replayed}, nil
}

func (service *Service) ListPersonalTokens(
	ctx context.Context,
	userID uuid.UUID,
	after *TimeCursor,
	limit int,
) ([]PersonalToken, error) {
	return service.repository.ListPersonalTokens(ctx, userID, after, limit)
}

func (service *Service) RevokePersonalToken(
	ctx context.Context,
	userID, tokenID uuid.UUID,
) error {
	return service.repository.RevokePersonalToken(
		ctx,
		userID,
		tokenID,
		service.now().UTC(),
	)
}

// WorkspaceScope is the primitive used by HTTP/SSE/WebSocket adapters that
// already parsed an authenticated user and workspace identifier.
func (service *Service) WorkspaceScope(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
) (string, error) {
	if _, err := service.AuthorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		PermissionProductRead,
	); err != nil {
		return "", err
	}
	return workspaceID.String(), nil
}
