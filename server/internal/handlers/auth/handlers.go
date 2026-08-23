// Package authhandler exports the disjoint /api/v1/auth session mount.
package authhandler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

const maxLoginBodyBytes = 4096

// LoginConfig gates the temporary known-email login path.
type LoginConfig struct {
	AllowKnownEmail bool
	Environment     string
}

func (config LoginConfig) allowed() bool {
	environment := strings.ToLower(strings.TrimSpace(config.Environment))
	return config.AllowKnownEmail &&
		(environment == "development" || environment == "test")
}

// Options make startup wiring explicit even though lifecycle primitives live in auth.Service.
type Options struct {
	Pool          *pgxpool.Pool
	Sessions      coreauth.Manager
	Authenticator coreauth.SessionResolver
	Clock         func() time.Time
	NewID         func() uuid.UUID
	Login         LoginConfig
}

// NewMount validates dependencies and builds /api/v1/auth.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Pool == nil {
		return httpapi.Mount{}, errors.New("auth handler pool is nil")
	}
	if options.Sessions == nil {
		return httpapi.Mount{}, errors.New("auth handler session manager is nil")
	}
	if options.Clock == nil {
		return httpapi.Mount{}, errors.New("auth handler clock is nil")
	}
	if options.NewID == nil {
		return httpapi.Mount{}, errors.New("auth handler ID generator is nil")
	}
	authenticator := options.Authenticator
	if authenticator == nil {
		authenticator = options.Sessions
	}
	router := httpapi.NewSubrouter()
	// TODO(auth): add Google and email-code flows only after their Berry
	// contract and credential storage are specified.
	router.Post("/login", loginHandler(options.Sessions, options.Login))
	router.With(coreauth.RequireSession(options.Sessions)).
		Post("/logout", logoutHandler(options.Sessions))
	router.With(coreauth.RequireSession(authenticator)).
		Get("/me", meHandler)
	return httpapi.Mount{Prefix: "/api/v1/auth", Handler: router}, nil
}

// Mounts follows the shared registry convention and fails fast on invalid wiring.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic(fmt.Sprintf("construct auth handlers: %v", err))
	}
	return []httpapi.Mount{mount}
}

type loginBody struct {
	Email *string `json:"email"`
}

type loginResponse struct {
	Token     string       `json:"token"`
	ExpiresAt string       `json:"expiresAt"`
	User      userResource `json:"user"`
}

type userResource struct {
	ID        uuid.UUID     `json:"id"`
	Email     string        `json:"email"`
	Name      string        `json:"name"`
	AvatarURL *string       `json:"avatarUrl"`
	Role      coreauth.Role `json:"role"`
	CreatedAt string        `json:"createdAt"`
	UpdatedAt string        `json:"updatedAt"`
}

func loginHandler(
	sessions coreauth.Manager,
	config LoginConfig,
) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		var body loginBody
		if !decodeLogin(response, request, &body) {
			return
		}
		if body.Email == nil {
			writeLoginValidation(response, request, "Field is required.")
			return
		}
		email := strings.TrimSpace(*body.Email)
		if !validEmail(email) {
			writeLoginValidation(response, request, "Email must be a valid email address.")
			return
		}
		if !config.allowed() {
			httpapi.WriteError(
				response,
				request,
				http.StatusForbidden,
				"PASSWORDLESS_LOGIN_DISABLED",
				"Passwordless login is disabled.",
				nil,
			)
			return
		}
		issued, err := sessions.IssueKnownEmail(
			request.Context(),
			email,
			coreauth.SessionMetadata{
				UserAgent: boundedHeader(request.Header.Get("User-Agent"), 1024),
				IP:        forwardedIP(request.Header.Get("X-Forwarded-For")),
			},
		)
		switch {
		case errors.Is(err, coreauth.ErrInvalidCredentials):
			httpapi.WriteError(
				response,
				request,
				http.StatusUnauthorized,
				"UNAUTHENTICATED",
				"Invalid credentials.",
				nil,
			)
			return
		case err != nil:
			writeAuthInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, loginResponse{
			Token:     issued.Token,
			ExpiresAt: issued.ExpiresAt.UTC().Format(time.RFC3339Nano),
			User:      serializeUser(issued.User),
		})
	}
}

func logoutHandler(sessions coreauth.Manager) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		values := request.Header.Values("Authorization")
		if len(values) != 1 {
			writeAuthUnauthenticated(response, request)
			return
		}
		token, err := coreauth.ParseAuthorization(values[0])
		if err != nil {
			writeAuthUnauthenticated(response, request)
			return
		}
		if err := sessions.RevokeSession(request.Context(), token); err != nil {
			writeAuthInternal(response, request)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}
}

func meHandler(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteJSON(
		response,
		http.StatusOK,
		serializeUser(coreauth.MustUser(request.Context())),
	)
}

func serializeUser(user coreauth.User) userResource {
	return userResource{
		ID:        user.ID,
		Email:     user.Email,
		Name:      user.Name,
		AvatarURL: user.AvatarURL,
		Role:      user.Role,
		CreatedAt: user.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt: user.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func decodeLogin(
	response http.ResponseWriter,
	request *http.Request,
	target *loginBody,
) bool {
	request.Body = http.MaxBytesReader(response, request.Body, maxLoginBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			httpapi.WriteError(
				response,
				request,
				http.StatusRequestEntityTooLarge,
				"PAYLOAD_TOO_LARGE",
				"Request body is too large.",
				nil,
			)
			return false
		}
		var syntaxError *json.SyntaxError
		if errors.As(err, &syntaxError) || errors.Is(err, io.EOF) {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"Request body must be valid JSON.",
				nil,
			)
			return false
		}
		httpapi.WriteError(
			response,
			request,
			http.StatusUnprocessableEntity,
			"VALIDATION_FAILED",
			"The request is invalid.",
			httpapi.ValidationDetails{Fields: []httpapi.FieldError{{
				Path:    "/",
				Code:    "invalid_type",
				Message: "The request body contains an unknown field or invalid value.",
			}}},
		)
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		httpapi.WriteError(
			response,
			request,
			http.StatusBadRequest,
			"INVALID_REQUEST",
			"Request body must contain one JSON value.",
			nil,
		)
		return false
	}
	return true
}

func validEmail(value string) bool {
	if value == "" || utf8.RuneCountInString(value) > 320 {
		return false
	}
	address, err := mail.ParseAddress(value)
	return err == nil && address.Address == value && strings.Contains(value, "@")
}

func forwardedIP(value string) *string {
	first, _, _ := strings.Cut(value, ",")
	return boundedHeader(strings.TrimSpace(first), 255)
}

func boundedHeader(value string, maximum int) *string {
	if value == "" {
		return nil
	}
	if len(value) > maximum {
		value = value[:maximum]
	}
	return &value
}

func writeLoginValidation(
	response http.ResponseWriter,
	request *http.Request,
	message string,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnprocessableEntity,
		"VALIDATION_FAILED",
		"The request is invalid.",
		httpapi.ValidationDetails{Fields: []httpapi.FieldError{{
			Path:    "/email",
			Code:    "invalid_string",
			Message: message,
		}}},
	)
}

func writeAuthUnauthenticated(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnauthorized,
		"UNAUTHENTICATED",
		"Authentication required.",
		nil,
	)
}

func writeAuthInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusInternalServerError,
		"INTERNAL",
		"Internal server error.",
		nil,
	)
}
