// Package integrations exposes Berry's provider connections over HTTP.
//
// Three kinds of route live here and they have different trust models. The
// catalog and connection routes are ordinary authenticated settings endpoints.
// The OAuth callback is reached by a browser returning from a provider, so it
// authenticates on the state token as well as the session. Neither ever returns
// a credential: the response types in this package have no field that could
// hold one.
package integrations

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/oauth"
	repo "github.com/laravel42/berry-circle/server/internal/repository/integrations"
)

// Store is the persistence this package needs, narrowed to what it calls.
type Store interface {
	Connection(ctx context.Context, workspaceID uuid.UUID, provider string) (core.Connection, error)
	ListConnections(ctx context.Context, workspaceID uuid.UUID) ([]core.Connection, error)
	SaveConnection(ctx context.Context, incoming repo.NewConnection, now time.Time) (core.Connection, error)
	Disconnect(ctx context.Context, workspaceID uuid.UUID, provider string, now time.Time) error
	CreateState(ctx context.Context, workspaceID, userID uuid.UUID,
		provider, redirectURI, secret, codeVerifier string, scopes []string, now time.Time) (uuid.UUID, error)
	ConsumeState(ctx context.Context, secret string, now time.Time) (repo.PendingState, error)
	ListGrants(ctx context.Context, workspaceID uuid.UUID) ([]core.Grant, error)
	SetGrant(ctx context.Context, grant core.Grant, now time.Time) error
	RevokeGrant(ctx context.Context, workspaceID uuid.UUID, agentID *uuid.UUID, provider, tool string) error
	RevokeProvider(ctx context.Context, workspaceID uuid.UUID, provider string) error
	ApplyDefaultGrants(ctx context.Context, workspaceID uuid.UUID, provider core.Provider, now time.Time) (int, error)
	ListAudit(ctx context.Context, workspaceID uuid.UUID, limit int) ([]repo.AuditRecord, error)
}

// CredentialStore opens a connection's token for a call Berry makes itself.
//
// Separate from Store because it is the one capability that hands out a secret,
// and keeping it nameable makes every holder of it visible.
type CredentialStore interface {
	Credential(ctx context.Context, workspaceID uuid.UUID, provider string) (repo.Credential, error)
}

// Authorizer is the workspace boundary these routes enforce.
type Authorizer interface {
	AuthorizeWorkspace(
		context.Context, uuid.UUID, uuid.UUID, identity.Permission,
	) (identity.Role, error)
}

// Options is every dependency the integration routes need.
type Options struct {
	Store         Store
	Sessions      auth.SessionResolver
	Authorization Authorizer
	Clock         func() time.Time
	Registry      *core.Registry
	OAuth         oauth.Client
	// Configs holds each provider's client credentials. A provider missing
	// from here, or present but unconfigured, is offered in the catalog and
	// refuses to start a flow.
	Configs map[string]oauth.Config
	// CallbackBaseURL is where providers send the browser back to. This is
	// Berry's own origin: the authorisation code must land on the server that
	// holds the client secret, never in a page.
	// Credentials opens a token for the product's own GitHub calls — the
	// repository picker, and later the run context and pull requests. Agent
	// tool calls do not come through here; those remain MCP's job.
	Credentials CredentialStore

	// GitHubAppSlug builds the app's install link for the repository picker.
	GitHubAppSlug string

	CallbackBaseURL string
	// ReturnAllowlist is where the browser may be sent after a flow finishes.
	// Empty refuses every flow rather than defaulting somewhere convenient.
	ReturnAllowlist []string
	Logger          *slog.Logger
}

// NewMount builds the authenticated integration route subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Store == nil {
		return httpapi.Mount{}, errors.New("integration handler store is nil")
	}
	if options.Sessions == nil {
		return httpapi.Mount{}, errors.New("integration handler session resolver is nil")
	}
	if options.Authorization == nil {
		return httpapi.Mount{}, errors.New("integration handler authorizer is nil")
	}
	if options.Clock == nil {
		return httpapi.Mount{}, errors.New("integration handler clock is nil")
	}
	if options.Registry == nil {
		return httpapi.Mount{}, errors.New("integration handler registry is nil")
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}

	router := httpapi.NewSubrouter()

	// The callback is reached by a browser returning from the provider, which
	// cannot present a bearer token — so it authenticates on the state instead.
	// That is what the state is for: 32 bytes from crypto/rand, stored hashed,
	// single-use, minutes-long, and bound to the workspace and person who
	// started the flow. Requiring a session here as well made the route
	// unreachable by the only client that ever calls it.
	router.Get("/connections/{provider}/callback", callbackHandler(options))

	router.Group(func(authenticated chi.Router) {
		authenticated.Use(auth.RequireSession(options.Sessions))
		authenticated.Get("/providers", listProvidersHandler(options))
		authenticated.Get("/connections", listConnectionsHandler(options))
		authenticated.Post("/connections/{provider}/authorize", authorizeHandler(options))
		authenticated.Delete("/connections/{provider}", disconnectHandler(options))
		authenticated.Get("/grants", listGrantsHandler(options))
		authenticated.Put("/grants", setGrantHandler(options))
		authenticated.Delete("/grants", revokeGrantHandler(options))
		authenticated.Get("/audit", listAuditHandler(options))
		authenticated.Get("/github/repositories", listRepositoriesHandler(options))
	})
	return httpapi.Mount{Prefix: "/api/v1/integrations", Handler: router}, nil
}

