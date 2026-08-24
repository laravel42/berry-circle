// Package identity owns Berry users, workspaces, memberships, invitations,
// onboarding state, settings, and personal API-token metadata.
package identity

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrNotFound hides absent and cross-workspace resources behind one result.
	ErrNotFound = errors.New("identity resource not found")
	// ErrForbidden means the caller is a member but lacks a required permission.
	ErrForbidden = errors.New("identity operation forbidden")
	// ErrConflict represents a uniqueness or lifecycle conflict safe to expose.
	ErrConflict = errors.New("identity resource conflict")
	// ErrLastOwner prevents a workspace from becoming ownerless.
	ErrLastOwner = errors.New("workspace must retain an owner")
	// ErrIdempotencyConflict means a create key was reused with another request.
	ErrIdempotencyConflict = errors.New("idempotency key reused with different input")
	// ErrInvitationInvalid intentionally combines unknown, expired, revoked,
	// wrong-recipient, and wrong-secret invitation failures.
	ErrInvitationInvalid = errors.New("invitation is invalid")
)

// Role is a workspace membership role.
type Role string

const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
	RoleViewer Role = "viewer"
)

// Permission names one workspace-scoped capability.
type Permission string

const (
	PermissionWorkspaceRead    Permission = "workspace.read"
	PermissionWorkspaceUpdate  Permission = "workspace.update"
	PermissionWorkspaceDelete  Permission = "workspace.delete"
	PermissionSettingsRead     Permission = "settings.read"
	PermissionSettingsWrite    Permission = "settings.write"
	PermissionMembersRead      Permission = "members.read"
	PermissionMembersManage    Permission = "members.manage"
	PermissionOwnersManage     Permission = "owners.manage"
	PermissionInvitationsRead  Permission = "invitations.read"
	PermissionInvitationsWrite Permission = "invitations.write"
	PermissionProductRead      Permission = "product.read"
	PermissionProductWrite     Permission = "product.write"
	PermissionCommentWrite     Permission = "comments.write"
	PermissionRunsDispatch     Permission = "runs.dispatch"
	// PermissionRead and PermissionWrite are the handler-facing aliases for
	// workspace-scoped Berry product resources.
	PermissionRead  Permission = PermissionProductRead
	PermissionWrite Permission = PermissionProductWrite
)

// Scope is the active workspace membership resolved for a product resource.
type Scope struct {
	WorkspaceID uuid.UUID
	Role        Role
}

var rolePermissions = map[Role]map[Permission]struct{}{
	RoleOwner: {
		PermissionWorkspaceRead:    {},
		PermissionWorkspaceUpdate:  {},
		PermissionWorkspaceDelete:  {},
		PermissionSettingsRead:     {},
		PermissionSettingsWrite:    {},
		PermissionMembersRead:      {},
		PermissionMembersManage:    {},
		PermissionOwnersManage:     {},
		PermissionInvitationsRead:  {},
		PermissionInvitationsWrite: {},
		PermissionProductRead:      {},
		PermissionProductWrite:     {},
		PermissionCommentWrite:     {},
		PermissionRunsDispatch:     {},
	},
	RoleAdmin: {
		PermissionWorkspaceRead:    {},
		PermissionWorkspaceUpdate:  {},
		PermissionSettingsRead:     {},
		PermissionSettingsWrite:    {},
		PermissionMembersRead:      {},
		PermissionMembersManage:    {},
		PermissionInvitationsRead:  {},
		PermissionInvitationsWrite: {},
		PermissionProductRead:      {},
		PermissionProductWrite:     {},
		PermissionCommentWrite:     {},
		PermissionRunsDispatch:     {},
	},
	RoleMember: {
		PermissionWorkspaceRead: {},
		PermissionSettingsRead:  {},
		PermissionMembersRead:   {},
		PermissionProductRead:   {},
		PermissionProductWrite:  {},
		PermissionCommentWrite:  {},
		PermissionRunsDispatch:  {},
	},
	RoleViewer: {
		PermissionWorkspaceRead: {},
		PermissionSettingsRead:  {},
		PermissionMembersRead:   {},
		PermissionProductRead:   {},
	},
}

// Valid reports whether role is persisted by the current schema.
func (role Role) Valid() bool {
	_, ok := rolePermissions[role]
	return ok
}

// Allows applies Berry's explicit workspace permission matrix.
func (role Role) Allows(permission Permission) bool {
	allowed, ok := rolePermissions[role]
	if !ok {
		return false
	}
	_, ok = allowed[permission]
	return ok
}

// WorkspaceSettings are the bounded settings implemented in the P1 foundation.
type WorkspaceSettings struct {
	IssuePrefix        string `json:"issuePrefix"`
	DefaultRole        Role   `json:"defaultRole"`
	AllowMemberInvites bool   `json:"allowMemberInvites"`
}

