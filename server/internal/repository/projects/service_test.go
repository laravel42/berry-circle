package projects

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/identity"
)

func TestServiceUsesExplicitProjectPermissions(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 16, 0, 0, 0, time.UTC)
	userID, workspaceID, projectID := uuid.New(), uuid.New(), uuid.New()
	store := &projectStoreStub{
		projectWorkspace: workspaceID,
		project: Project{
			ID:          projectID,
			WorkspaceID: workspaceID,
			Name:        "P2",
		},
	}
	authorization := &projectAuthorizer{}
	service, err := NewService(ServiceOptions{
		Store:         store,
		Authorization: authorization,
		Clock:         func() time.Time { return now },
		NewID:         uuid.New,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	if _, err := service.Get(context.Background(), userID, projectID); err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if authorization.lastPermission != identity.PermissionProductRead {
		t.Fatalf("Get permission = %q", authorization.lastPermission)
	}

	if err := service.Delete(context.Background(), userID, projectID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if authorization.lastPermission != identity.PermissionSettingsWrite {
		t.Fatalf("Delete permission = %q", authorization.lastPermission)
	}

	authorization.err = identity.ErrForbidden
	store.createCalled = false
	if _, err := service.Create(
		context.Background(),
		userID,
		workspaceID,
		CreateParams{Name: "Forbidden", Status: StatusPlanned, Priority: PriorityNone},
	); !errors.Is(err, identity.ErrForbidden) {
		t.Fatalf("Create() error = %v, want forbidden", err)
	}
	if store.createCalled {
		t.Fatal("Create reached persistence after authorization failure")
	}
}

func TestServiceHidesCrossWorkspaceIssueProjectLink(t *testing.T) {
	t.Parallel()
	userID, issueID, projectID := uuid.New(), uuid.New(), uuid.New()
	issueWorkspace, projectWorkspace := uuid.New(), uuid.New()
	store := &projectStoreStub{projectWorkspace: projectWorkspace}
	authorization := &projectAuthorizer{
		issueScope: identity.Scope{
			WorkspaceID: issueWorkspace,
			Role:        identity.RoleMember,
		},
	}
	service, err := NewService(ServiceOptions{
		Store:         store,
		Authorization: authorization,
		Clock:         time.Now,
		NewID:         uuid.New,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	err = service.LinkIssue(context.Background(), userID, issueID, projectID)
	if !errors.Is(err, identity.ErrNotFound) {
		t.Fatalf("LinkIssue() error = %v, want hidden not found", err)
	}
	if store.linkCalled {
		t.Fatal("cross-workspace link reached persistence")
	}
}

type projectStoreStub struct {
	Store
	projectWorkspace uuid.UUID
	project          Project
	createCalled     bool
	linkCalled       bool
}

func (store *projectStoreStub) WorkspaceID(
	context.Context,
	uuid.UUID,
) (uuid.UUID, error) {
	return store.projectWorkspace, nil
}

func (store *projectStoreStub) Get(
	context.Context,
	uuid.UUID,
	uuid.UUID,
) (Project, error) {
	return store.project, nil
}

func (store *projectStoreStub) Create(
	_ context.Context,
	params CreateParams,
) (Project, error) {
	store.createCalled = true
	return Project{ID: params.ID, WorkspaceID: params.WorkspaceID, Name: params.Name}, nil
}

func (store *projectStoreStub) Archive(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	time.Time,
) error {
	return nil
}

func (store *projectStoreStub) LinkIssue(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
	time.Time,
) error {
	store.linkCalled = true
	return nil
}

type projectAuthorizer struct {
	lastPermission identity.Permission
	err            error
	issueScope     identity.Scope
}

func (authorizer *projectAuthorizer) AuthorizeWorkspace(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Role, error) {
	authorizer.lastPermission = permission
	return identity.RoleMember, authorizer.err
}

func (authorizer *projectAuthorizer) AuthorizeIssue(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return authorizer.issueScope, authorizer.err
}
