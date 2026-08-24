package identityhandler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

func TestPersonalTokenCreateIsStrictOneTimeAndNoStore(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	userID := uuid.MustParse("10000000-0000-4000-8000-000000000001")
	tokenID := uuid.MustParse("20000000-0000-4000-8000-000000000002")
	api := &fakeAPI{
		tokenIssue: identity.PersonalTokenIssue{
			Token: identity.PersonalToken{
				ID:        tokenID,
				Name:      "automation",
				Prefix:    "berry_pat_public",
				CreatedAt: now,
			},
			Secret: "berry_pat_public_abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
		},
	}
	handler, bearer := identityTestHandler(t, api, now, userID)

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/tokens",
		strings.NewReader(`{"name":"automation"}`),
	)
	request.Header.Set("Authorization", "Bearer "+bearer)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "identity-test-key-0001")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("token issuance response is cacheable")
	}
	var body personalTokenIssueResource
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Token == nil || *body.Token != api.tokenIssue.Secret {
		t.Fatalf("one-time token = %#v", body.Token)
	}
	if api.createdTokenName != "automation" || api.createdTokenKey == "" {
		t.Fatalf(
			"service input name=%q key=%q",
			api.createdTokenName,
			api.createdTokenKey,
		)
	}

	request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/tokens",
		strings.NewReader(`{"name":"automation","scope":"admin"}`),
	)
	request.Header.Set("Authorization", "Bearer "+bearer)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "identity-test-key-0002")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown-field status=%d body=%s", response.Code, response.Body)
	}
}

func TestWorkspaceBoundaryHidesExistence(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	userID := uuid.MustParse("30000000-0000-4000-8000-000000000003")
	workspaceID := uuid.MustParse("40000000-0000-4000-8000-000000000004")
	api := &fakeAPI{workspaceError: identity.ErrNotFound}
	handler, bearer := identityTestHandler(t, api, now, userID)
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/workspaces/"+workspaceID.String(),
		nil,
	)
	request.Header.Set("Authorization", "Bearer "+bearer)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var envelope httpapi.ErrorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if envelope.Error.Code != "NOT_FOUND" {
		t.Fatalf("error code=%q, want NOT_FOUND", envelope.Error.Code)
	}
}

func TestIdentityRouteSurfaceRequiresAuthentication(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	handler, _ := identityTestHandler(t, &fakeAPI{}, now, uuid.New())
	workspaceID := "10000000-0000-4000-8000-000000000001"
	memberID := "20000000-0000-4000-8000-000000000002"
	invitationID := "30000000-0000-4000-8000-000000000003"
	tokenID := "40000000-0000-4000-8000-000000000004"
	routes := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/me"},
		{http.MethodPatch, "/api/v1/me"},
		{http.MethodGet, "/api/v1/me/bootstrap"},
		{http.MethodGet, "/api/v1/me/onboarding"},
		{http.MethodPatch, "/api/v1/me/onboarding"},
		{http.MethodGet, "/api/v1/me/settings"},
		{http.MethodPatch, "/api/v1/me/settings"},
		{http.MethodGet, "/api/v1/workspaces"},
		{http.MethodPost, "/api/v1/workspaces"},
		{http.MethodGet, "/api/v1/workspaces/" + workspaceID},
		{http.MethodPatch, "/api/v1/workspaces/" + workspaceID},
		{http.MethodDelete, "/api/v1/workspaces/" + workspaceID},
		{http.MethodPost, "/api/v1/workspaces/" + workspaceID + "/select"},
		{http.MethodGet, "/api/v1/workspaces/" + workspaceID + "/settings"},
		{http.MethodPatch, "/api/v1/workspaces/" + workspaceID + "/settings"},
		{http.MethodGet, "/api/v1/workspaces/" + workspaceID + "/members"},
		{
			http.MethodPatch,
			"/api/v1/workspaces/" + workspaceID + "/members/" + memberID,
		},
		{
			http.MethodDelete,
			"/api/v1/workspaces/" + workspaceID + "/members/" + memberID,
		},
		{http.MethodGet, "/api/v1/workspaces/" + workspaceID + "/invitations"},
		{http.MethodPost, "/api/v1/workspaces/" + workspaceID + "/invitations"},
		{
			http.MethodDelete,
			"/api/v1/workspaces/" + workspaceID + "/invitations/" + invitationID,
		},
		{http.MethodGet, "/api/v1/invitations"},
		{http.MethodPost, "/api/v1/invitations/" + invitationID + "/accept"},
		{http.MethodGet, "/api/v1/tokens"},
		{http.MethodPost, "/api/v1/tokens"},
		{http.MethodDelete, "/api/v1/tokens/" + tokenID},
	}
	for _, route := range routes {
		request := httptest.NewRequest(route.method, route.path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Errorf(
				"%s %s status=%d body=%s",
				route.method,
				route.path,
				response.Code,
				response.Body,
			)
		}
	}
}