// workspaceFor resolves and authorises the caller's workspace.
func workspaceFor(
	response http.ResponseWriter,
	request *http.Request,
	options Options,
	permission identity.Permission,
) (uuid.UUID, uuid.UUID, bool) {
	user := auth.MustUser(request.Context())
	if user.CurrentWorkspaceID == nil {
		httpapi.WriteError(response, request, http.StatusNotFound,
			"NOT_FOUND", "Workspace not found.", nil)
		return uuid.Nil, uuid.Nil, false
	}
	workspaceID := *user.CurrentWorkspaceID
	if _, err := options.Authorization.AuthorizeWorkspace(
		request.Context(), user.ID, workspaceID, permission,
	); err != nil {
		// Deliberately not distinguishing "no such workspace" from "not
		// allowed": telling a caller which one it was maps out the estate.
		httpapi.WriteError(response, request, http.StatusForbidden,
			"FORBIDDEN", "You do not have access to this workspace.", nil)
		return uuid.Nil, uuid.Nil, false
	}
	return workspaceID, user.ID, true
}

// providerFor resolves the {provider} path segment against the registry.
func providerFor(
	response http.ResponseWriter,
	request *http.Request,
	options Options,
) (core.Provider, bool) {
	id := strings.ToLower(strings.TrimSpace(chi.URLParam(request, "provider")))
	provider, ok := options.Registry.Get(id)
	if !ok {
		httpapi.WriteError(response, request, http.StatusNotFound,
			"NOT_FOUND", "Unknown integration provider.", nil)
		return nil, false
	}
	return provider, true
}

type toolResource struct {
	Name             string `json:"name"`
	Description      string `json:"description"`
	Effect           string `json:"effect"`
	RequiresApproval bool   `json:"requiresApproval"`
	EnabledByDefault bool   `json:"enabledByDefault"`
}

type providerResource struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Configured  bool           `json:"configured"`
	Connected   bool           `json:"connected"`
	Status      string         `json:"status,omitempty"`
	AccountName string         `json:"accountName,omitempty"`
	Scopes      []string       `json:"scopes"`
	Tools       []toolResource `json:"tools"`
}

// listProvidersHandler returns the catalog with this workspace's state folded in.
func listProvidersHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, _, ok := workspaceFor(response, request, options, identity.PermissionSettingsRead)
		if !ok {
			return
		}
		connections, err := options.Store.ListConnections(request.Context(), workspaceID)
		if err != nil {
			writeInternal(response, request, options, "list connections", err)
			return
		}
		byProvider := make(map[string]core.Connection, len(connections))
		for _, connection := range connections {
			byProvider[connection.Provider] = connection
		}

		providers := options.Registry.List()
		resources := make([]providerResource, 0, len(providers))
		for _, provider := range providers {
			config, hasConfig := options.Configs[provider.ID()]
			resource := providerResource{
				ID:          provider.ID(),
				Name:        provider.Name(),
				Description: provider.Description(),
				Configured:  hasConfig && config.Configured(),
				Scopes:      provider.Scopes(),
				Tools:       toolResources(provider.Tools()),
			}
			if connection, connected := byProvider[provider.ID()]; connected {
				resource.Connected = true
				resource.Status = string(connection.Status)
				resource.AccountName = connection.ExternalAccountName
			}
			resources = append(resources, resource)
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"providers": resources})
	}
}

func toolResources(tools []core.Tool) []toolResource {
	resources := make([]toolResource, 0, len(tools))
	for _, tool := range tools {
		resources = append(resources, toolResource{
			Name:             tool.Name,
			Description:      tool.Description,
			Effect:           string(tool.Effect),
			RequiresApproval: tool.RequiresApproval,
			EnabledByDefault: tool.EnabledByDefault,
		})
	}
	return resources
}

