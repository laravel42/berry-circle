// Package auth implements Berry's opaque PostgreSQL-backed user sessions.
package auth

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrUnauthenticated intentionally covers unknown, expired, and revoked sessions.
	ErrUnauthenticated = errors.New("session is not authenticated")
	// ErrInvalidCredentials is returned by the temporary known-email login path.
	ErrInvalidCredentials = errors.New("invalid credentials")
)

// Role is the persisted Berry user role.
type Role string

const (
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
)

// User is the authenticated user attached to request context.
type User struct {
	ID        uuid.UUID `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	AvatarURL *string   `json:"avatarUrl"`
	Role      Role      `json:"role"`
	// CurrentWorkspaceID is authorization context, not part of the legacy user DTO.
	CurrentWorkspaceID *uuid.UUID `json:"-"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
}

// IsAdmin reports whether the user may moderate another member's content.
func (user User) IsAdmin() bool {
	return user.Role == RoleAdmin
}

// HasRole reports whether user has one of the accepted roles.
func (user User) HasRole(roles ...Role) bool {
	for _, role := range roles {
		if user.Role == role {
			return true
		}
	}
	return false
}

type contextKey struct{}

// WithUser attaches an authenticated user to a request context.
func WithUser(ctx context.Context, user User) context.Context {
	return context.WithValue(ctx, contextKey{}, user)
}

// UserFromContext reads the authenticated user set by RequireSession.
func UserFromContext(ctx context.Context) (User, bool) {
	user, ok := ctx.Value(contextKey{}).(User)
	return user, ok
}

// MustUser reads the authenticated user. It is intended only after RequireSession.
func MustUser(ctx context.Context) User {
	user, ok := UserFromContext(ctx)
	if !ok {
		panic("auth middleware did not attach a user")
	}
	return user
}
