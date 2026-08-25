package integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/oauth"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
	repo "github.com/laravel42/berry-circle/server/internal/repository/integrations"
)

var (
	testWorkspaceID = uuid.MustParse("10000000-0000-4000-8000-000000000001")
	testUserID      = uuid.MustParse("20000000-0000-4000-8000-000000000002")
	testNow         = time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
)

func token() string { return base64.RawURLEncoding.EncodeToString(make([]byte, 32)) }

type sessions struct{ userID uuid.UUID }

func (s sessions) ResolveSession(context.Context, string) (auth.User, error) {
	workspaceID := testWorkspaceID
	id := s.userID
	if id == uuid.Nil {
		id = testUserID
	}
	return auth.User{ID: id, Role: auth.RoleMember, CurrentWorkspaceID: &workspaceID}, nil
}

type allowAll struct{}

func (allowAll) AuthorizeWorkspace(
	context.Context, uuid.UUID, uuid.UUID, identity.Permission,
) (identity.Role, error) {
	return identity.RoleOwner, nil
}

type denyAll struct{}

func (denyAll) AuthorizeWorkspace(
	context.Context, uuid.UUID, uuid.UUID, identity.Permission,
) (identity.Role, error) {
	return "", errors.New("forbidden")
}

// fakeStore records what the handlers ask of persistence.
type fakeStore struct {
	connections  []core.Connection
	grants       []core.Grant
	audit        []repo.AuditRecord
	saved        *repo.NewConnection
	pending      repo.PendingState
	consumeErr   error
	createdState bool
	defaultsRan  bool
	disconnected string
	revokedAll   string
	setGrants    []core.Grant
	revoked      []core.Grant
}

func (store *fakeStore) Connection(_ context.Context, _ uuid.UUID, provider string) (core.Connection, error) {
	for _, connection := range store.connections {
		if connection.Provider == provider {
			return connection, nil
		}
	}
	return core.Connection{}, core.ErrNoConnection
}

func (store *fakeStore) ListConnections(context.Context, uuid.UUID) ([]core.Connection, error) {
	return store.connections, nil
}

func (store *fakeStore) SaveConnection(
	_ context.Context, incoming repo.NewConnection, _ time.Time,
) (core.Connection, error) {
	store.saved = &incoming
	return core.Connection{
		ID: uuid.New(), WorkspaceID: incoming.WorkspaceID,
		Provider: incoming.Provider, Status: core.StatusConnected,
	}, nil
}

func (store *fakeStore) Disconnect(_ context.Context, _ uuid.UUID, provider string, _ time.Time) error {
	store.disconnected = provider
	return nil
}

func (store *fakeStore) CreateState(
	context.Context, uuid.UUID, uuid.UUID, string, string, string, string, []string, time.Time,
) (uuid.UUID, error) {
	store.createdState = true
	return uuid.New(), nil
}

func (store *fakeStore) ConsumeState(context.Context, string, time.Time) (repo.PendingState, error) {
	if store.consumeErr != nil {
		return repo.PendingState{}, store.consumeErr
	}
	return store.pending, nil
}

func (store *fakeStore) ListGrants(context.Context, uuid.UUID) ([]core.Grant, error) {
	return store.grants, nil
}

func (store *fakeStore) SetGrant(_ context.Context, grant core.Grant, _ time.Time) error {
	store.setGrants = append(store.setGrants, grant)
	return nil
}

func (store *fakeStore) RevokeGrant(
	_ context.Context, workspaceID uuid.UUID, agentID *uuid.UUID, provider, tool string,
) error {
	store.revoked = append(store.revoked, core.Grant{
		WorkspaceID: workspaceID, AgentID: agentID, Provider: provider, Tool: tool,
	})
	return nil
}

func (store *fakeStore) RevokeProvider(_ context.Context, _ uuid.UUID, provider string) error {
	store.revokedAll = provider
	return nil
}

func (store *fakeStore) ApplyDefaultGrants(
	context.Context, uuid.UUID, core.Provider, time.Time,
) (int, error) {
	store.defaultsRan = true
	return 3, nil
}