type connectionResource struct {
	ID           uuid.UUID  `json:"id"`
	Provider     string     `json:"provider"`
	Status       string     `json:"status"`
	StatusDetail string     `json:"statusDetail,omitempty"`
	AccountID    string     `json:"accountId,omitempty"`
	AccountName  string     `json:"accountName,omitempty"`
	Scopes       []string   `json:"scopes"`
	ExpiresAt    *time.Time `json:"expiresAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

func listConnectionsHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, _, ok := workspaceFor(response, request, options, identity.PermissionSettingsRead)
		if !ok {
			return
		}
		connections, err := options.Store.ListConnections(request.Context(), workspaceID)
		if err != nil {
			writeInternal(response, request, options, "list connections", err)
			return
		}
		resources := make([]connectionResource, 0, len(connections))
		for _, connection := range connections {
			resources = append(resources, connectionResource{
				ID:           connection.ID,
				Provider:     connection.Provider,
				Status:       string(connection.Status),
				StatusDetail: connection.StatusDetail,
				AccountID:    connection.ExternalAccountID,
				AccountName:  connection.ExternalAccountName,
				Scopes:       connection.Scopes,
				ExpiresAt:    connection.ExpiresAt,
				CreatedAt:    connection.CreatedAt,
				UpdatedAt:    connection.UpdatedAt,
			})
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"connections": resources})
	}
}

// callbackURL is where the provider must return the browser.
//
// Always Berry's own origin. Pointing this at the frontend would put the
// authorisation code in a page, where it is one redirect or one referrer header
// away from leaving the deployment.
func (options Options) callbackURL(provider string) string {
	base := strings.TrimRight(options.CallbackBaseURL, "/")
	return fmt.Sprintf("%s/api/v1/integrations/connections/%s/callback", base, provider)
}

// authorizeHandler starts a flow and hands the browser somewhere to go.
func authorizeHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, userID, ok := workspaceFor(response, request, options, identity.PermissionSettingsWrite)
		if !ok {
			return
		}
		provider, ok := providerFor(response, request, options)
		if !ok {
			return
		}
		config, configured := options.Configs[provider.ID()]
		if !configured || !config.Configured() {
			httpapi.WriteError(response, request, http.StatusPreconditionFailed,
				"PROVIDER_NOT_CONFIGURED",
				"This deployment has no OAuth credentials for "+provider.Name()+".", nil)
			return
		}
		if len(options.ReturnAllowlist) == 0 || options.CallbackBaseURL == "" {
			httpapi.WriteError(response, request, http.StatusPreconditionFailed,
				"INTEGRATIONS_NOT_CONFIGURED",
				"Integration callback URLs are not configured on this deployment.", nil)
			return
		}

		secret, err := oauth.NewSecret()
		if err != nil {
			writeInternal(response, request, options, "generate state", err)
			return
		}
		var verifier string
		if config.UsePKCE {
			if verifier, err = oauth.NewVerifier(); err != nil {
				writeInternal(response, request, options, "generate verifier", err)
				return
			}
		}

		redirectURI := options.callbackURL(provider.ID())
		authorizeURL, err := options.OAuth.AuthorizeURL(config, secret, redirectURI, verifier)
		if err != nil {
			writeInternal(response, request, options, "build authorize url", err)
			return
		}
		// The state is recorded before the person leaves, so a callback can
		// only be honoured for a flow this server actually started.
		if _, err := options.Store.CreateState(
			request.Context(), workspaceID, userID, provider.ID(),
			redirectURI, secret, verifier, config.Scopes, options.Clock(),
		); err != nil {
			writeInternal(response, request, options, "record state", err)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{
			"authorizeUrl": authorizeURL,
			"provider":     provider.ID(),
		})
	}
}

// callbackHandler completes a flow and returns the browser to the app.
//
// Failures redirect rather than rendering an error, because the person is in a
// browser mid-journey and a JSON body is not an answer. The reason travels as a
// short code: anything longer risks carrying provider detail into a URL that
// ends up in history and referrer headers.
func callbackHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		provider, ok := providerFor(response, request, options)
		if !ok {
			return
		}
		query := request.URL.Query()

		if denied := query.Get("error"); denied != "" {
			options.redirectResult(response, request, provider.ID(), "denied")
			return
		}
		code, state := query.Get("code"), query.Get("state")
		if code == "" || state == "" {
			options.redirectResult(response, request, provider.ID(), "invalid_response")
			return
		}

		pending, err := options.Store.ConsumeState(request.Context(), state, options.Clock())
		switch {
		case errors.Is(err, oauth.ErrStateUnknown), errors.Is(err, oauth.ErrStateUsed):
			options.redirectResult(response, request, provider.ID(), "invalid_state")
			return
		case errors.Is(err, oauth.ErrStateExpired):
			options.redirectResult(response, request, provider.ID(), "expired")
			return
		case err != nil:
			options.logger().Error("consume oauth state", "provider", provider.ID(), "error", err)
			options.redirectResult(response, request, provider.ID(), "server_error")
			return
		}

		// The state carries the workspace and the person; the provider decides
		// which flow this code belongs to. Both must agree, so a state issued
		// for one provider cannot be redeemed against another.
		//
		// There is no session to check here. A browser returning from the
		// provider cannot present a bearer token, and the state is what stands
		// in for one: unguessable, single-use, expiring, and already consumed
		// by the time this runs, so a replay finds nothing to redeem.
		if pending.Provider != provider.ID() {
			options.redirectResult(response, request, provider.ID(), "invalid_state")
			return
		}

		config := options.Configs[provider.ID()]
		result, err := options.OAuth.Exchange(
			request.Context(), config, pending.RedirectURI, code, pending.CodeVerifier,
		)
		if err != nil {
			// The provider's message may quote the request, so it is logged at
			// the server and reduced to a code for the browser.
			options.logger().Error("oauth exchange failed", "provider", provider.ID(), "error", err)
			options.redirectResult(response, request, provider.ID(), "exchange_failed")
			return
		}

		now := options.Clock()
		connection, err := options.Store.SaveConnection(request.Context(), repo.NewConnection{
			WorkspaceID:         pending.WorkspaceID,
			Provider:            provider.ID(),
			ConnectedByUserID:   &pending.UserID,
			ExternalAccountID:   result.Account.ID,
			ExternalAccountName: result.Account.Name,
			AccessToken:         result.AccessToken,
			RefreshToken:        result.RefreshToken,
			ExpiresAt:           result.ExpiresAt,
			Scopes:              result.Scopes,
			Metadata:            result.Account.Metadata,
		}, now)
		if err != nil {
			writeInternalRedirect(options, response, request, provider.ID(), "save connection", err)
			return
		}

		// Default grants are best-effort: the connection is already real, and
		// failing the whole flow over a permission row would leave the person
		// looking at an error for something that succeeded.
		if _, err := options.Store.ApplyDefaultGrants(
			request.Context(), pending.WorkspaceID, provider, now,
		); err != nil {
			options.logger().Error("apply default grants",
				"provider", provider.ID(), "connection", connection.ID, "error", err)
		}

		options.redirectResult(response, request, provider.ID(), "connected")
	}
}

// redirectResult sends the browser back to the app with an outcome.
func (options Options) redirectResult(
	response http.ResponseWriter,
	request *http.Request,
	provider, status string,
) {
	target := options.returnURL()
	if target == "" {
		httpapi.WriteError(response, request, http.StatusPreconditionFailed,
			"INTEGRATIONS_NOT_CONFIGURED",
			"No return URL is configured for integration callbacks.", nil)
		return
	}
	parsed, err := url.Parse(target)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusInternalServerError,
			"INTERNAL", "Something went wrong.", nil)
		return
	}
	query := parsed.Query()
	query.Set("integration", provider)
	query.Set("status", status)
	parsed.RawQuery = query.Encode()
	http.Redirect(response, request, parsed.String(), http.StatusSeeOther)
}

// returnURL is the first allowlisted address. The allowlist is the vetted set,
// so its first entry is a vetted destination by construction.
func (options Options) returnURL() string {
	if len(options.ReturnAllowlist) == 0 {
		return ""
	}
	return options.ReturnAllowlist[0]
}

func disconnectHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, _, ok := workspaceFor(response, request, options, identity.PermissionSettingsWrite)
		if !ok {
			return
		}
		provider, ok := providerFor(response, request, options)
		if !ok {
			return
		}
		now := options.Clock()
		if err := options.Store.Disconnect(request.Context(), workspaceID, provider.ID(), now); err != nil {
			if errors.Is(err, repo.ErrNotFound) {
				httpapi.WriteError(response, request, http.StatusNotFound,
					"NOT_FOUND", "That provider is not connected.", nil)
				return
			}
			writeInternal(response, request, options, "disconnect", err)
			return
		}
		// Grants go with the connection. Leaving them would mean reconnecting a
		// different account silently re-arms permissions nobody reviewed for it.
		if err := options.Store.RevokeProvider(request.Context(), workspaceID, provider.ID()); err != nil {
			writeInternal(response, request, options, "revoke grants", err)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}
}

func (options Options) logger() *slog.Logger {
	if options.Logger != nil {
		return options.Logger
	}
	return slog.Default()
}

func writeInternal(
	response http.ResponseWriter,
	request *http.Request,
	options Options,
	action string,
	err error,
) {
	options.logger().Error("integration route failed", "action", action, "error", err)
	httpapi.WriteError(response, request, http.StatusInternalServerError,
		"INTERNAL", "Something went wrong.", nil)
}

func writeInternalRedirect(
	options Options,
	response http.ResponseWriter,
	request *http.Request,
	provider, action string,
	err error,
) {
	options.logger().Error("integration callback failed", "action", action, "provider", provider, "error", err)
	options.redirectResult(response, request, provider, "server_error")
}