// UserSettings are account-level browser preferences.
type UserSettings struct {
	Theme         string `json:"theme"`
	Timezone      string `json:"timezone"`
	ReducedMotion bool   `json:"reducedMotion"`
}

// OnboardingState is resumable and records either answers or an explicit skip.
type OnboardingState struct {
	Version   int               `json:"version"`
	Step      string            `json:"step"`
	Answers   map[string]string `json:"answers"`
	Skipped   bool              `json:"skipped"`
	Completed bool              `json:"completed"`
}

// Profile is the mutable current-user identity projection.
type Profile struct {
	ID          uuid.UUID
	Email       string
	Name        string
	AvatarURL   *string
	Settings    UserSettings
	Onboarding  OnboardingState
	OnboardedAt *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Workspace is a Berry workspace visible to one authenticated member.
type Workspace struct {
	ID          uuid.UUID
	Name        string
	Slug        string
	Description *string
	Settings    WorkspaceSettings
	Role        Role
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Membership includes the user projection needed by settings and member lists.
type Membership struct {
	WorkspaceID uuid.UUID
	UserID      uuid.UUID
	Role        Role
	Email       string
	Name        string
	AvatarURL   *string
	JoinedAt    time.Time
	UpdatedAt   time.Time
}

// Invitation is safe metadata; Token is returned separately only at creation.
type Invitation struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Email       string
	Role        Role
	InvitedBy   uuid.UUID
	ExpiresAt   time.Time
	AcceptedAt  *time.Time
	RevokedAt   *time.Time
	CreatedAt   time.Time
}

// PersonalToken is safe metadata and never contains a secret hash.
type PersonalToken struct {
	ID         uuid.UUID
	Name       string
	Prefix     string
	ExpiresAt  *time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
	CreatedAt  time.Time
}

// TimeCursor is the stable descending collection key.
type TimeCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        uuid.UUID `json:"id"`
}

// NameCursor is the stable ascending member collection key.
type NameCursor struct {
	Name string    `json:"name"`
	ID   uuid.UUID `json:"id"`
}

// Bootstrap is the authenticated shell's account/workspace starting state.
type Bootstrap struct {
	Profile            Profile
	Workspaces         []Workspace
	CurrentWorkspaceID *uuid.UUID
}

// ProfilePatch distinguishes omitted avatar from an explicit null.
type ProfilePatch struct {
	Name         *string
	AvatarURLSet bool
	AvatarURL    *string
}

// UserSettingsPatch contains a non-empty subset of user settings.
type UserSettingsPatch struct {
	Theme         *string
	Timezone      *string
	ReducedMotion *bool
}

// WorkspacePatch contains a non-empty subset of mutable workspace fields.
type WorkspacePatch struct {
	Name           *string
	Slug           *string
	DescriptionSet bool
	Description    *string
}

// WorkspaceSettingsPatch contains a non-empty settings subset.
type WorkspaceSettingsPatch struct {
	IssuePrefix        *string
	DefaultRole        *Role
	AllowMemberInvites *bool
}

// CreateWorkspaceParams carries normalized values and idempotency digests.
type CreateWorkspaceParams struct {
	ID                 uuid.UUID
	ActorID            uuid.UUID
	Name               string
	Slug               string
	Description        *string
	Settings           WorkspaceSettings
	IdempotencyKeyHash [32]byte
	Fingerprint        [32]byte
	CreatedAt          time.Time
}

// CreateInvitationParams carries a one-time invitation secret digest.
type CreateInvitationParams struct {
	ID                 uuid.UUID
	WorkspaceID        uuid.UUID
	ActorID            uuid.UUID
	Email              string
	Role               Role
	TokenHash          [32]byte
	IdempotencyKeyHash [32]byte
	Fingerprint        [32]byte
	ExpiresAt          time.Time
	CreatedAt          time.Time
}

// CreatePersonalTokenParams carries a one-time personal token secret digest.
type CreatePersonalTokenParams struct {
	ID                 uuid.UUID
	UserID             uuid.UUID
	Name               string
	PublicID           string
	SecretHash         [32]byte
	IdempotencyKeyHash [32]byte
	Fingerprint        [32]byte
	ExpiresAt          *time.Time
	CreatedAt          time.Time
}

// InvitationIssue returns a raw invitation token only for the first creation.
type InvitationIssue struct {
	Invitation Invitation
	Token      string
	Replayed   bool
}

// PersonalTokenIssue returns a raw personal token only for the first creation.
type PersonalTokenIssue struct {
	Token    PersonalToken
	Secret   string
	Replayed bool
}