func (store *fakeStore) ListAudit(context.Context, uuid.UUID, int) ([]repo.AuditRecord, error) {
	return store.audit, nil
}

func registry(t *testing.T) *core.Registry {
	t.Helper()
	reg := core.NewRegistry()
	for _, provider := range providers.All() {
		reg.MustRegister(provider)
	}
	return reg
}

type mountOption func(*Options)

func withAuthorizer(authorizer Authorizer) mountOption {
	return func(options *Options) { options.Authorization = authorizer }
}

func withSessionUser(id uuid.UUID) mountOption {
	return func(options *Options) { options.Sessions = sessions{userID: id} }
}

func withConfigs(configs map[string]oauth.Config) mountOption {
	return func(options *Options) { options.Configs = configs }
}

func mount(t *testing.T, store Store, extra ...mountOption) http.Handler {
	t.Helper()
	options := Options{
		Store:         store,
		Sessions:      sessions{},
		Authorization: allowAll{},
		Clock:         func() time.Time { return testNow },
		Registry:      registry(t),
		OAuth:         oauth.Client{Now: func() time.Time { return testNow }},
		Configs: map[string]oauth.Config{
			"github": {
				Endpoint: oauth.Endpoints()["github"],
				ClientID: "gh-id", ClientSecret: "gh-secret",
				Scopes: []string{"repo"},
			},
		},
		CallbackBaseURL: "https://api.berry.test",
		ReturnAllowlist: []string{"https://app.berry.test/settings/integrations"},
	}
	for _, apply := range extra {
		apply(&options)
	}
	built, err := NewMount(options)
	if err != nil {
		t.Fatalf("NewMount: %v", err)
	}
	return built.Handler
}

func do(t *testing.T, handler http.Handler, method, target string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var request *http.Request
	if body == "" {
		request = httptest.NewRequest(method, target, nil)
	} else {
		request = httptest.NewRequest(method, target, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+token())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decode(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", response.Body.String(), err)
	}
	return body
}

func TestProvidersCatalogNeverExposesCredentials(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	response := do(t, mount(t, store), http.MethodGet, "/providers", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body)
	}
	raw := response.Body.String()
	for _, forbidden := range []string{"gh-secret", "client_secret", "clientSecret", "accessToken"} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("catalog exposed %q", forbidden)
		}
	}

	body := decode(t, response)
	list, _ := body["providers"].([]any)
	if len(list) != 5 {
		t.Fatalf("providers = %d, want 5", len(list))
	}
	var github map[string]any
	for _, entry := range list {
		item, _ := entry.(map[string]any)
		if item["id"] == "github" {
			github = item
		}
	}
	if github == nil {
		t.Fatal("github missing from the catalog")
	}
	// Configured is the operator-facing fact; it must be reported without the
	// credential that makes it true.
	if github["configured"] != true {
		t.Error("github has credentials and should report configured")
	}
	if github["connected"] != false {
		t.Error("github is not connected and should say so")
	}
	// An unconfigured provider is still listed, so settings can show it as
	// available-but-not-set-up rather than silently omitting it.
	for _, entry := range list {
		item, _ := entry.(map[string]any)
		if item["id"] == "slack" && item["configured"] != false {
			t.Error("slack has no credentials and must not report configured")
		}
	}
}

func TestRoutesRefuseCallersWithoutWorkspaceAccess(t *testing.T) {
	t.Parallel()
	handler := mount(t, &fakeStore{}, withAuthorizer(denyAll{}))
	for _, route := range []struct {
		method, target, body string
	}{
		{http.MethodGet, "/providers", ""},
		{http.MethodGet, "/connections", ""},
		{http.MethodPost, "/connections/github/authorize", ""},
		{http.MethodDelete, "/connections/github", ""},
		{http.MethodGet, "/grants", ""},
		{http.MethodGet, "/audit", ""},
	} {
		response := do(t, handler, route.method, route.target, route.body)
		if response.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403", route.method, route.target, response.Code)
		}
	}
}

