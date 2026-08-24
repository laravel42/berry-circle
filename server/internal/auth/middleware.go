package auth

import (
	"context"
	"errors"
	"net/http"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

// SessionResolver is the minimal dependency required by product-route guards.
type SessionResolver interface {
	ResolveSession(context.Context, string) (User, error)
}

// RequireSession enforces one strict bearer credential and attaches its user.
func RequireSession(resolver SessionResolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			values := request.Header.Values("Authorization")
			if len(values) != 1 {
				writeUnauthenticated(response, request)
				return
			}
			token, err := ParseAuthorization(values[0])
			if err != nil {
				writeUnauthenticated(response, request)
				return
			}
			var (
				user       User
				credential Credential
			)
			if detailed, ok := resolver.(CredentialResolver); ok {
				credential, err = detailed.ResolveCredential(request.Context(), token)
				user = credential.User
			} else {
				user, err = resolver.ResolveSession(request.Context(), token)
				credential = Credential{Kind: CredentialSession, User: user}
			}
			if errors.Is(err, ErrUnauthenticated) {
				writeUnauthenticated(response, request)
				return
			}
			if err != nil {
				httpapi.WriteError(
					response,
					request,
					http.StatusInternalServerError,
					"INTERNAL",
					"Internal server error.",
					nil,
				)
				return
			}
			next.ServeHTTP(
				response,
				request.WithContext(WithCredential(request.Context(), credential)),
			)
		})
	}
}

// RequireRole must run after RequireSession.
func RequireRole(roles ...Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			user, ok := UserFromContext(request.Context())
			if !ok {
				writeUnauthenticated(response, request)
				return
			}
			if !user.HasRole(roles...) {
				httpapi.WriteError(
					response,
					request,
					http.StatusForbidden,
					"FORBIDDEN",
					"You do not have permission to perform this action.",
					nil,
				)
				return
			}
			next.ServeHTTP(response, request)
		})
	}
}

func writeUnauthenticated(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnauthorized,
		"UNAUTHENTICATED",
		"Authentication required.",
		nil,
	)
}