func identityTestHandler(
	t *testing.T,
	api API,
	now time.Time,
	userID uuid.UUID,
) (http.Handler, string) {
	t.Helper()
	bearer, err := auth.GenerateToken(bytes.NewReader(bytes.Repeat([]byte{0x51}, 32)))
	if err != nil {
		t.Fatalf("GenerateToken() error = %v", err)
	}
	resolver := testResolver{user: auth.User{
		ID:        userID,
		Email:     "member@berry.test",
		Name:      "Member",
		Role:      auth.RoleMember,
		CreatedAt: now,
		UpdatedAt: now,
	}}
	mounts, err := NewMounts(Options{
		Authenticator: resolver,
		Service:       api,
		Clock:         func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewMounts() error = %v", err)
	}
	var registry httpapi.Registry
	for _, mount := range mounts {
		if err := registry.Register(mount); err != nil {
			t.Fatalf("register mount: %v", err)
		}
	}
	return registry.Handler(httpapi.Options{}), bearer
}

type testResolver struct {
	user auth.User
}

func (resolver testResolver) ResolveSession(context.Context, string) (auth.User, error) {
	return resolver.user, nil
}

type fakeAPI struct {
	tokenIssue       identity.PersonalTokenIssue
	createdTokenName string
	createdTokenKey  string
	workspaceError   error
}

func (api *fakeAPI) Bootstrap(context.Context, uuid.UUID) (identity.Bootstrap, error) {
	return identity.Bootstrap{}, nil
}
func (api *fakeAPI) GetProfile(context.Context, uuid.UUID) (identity.Profile, error) {
	return identity.Profile{}, nil
}
func (api *fakeAPI) UpdateProfile(
	context.Context,
	uuid.UUID,
	identity.ProfilePatch,
) (identity.Profile, error) {
	return identity.Profile{}, nil
}
func (api *fakeAPI) UpdateUserSettings(
	context.Context,
	uuid.UUID,
	identity.UserSettingsPatch,
) (identity.UserSettings, error) {
	return identity.UserSettings{}, nil
}
func (api *fakeAPI) UpdateOnboarding(
	context.Context,
	uuid.UUID,
	identity.OnboardingState,
) (identity.OnboardingState, *time.Time, error) {
	return identity.OnboardingState{}, nil, nil
}
func (api *fakeAPI) ListWorkspaces(
	context.Context,
	uuid.UUID,
	*identity.TimeCursor,
	int,
) ([]identity.Workspace, error) {
	return nil, nil
}
func (api *fakeAPI) CreateWorkspace(
	context.Context,
	uuid.UUID,
	string,
	string,
	*string,
	string,
	[sha256.Size]byte,
) (identity.Workspace, bool, error) {
	return identity.Workspace{}, false, nil
}
func (api *fakeAPI) GetWorkspace(
	context.Context,
	uuid.UUID,
	uuid.UUID,
) (identity.Workspace, error) {
	return identity.Workspace{}, api.workspaceError
}
func (api *fakeAPI) UpdateWorkspace(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.WorkspacePatch,
) (identity.Workspace, error) {
	return identity.Workspace{}, nil
}
func (api *fakeAPI) DeleteWorkspace(context.Context, uuid.UUID, uuid.UUID) error {
	return nil
}
func (api *fakeAPI) SelectWorkspace(context.Context, uuid.UUID, uuid.UUID) error {
	return nil
}
func (api *fakeAPI) UpdateWorkspaceSettings(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.WorkspaceSettingsPatch,
) (identity.WorkspaceSettings, error) {
	return identity.WorkspaceSettings{}, nil
}
func (api *fakeAPI) ListMembers(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	*identity.NameCursor,
	int,
) ([]identity.Membership, error) {
	return nil, nil
}
func (api *fakeAPI) UpdateMemberRole(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
	identity.Role,
) (identity.Membership, error) {
	return identity.Membership{}, nil
}
func (api *fakeAPI) RemoveMember(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
) error {
	return nil
}
func (api *fakeAPI) CreateInvitation(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	string,
	identity.Role,
	time.Time,
	string,
	[sha256.Size]byte,
) (identity.InvitationIssue, error) {
	return identity.InvitationIssue{}, nil
}
func (api *fakeAPI) ListWorkspaceInvitations(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	*identity.TimeCursor,
	int,
) ([]identity.Invitation, error) {
	return nil, nil
}
func (api *fakeAPI) RevokeInvitation(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
) error {
	return nil
}
func (api *fakeAPI) ListPersonalInvitations(
	context.Context,
	uuid.UUID,
	*identity.TimeCursor,
	int,
) ([]identity.Invitation, error) {
	return nil, nil
}
func (api *fakeAPI) AcceptInvitation(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	string,
) (identity.Membership, error) {
	return identity.Membership{}, nil
}
func (api *fakeAPI) CreatePersonalToken(
	_ context.Context,
	_ uuid.UUID,
	name string,
	_ *time.Time,
	key string,
	_ [sha256.Size]byte,
) (identity.PersonalTokenIssue, error) {
	api.createdTokenName = name
	api.createdTokenKey = key
	return api.tokenIssue, nil
}
func (api *fakeAPI) ListPersonalTokens(
	context.Context,
	uuid.UUID,
	*identity.TimeCursor,
	int,
) ([]identity.PersonalToken, error) {
	return nil, nil
}
func (api *fakeAPI) RevokePersonalToken(
	context.Context,
	uuid.UUID,
	uuid.UUID,
) error {
	return nil
}