func TestAuthorizeRefusesProviderWithoutCredentials(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	response := do(t, mount(t, store), http.MethodPost, "/connections/slack/authorize", "")
	if response.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412: %s", response.Code, response.Body)
	}
	if store.createdState {
		t.Error("a state was recorded for a provider that cannot start a flow")
	}
}

func TestAuthorizeRecordsStateAndReturnsProviderURL(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	response := do(t, mount(t, store), http.MethodPost, "/connections/github/authorize", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body)
	}
	if !store.createdState {
		t.Error("the flow started without recording a state")
	}

	body := decode(t, response)
	authorizeURL, _ := body["authorizeUrl"].(string)
	if !strings.HasPrefix(authorizeURL, "https://github.com/login/oauth/authorize?") {
		t.Fatalf("authorizeUrl = %q", authorizeURL)
	}
	// The code must come back to Berry, not to a page: an authorisation code
	// delivered to the frontend is one referrer header from leaving.
	if !strings.Contains(authorizeURL,
		"redirect_uri=https%3A%2F%2Fapi.berry.test%2Fapi%2Fv1%2Fintegrations%2Fconnections%2Fgithub%2Fcallback") {
		t.Errorf("redirect_uri does not point at the API: %q", authorizeURL)
	}
	if strings.Contains(authorizeURL, "gh-secret") {
		t.Fatal("client secret leaked into the authorize URL")
	}
}

func TestAuthorizeRefusesWhenCallbackURLsAreUnconfigured(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	handler := mount(t, store, func(options *Options) {
		options.ReturnAllowlist = nil
	})
	response := do(t, handler, http.MethodPost, "/connections/github/authorize", "")
	if response.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412", response.Code)
	}
}

func TestCallbackRejectsAStateIssuedForAnotherProvider(t *testing.T) {
	t.Parallel()
	// The callback cannot check a session — a browser returning from the
	// provider has no bearer token — so the state is the whole defence. It is
	// unguessable, single-use and bound to a provider, and that binding is what
	// stops a state issued for one flow being spent on another.
	store := &fakeStore{pending: repo.PendingState{
		State: oauth.State{
			ID: uuid.New(), WorkspaceID: testWorkspaceID, UserID: testUserID,
			Provider: "slack", RedirectURI: "https://api.berry.test/cb",
		},
	}}
	handler := mount(t, store)

	response := do(t, handler, http.MethodGet,
		"/connections/github/callback?code=abc&state=xyz", "")
	if response.Code != http.StatusSeeOther {
		t.Fatalf("status = %d, want a redirect", response.Code)
	}
	if got := response.Header().Get("Location"); !strings.Contains(got, "status=invalid_state") {
		t.Errorf("Location = %q, want invalid_state", got)
	}
	if store.saved != nil {
		t.Fatal("a connection was saved from another provider's state")
	}
}

func TestCallbackNeedsNoSessionToComplete(t *testing.T) {
	t.Parallel()
	// The regression this guards: the callback used to sit behind the session
	// middleware, so the only client that ever calls it — a browser following a
	// redirect, carrying no Authorization header — got a 401 and the flow could
	// never finish.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "gho_token"})
	}))
	t.Cleanup(server.Close)

	endpoint := oauth.Endpoints()["github"]
	endpoint.TokenURL = server.URL
	store := &fakeStore{pending: repo.PendingState{
		State: oauth.State{
			ID: uuid.New(), WorkspaceID: testWorkspaceID, UserID: testUserID,
			Provider: "github", RedirectURI: "https://api.berry.test/cb",
		},
	}}
	handler := mount(t, store, withConfigs(map[string]oauth.Config{
		"github": {Endpoint: endpoint, ClientID: "gh-id", ClientSecret: "gh-secret"},
	}))

	// No Authorization header, exactly as a browser would arrive.
	request := httptest.NewRequest(http.MethodGet,
		"/connections/github/callback?code=abc&state=xyz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusSeeOther {
		t.Fatalf("status = %d, want a redirect: %s", response.Code, response.Body)
	}
	if got := response.Header().Get("Location"); !strings.Contains(got, "status=connected") {
		t.Errorf("Location = %q, want connected", got)
	}
	if store.saved == nil {
		t.Fatal("the connection was not saved")
	}
	if store.saved.WorkspaceID != testWorkspaceID {
		t.Errorf("workspace = %s, want the one the state names", store.saved.WorkspaceID)
	}
}

