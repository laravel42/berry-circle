package catalogs

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/identity"
)

func TestValidatePropertyValueEnforcesDefinitionKind(t *testing.T) {
	t.Parallel()
	property := PropertyDefinition{
		Kind: PropertyMultiSelect,
		Config: PropertyConfig{Options: []PropertyOption{
			{ID: "frontend", Name: "Frontend", Color: "#112233"},
			{ID: "backend", Name: "Backend", Color: "#445566"},
		}},
	}
	for _, test := range []struct {
		name  string
		value string
		valid bool
	}{
		{"valid selection", `["frontend","backend"]`, true},
		{"unknown selection", `["frontend","other"]`, false},
		{"duplicate selection", `["frontend","frontend"]`, false},
		{"wrong shape", `"frontend"`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			canonical, err := ValidatePropertyValue(property, json.RawMessage(test.value))
			if test.valid && err != nil {
				t.Fatalf("ValidatePropertyValue() error = %v", err)
			}
			if !test.valid && !errors.Is(err, ErrInvalidValue) {
				t.Fatalf("ValidatePropertyValue() error = %v, want invalid value", err)
			}
			if test.valid && string(canonical) != test.value {
				t.Fatalf("canonical = %s, want %s", canonical, test.value)
			}
		})
	}
}

func TestQuickActionInvocationCannotSerializePrompt(t *testing.T) {
	t.Parallel()
	invocation := QuickActionInvocation{
		ActionID:      uuid.New(),
		WorkspaceID:   uuid.New(),
		IssueID:       uuid.New(),
		TargetAgentID: uuid.New(),
		ActorID:       uuid.New(),
		Prompt:        "hidden server instruction",
	}
	encoded, err := json.Marshal(invocation)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	if strings.Contains(string(encoded), invocation.Prompt) ||
		strings.Contains(string(encoded), "prompt") {
		t.Fatalf("serialized invocation disclosed prompt: %s", encoded)
	}
}

func TestCatalogServiceUsesSettingsAndProductPermissions(t *testing.T) {
	t.Parallel()
	userID, workspaceID := uuid.New(), uuid.New()
	store := &catalogStoreStub{}
	authorization := &catalogAuthorizer{}
	service, err := NewService(ServiceOptions{
		Store:         store,
		Authorization: authorization,
		Clock:         time.Now,
		NewID:         uuid.New,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	if _, err := service.CreateLabel(
		context.Background(),
		userID,
		workspaceID,
		CreateLabelParams{Name: "P2", Color: "#112233"},
	); err != nil {
		t.Fatalf("CreateLabel() error = %v", err)
	}
	if authorization.lastPermission != identity.PermissionSettingsWrite {
		t.Fatalf("CreateLabel permission = %q", authorization.lastPermission)
	}

	if _, err := service.CreateQuickAction(
		context.Background(),
		userID,
		workspaceID,
		CreateQuickActionParams{
			Name:          "Private",
			TargetAgentID: uuid.New(),
			Prompt:        "hidden",
			Visibility:    QuickActionPrivate,
		},
	); err != nil {
		t.Fatalf("CreateQuickAction(private) error = %v", err)
	}
	if authorization.lastPermission != identity.PermissionProductWrite {
		t.Fatalf("private quick-action permission = %q", authorization.lastPermission)
	}

	if _, err := service.CreateQuickAction(
		context.Background(),
		userID,
		workspaceID,
		CreateQuickActionParams{
			Name:          "Workspace",
			TargetAgentID: uuid.New(),
			Prompt:        "hidden",
			Visibility:    QuickActionWorkspace,
		},
	); err != nil {
		t.Fatalf("CreateQuickAction(workspace) error = %v", err)
	}
	if authorization.lastPermission != identity.PermissionSettingsWrite {
		t.Fatalf("workspace quick-action permission = %q", authorization.lastPermission)
	}

	authorization.err = identity.ErrForbidden
	store.labelCreated = false
	if _, err := service.CreateLabel(
		context.Background(),
		userID,
		workspaceID,
		CreateLabelParams{Name: "Denied", Color: "#112233"},
	); !errors.Is(err, identity.ErrForbidden) {
		t.Fatalf("denied CreateLabel() error = %v", err)
	}
	if store.labelCreated {
		t.Fatal("denied label create reached persistence")
	}
}

func TestRenderQuickActionHidesCrossWorkspaceIssue(t *testing.T) {
	t.Parallel()
	userID, workspaceID, otherWorkspace := uuid.New(), uuid.New(), uuid.New()
	store := &catalogStoreStub{
		action: QuickAction{
			ID:            uuid.New(),
			WorkspaceID:   workspaceID,
			Name:          "Review",
			TargetAgentID: uuid.New(),
			Visibility:    QuickActionWorkspace,
			CreatedBy:     userID,
		},
	}
	service, err := NewService(ServiceOptions{
		Store: store,
		Authorization: &catalogAuthorizer{issueScope: identity.Scope{
			WorkspaceID: otherWorkspace,
			Role:        identity.RoleMember,
		}},
		Clock: time.Now,
		NewID: uuid.New,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	_, err = service.RenderQuickAction(
		context.Background(),
		userID,
		workspaceID,
		uuid.New(),
		store.action.ID,
	)
	if !errors.Is(err, identity.ErrNotFound) {
		t.Fatalf("RenderQuickAction() error = %v, want hidden not found", err)
	}
	if store.actionRead {
		t.Fatal("cross-workspace render loaded quick-action metadata")
	}
}

type catalogStoreStub struct {
	Store
	labelCreated bool
	actionRead   bool
	action       QuickAction
}

func (store *catalogStoreStub) CreateLabel(
	_ context.Context,
	params CreateLabelParams,
) (Label, error) {
	store.labelCreated = true
	return Label{
		ID:          params.ID,
		WorkspaceID: params.WorkspaceID,
		Name:        params.Name,
		Color:       params.Color,
	}, nil
}

func (store *catalogStoreStub) CreateQuickAction(
	_ context.Context,
	params CreateQuickActionParams,
) (QuickAction, error) {
	return QuickAction{
		ID:            params.ID,
		WorkspaceID:   params.WorkspaceID,
		Name:          params.Name,
		TargetAgentID: params.TargetAgentID,
		Visibility:    params.Visibility,
		CreatedBy:     params.CreatedBy,
	}, nil
}

func (store *catalogStoreStub) GetQuickAction(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
) (QuickAction, error) {
	store.actionRead = true
	return store.action, nil
}

type catalogAuthorizer struct {
	lastPermission identity.Permission
	err            error
	issueScope     identity.Scope
}

func (authorizer *catalogAuthorizer) AuthorizeWorkspace(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Role, error) {
	authorizer.lastPermission = permission
	return identity.RoleMember, authorizer.err
}

func (authorizer *catalogAuthorizer) AuthorizeIssue(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return authorizer.issueScope, authorizer.err
}
