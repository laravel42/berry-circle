// Package identityhandler exports the disjoint P1 identity route mounts.
package identityhandler

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

// API is the HTTP-facing identity service contract.
type API interface {
	Bootstrap(context.Context, uuid.UUID) (identity.Bootstrap, error)
	GetProfile(context.Context, uuid.UUID) (identity.Profile, error)
	UpdateProfile(context.Context, uuid.UUID, identity.ProfilePatch) (identity.Profile, error)
	UpdateUserSettings(
		context.Context,
		uuid.UUID,
		identity.UserSettingsPatch,
	) (identity.UserSettings, error)
	UpdateOnboarding(
		context.Context,
		uuid.UUID,
		identity.OnboardingState,
	) (identity.OnboardingState, *time.Time, error)
	ListWorkspaces(
		context.Context,
		uuid.UUID,
		*identity.TimeCursor,
		int,
	) ([]identity.Workspace, error)
	CreateWorkspace(
		context.Context,
		uuid.UUID,
		string,
		string,
		*string,
		string,
		[sha256.Size]byte,
	) (identity.Workspace, bool, error)
	GetWorkspace(context.Context, uuid.UUID, uuid.UUID) (identity.Workspace, error)
	UpdateWorkspace(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.WorkspacePatch,
	) (identity.Workspace, error)
	DeleteWorkspace(context.Context, uuid.UUID, uuid.UUID) error
	SelectWorkspace(context.Context, uuid.UUID, uuid.UUID) error
	UpdateWorkspaceSettings(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.WorkspaceSettingsPatch,
	) (identity.WorkspaceSettings, error)
	ListMembers(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		*identity.NameCursor,
		int,
	) ([]identity.Membership, error)
	UpdateMemberRole(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		identity.Role,
	) (identity.Membership, error)
	RemoveMember(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
	CreateInvitation(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		string,
		identity.Role,
		time.Time,
		string,
		[sha256.Size]byte,
	) (identity.InvitationIssue, error)
	ListWorkspaceInvitations(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		*identity.TimeCursor,
		int,
	) ([]identity.Invitation, error)
	RevokeInvitation(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
	ListPersonalInvitations(
		context.Context,
		uuid.UUID,
		*identity.TimeCursor,
		int,
	) ([]identity.Invitation, error)
	AcceptInvitation(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		string,
	) (identity.Membership, error)
	CreatePersonalToken(
		context.Context,
		uuid.UUID,
		string,
		*time.Time,
		string,
		[sha256.Size]byte,
	) (identity.PersonalTokenIssue, error)
	ListPersonalTokens(
		context.Context,
		uuid.UUID,
		*identity.TimeCursor,
		int,
	) ([]identity.PersonalToken, error)
	RevokePersonalToken(context.Context, uuid.UUID, uuid.UUID) error
}

// Options supply the composite session/PAT resolver and identity service.
type Options struct {
	Authenticator auth.SessionResolver
	Service       API
	Clock         func() time.Time
}

type handlers struct {
	service API
	clock   func() time.Time
}

// NewMounts builds four disjoint registry mounts without owning process
// lifecycle. The caller registers all returned mounts.
func NewMounts(options Options) ([]httpapi.Mount, error) {
	if options.Authenticator == nil {
		return nil, errors.New("identity handler authenticator is nil")
	}
	if options.Service == nil {
		return nil, errors.New("identity handler service is nil")
	}
	if options.Clock == nil {
		return nil, errors.New("identity handler clock is nil")
	}
	target := &handlers{service: options.Service, clock: options.Clock}
	requireAuth := auth.RequireSession(options.Authenticator)

	me := httpapi.NewSubrouter()
	me.Use(requireAuth)
	me.Get("/", target.getProfile)
	me.Patch("/", target.updateProfile)
	me.Get("/bootstrap", target.bootstrap)
	me.Get("/onboarding", target.getOnboarding)
	me.Patch("/onboarding", target.updateOnboarding)
	me.Get("/settings", target.getUserSettings)
	me.Patch("/settings", target.updateUserSettings)

	workspaces := httpapi.NewSubrouter()
	workspaces.Use(requireAuth)
	workspaces.Get("/", target.listWorkspaces)
	workspaces.Post("/", target.createWorkspace)
	workspaces.Get("/{workspaceId}", target.getWorkspace)
	workspaces.Patch("/{workspaceId}", target.updateWorkspace)
	workspaces.Delete("/{workspaceId}", target.deleteWorkspace)
	workspaces.Post("/{workspaceId}/select", target.selectWorkspace)
	workspaces.Get("/{workspaceId}/settings", target.getWorkspaceSettings)
	workspaces.Patch("/{workspaceId}/settings", target.updateWorkspaceSettings)
	workspaces.Get("/{workspaceId}/members", target.listMembers)
	workspaces.Patch("/{workspaceId}/members/{userId}", target.updateMemberRole)
	workspaces.Delete("/{workspaceId}/members/{userId}", target.removeMember)
	workspaces.Get("/{workspaceId}/invitations", target.listWorkspaceInvitations)
	workspaces.Post("/{workspaceId}/invitations", target.createInvitation)
	workspaces.Delete(
		"/{workspaceId}/invitations/{invitationId}",
		target.revokeInvitation,
	)

	invitations := httpapi.NewSubrouter()
	invitations.Use(requireAuth)
	invitations.Get("/", target.listPersonalInvitations)
	invitations.Post("/{invitationId}/accept", target.acceptInvitation)

	tokens := httpapi.NewSubrouter()
	tokens.Use(requireAuth)
	tokens.Get("/", target.listPersonalTokens)
	tokens.Post("/", target.createPersonalToken)
	tokens.Delete("/{tokenId}", target.revokePersonalToken)

	return []httpapi.Mount{
		{Prefix: "/api/v1/me", Handler: me},
		{Prefix: "/api/v1/workspaces", Handler: workspaces},
		{Prefix: "/api/v1/invitations", Handler: invitations},
		{Prefix: "/api/v1/tokens", Handler: tokens},
	}, nil
}

// Mounts follows the established fail-fast route registry convention.
func Mounts(options Options) []httpapi.Mount {
	mounts, err := NewMounts(options)
	if err != nil {
		panic(fmt.Sprintf("construct identity handlers: %v", err))
	}
	return mounts
}

func currentUser(request *http.Request) auth.User {
	return auth.MustUser(request.Context())
}

func writeDomainError(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	resource string,
) {
	switch {
	case errors.Is(err, identity.ErrNotFound):
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			resource+" not found.",
			nil,
		)
	case errors.Is(err, identity.ErrInvitationInvalid):
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"INVITATION_INVALID",
			"Invitation not found or no longer valid.",
			nil,
		)
	case errors.Is(err, identity.ErrForbidden):
		httpapi.WriteError(
			response,
			request,
			http.StatusForbidden,
			"FORBIDDEN",
			"You do not have permission to perform this action.",
			nil,
		)
	case errors.Is(err, identity.ErrLastOwner):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"LAST_OWNER_REQUIRED",
			"A workspace must retain at least one owner.",
			nil,
		)
	case errors.Is(err, identity.ErrIdempotencyConflict):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"IDEMPOTENCY_CONFLICT",
			"The Idempotency-Key was already used with different input.",
			nil,
		)
	case errors.Is(err, identity.ErrConflict):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"CONFLICT",
			resource+" conflicts with an existing resource.",
			nil,
		)
	default:
		httpapi.WriteError(
			response,
			request,
			http.StatusInternalServerError,
			"INTERNAL",
			"Internal server error.",
			nil,
		)
	}
}