func TestCallbackClassifiesStateFailures(t *testing.T) {
	t.Parallel()
	for _, testCase := range []struct {
		name     string
		err      error
		expected string
	}{
		{"unknown", oauth.ErrStateUnknown, "status=invalid_state"},
		{"replayed", oauth.ErrStateUsed, "status=invalid_state"},
		{"expired", oauth.ErrStateExpired, "status=expired"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			store := &fakeStore{consumeErr: testCase.err}
			response := do(t, mount(t, store), http.MethodGet,
				"/connections/github/callback?code=abc&state=xyz", "")
			if response.Code != http.StatusSeeOther {
				t.Fatalf("status = %d", response.Code)
			}
			if got := response.Header().Get("Location"); !strings.Contains(got, testCase.expected) {
				t.Errorf("Location = %q, want %s", got, testCase.expected)
			}
			if store.saved != nil {
				t.Error("a connection was saved despite an unusable state")
			}
		})
	}
}

func TestCallbackRedirectsWhenTheProviderReportsDenial(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	response := do(t, mount(t, store), http.MethodGet,
		"/connections/github/callback?error=access_denied&state=xyz", "")
	if response.Code != http.StatusSeeOther {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Location"); !strings.Contains(got, "status=denied") {
		t.Errorf("Location = %q", got)
	}
	if store.saved != nil {
		t.Error("a denial produced a connection")
	}
}

func TestDisconnectAlsoRevokesTheProvidersGrants(t *testing.T) {
	t.Parallel()
	store := &fakeStore{connections: []core.Connection{{
		Provider: "github", Status: core.StatusConnected,
	}}}
	response := do(t, mount(t, store), http.MethodDelete, "/connections/github", "")
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d: %s", response.Code, response.Body)
	}
	if store.disconnected != "github" {
		t.Errorf("disconnected = %q", store.disconnected)
	}
	// Reconnecting a different account must not inherit permissions granted
	// for the previous one.
	if store.revokedAll != "github" {
		t.Error("grants survived a disconnect")
	}
}

func TestSetGrantRejectsToolsNoProviderOffers(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	handler := mount(t, store)

	response := do(t, handler, http.MethodPut, "/grants",
		`{"provider":"github","tool":"github.launch_missiles","maxEffect":"read"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", response.Code, response.Body)
	}
	if len(store.setGrants) != 0 {
		t.Fatal("an unknown tool was granted")
	}

	response = do(t, handler, http.MethodPut, "/grants",
		`{"provider":"github","tool":"github.list_issues","maxEffect":"sudo"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid effect status = %d, want 400", response.Code)
	}
	if len(store.setGrants) != 0 {
		t.Fatal("an invalid effect was stored")
	}
}

func TestSetGrantStoresAValidPermission(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	agentID := uuid.New()
	response := do(t, mount(t, store), http.MethodPut, "/grants",
		`{"provider":"github","tool":"github.list_issues","maxEffect":"read","agentId":"`+agentID.String()+`"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body)
	}
	if len(store.setGrants) != 1 {
		t.Fatalf("stored %d grants", len(store.setGrants))
	}
	grant := store.setGrants[0]
	if grant.WorkspaceID != testWorkspaceID {
		t.Errorf("grant workspace = %s, want the caller's", grant.WorkspaceID)
	}
	if grant.AgentID == nil || *grant.AgentID != agentID {
		t.Errorf("grant agent = %v", grant.AgentID)
	}
	if grant.MaxEffect != core.EffectRead {
		t.Errorf("grant effect = %q", grant.MaxEffect)
	}
}

func TestGrantWildcardIsAcceptedWithoutNamingATool(t *testing.T) {
	t.Parallel()
	store := &fakeStore{}
	response := do(t, mount(t, store), http.MethodPut, "/grants",
		`{"provider":"slack","tool":"*","maxEffect":"read"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body)
	}
	if len(store.setGrants) != 1 || store.setGrants[0].Tool != core.Wildcard {
		t.Fatalf("grants = %+v", store.setGrants)
	}
}

func TestAuditListingIsBoundedAndValidated(t *testing.T) {
	t.Parallel()
	store := &fakeStore{audit: []repo.AuditRecord{{
		ID: uuid.New(), Provider: "github", Tool: "github.create_issue",
		Effect: core.EffectWrite, Status: repo.AuditSucceeded, StartedAt: testNow,
	}}}
	handler := mount(t, store)

	response := do(t, handler, http.MethodGet, "/audit", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", response.Code, response.Body)
	}
	events, _ := decode(t, response)["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("events = %d", len(events))
	}
	// error_message is deliberately never selected, so it cannot appear here.
	if strings.Contains(response.Body.String(), "errorMessage") {
		t.Error("the audit listing exposed a raw provider error message")
	}

	if got := do(t, handler, http.MethodGet, "/audit?limit=nonsense", "").Code; got != http.StatusBadRequest {
		t.Errorf("bad limit = %d, want 400", got)
	}
}

func TestUnknownProviderIsNotFound(t *testing.T) {
	t.Parallel()
	handler := mount(t, &fakeStore{})
	if got := do(t, handler, http.MethodPost, "/connections/dropbox/authorize", "").Code; got != http.StatusNotFound {
		t.Errorf("status = %d, want 404", got)
	}
}

func TestCallbackCompletesAFlowAndSealsWhatItStores(t *testing.T) {
	t.Parallel()
	// A stand-in provider, so the happy path is exercised without a registered
	// app or a live credential.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "gho_live_token", "refresh_token": "ghr_live_token",
			"expires_in": float64(3600), "scope": "repo",
		})
	}))
	t.Cleanup(server.Close)

	endpoint := oauth.Endpoints()["github"]
	endpoint.TokenURL = server.URL
	store := &fakeStore{pending: repo.PendingState{
		State: oauth.State{
			ID: uuid.New(), WorkspaceID: testWorkspaceID, UserID: testUserID,
			Provider: "github", RedirectURI: "https://api.berry.test/cb",
		},
	}}
	handler := mount(t, store, withConfigs(map[string]oauth.Config{
		"github": {Endpoint: endpoint, ClientID: "gh-id", ClientSecret: "gh-secret"},
	}))

	response := do(t, handler, http.MethodGet,
		"/connections/github/callback?code=abc&state=xyz", "")
	if response.Code != http.StatusSeeOther {
		t.Fatalf("status = %d: %s", response.Code, response.Body)
	}
	location := response.Header().Get("Location")
	if !strings.HasPrefix(location, "https://app.berry.test/settings/integrations?") ||
		!strings.Contains(location, "status=connected") {
		t.Fatalf("Location = %q", location)
	}
	// The token must never travel back through the browser.
	if strings.Contains(location, "gho_live_token") {
		t.Fatal("an access token was placed in a redirect URL")
	}

	if store.saved == nil {
		t.Fatal("the connection was not saved")
	}
	if store.saved.AccessToken != "gho_live_token" ||
		store.saved.RefreshToken != "ghr_live_token" {
		t.Errorf("saved tokens = %+v", store.saved)
	}
	if store.saved.WorkspaceID != testWorkspaceID {
		t.Errorf("saved workspace = %s, want the state's", store.saved.WorkspaceID)
	}
	if store.saved.ConnectedByUserID == nil || *store.saved.ConnectedByUserID != testUserID {
		t.Errorf("connected-by = %v", store.saved.ConnectedByUserID)
	}
	// Connecting arms the provider's opt-out tools and nothing else.
	if !store.defaultsRan {
		t.Error("default grants were not applied to a new connection")
	}
}
