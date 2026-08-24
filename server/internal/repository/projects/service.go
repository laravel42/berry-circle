package projects

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/identity"
)

// Store is the persistence contract behind the project product service.
type Store interface {
	List(context.Context, uuid.UUID, ListFilter, *Cursor, int) ([]Project, error)
	WorkspaceID(context.Context, uuid.UUID) (uuid.UUID, error)
	Get(context.Context, uuid.UUID, uuid.UUID) (Project, error)
	Create(context.Context, CreateParams) (Project, error)
	Update(context.Context, uuid.UUID, uuid.UUID, Patch, time.Time) (Project, error)
	Archive(context.Context, uuid.UUID, uuid.UUID, time.Time) error
	ListResources(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		*ResourceCursor,
		int,
	) ([]Resource, error)
	CreateResource(context.Context, CreateResourceParams) (Resource, error)
	UpdateResource(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		ResourcePatch,
		time.Time,
	) (Resource, error)
	ArchiveResource(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, time.Time) error
	LinkIssue(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, time.Time) error
	UnlinkIssue(context.Context, uuid.UUID, uuid.UUID) error
	ProjectForIssue(context.Context, uuid.UUID, uuid.UUID) (Project, error)
}

// Authorizer is the narrow identity boundary consumed by this P2 service.
type Authorizer interface {
	AuthorizeWorkspace(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Role, error)
	AuthorizeIssue(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
}

// ServiceOptions make IDs and time deterministic in focused tests.
type ServiceOptions struct {
	Store         Store
	Authorization Authorizer
	Clock         func() time.Time
	NewID         func() uuid.UUID
}

// Service applies workspace authorization before persistence.
type Service struct {
	store         Store
	authorization Authorizer
	clock         func() time.Time
	newID         func() uuid.UUID
}

// NewService rejects missing process dependencies.
func NewService(options ServiceOptions) (*Service, error) {
	if options.Store == nil {
		return nil, errors.New("project service store is nil")
	}
	if options.Authorization == nil {
		return nil, errors.New("project service authorizer is nil")
	}
	if options.Clock == nil {
		return nil, errors.New("project service clock is nil")
	}
	if options.NewID == nil {
		return nil, errors.New("project service ID generator is nil")
	}
	return &Service{
		store:         options.Store,
		authorization: options.Authorization,
		clock:         options.Clock,
		newID:         options.NewID,
	}, nil
}

// List returns only projects in a workspace the actor may read.
func (service *Service) List(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter ListFilter,
	after *Cursor,
	limit int,
) ([]Project, error) {
	if _, err := service.authorization.AuthorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return nil, err
	}
	return service.store.List(ctx, workspaceID, filter, after, limit)
}

// Create permits owner, admin, and member product writers.
func (service *Service) Create(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	input CreateParams,
) (Project, error) {
	if _, err := service.authorization.AuthorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductWrite,
	); err != nil {
		return Project{}, err
	}
	input.ID = service.newID()
	input.WorkspaceID = workspaceID
	input.CreatedBy = userID
	input.CreatedAt = service.clock().UTC()
	return service.store.Create(ctx, input)
}

// Get authorizes through the project's hidden owning workspace.
func (service *Service) Get(
	ctx context.Context,
	userID, projectID uuid.UUID,
) (Project, error) {
	workspaceID, err := service.authorizeProject(
		ctx,
		userID,
		projectID,
		identity.PermissionProductRead,
	)
	if err != nil {
		return Project{}, err
	}
	return mapProjectError(service.store.Get(ctx, workspaceID, projectID))
}

// Update permits owner, admin, and member product writers.
func (service *Service) Update(
	ctx context.Context,
	userID, projectID uuid.UUID,
	patch Patch,
) (Project, error) {
	workspaceID, err := service.authorizeProject(
		ctx,
		userID,
		projectID,
		identity.PermissionProductWrite,
	)
	if err != nil {
		return Project{}, err
	}
	return mapProjectError(service.store.Update(
		ctx,
		workspaceID,
		projectID,
		patch,
		service.clock().UTC(),
	))
}

// Delete requires the owner/admin settings capability because it hides the
// project and all nested resources from ordinary reads.
func (service *Service) Delete(
	ctx context.Context,
	userID, projectID uuid.UUID,
) error {
	workspaceID, err := service.authorizeProject(
		ctx,
		userID,
		projectID,
		identity.PermissionSettingsWrite,
	)
	if err != nil {
		return err
	}
	return mapBoundaryError(service.store.Archive(
		ctx,
		workspaceID,
		projectID,
		service.clock().UTC(),
	))
}

// ListResources applies project read scope before returning nested rows.
func (service *Service) ListResources(
	ctx context.Context,
	userID, projectID uuid.UUID,
	after *ResourceCursor,
	limit int,
) ([]Resource, error) {
	workspaceID, err := service.authorizeProject(
		ctx,
		userID,
		projectID,
		identity.PermissionProductRead,
	)
	if err != nil {
		return nil, err
	}
	return service.store.ListResources(ctx, workspaceID, projectID, after, limit)
}

// CreateResource permits product writers after hidden project authorization.
func (service *Service) CreateResource(
	ctx context.Context,
	userID, projectID uuid.UUID,
	input CreateResourceParams,
) (Resource, error) {
	workspaceID, err := service.authorizeProject(
		ctx,
		userID,
		projectID,
		identity.PermissionProductWrite,
	)
	if err != nil {
		return Resource{}, err
	}
	input.ID = service.newID()
	input.WorkspaceID = workspaceID
	input.ProjectID = projectID
	input.CreatedBy = userID
	input.CreatedAt = service.clock().UTC()
	return mapResourceError(service.store.CreateResource(ctx, input))
}

// UpdateResource permits product writers after hidden project authorization.
func (service *Service) UpdateResource(
	ctx context.Context,
	userID, projectID, resourceID uuid.UUID,
	patch ResourcePatch,
) (Resource, error) {
	workspaceID, err := service.authorizeProject(
		ctx,
		userID,
		projectID,
		identity.PermissionProductWrite,
	)
	if err != nil {
		return Resource{}, err
	}
	return mapResourceError(service.store.UpdateResource(
		ctx,
		workspaceID,
		projectID,
		resourceID,
		patch,
		service.clock().UTC(),
	))
}

// DeleteResource soft-deletes one nested row.
func (service *Service) DeleteResource(
	ctx context.Context,
	userID, projectID, resourceID uuid.UUID,
) error {
	workspaceID, err := service.authorizeProject(
		ctx,
		userID,
		projectID,
		identity.PermissionProductWrite,
	)
	if err != nil {
		return err
	}
	return mapBoundaryError(service.store.ArchiveResource(
		ctx,
		workspaceID,
		projectID,
		resourceID,
		service.clock().UTC(),
	))
}

// LinkIssue is the narrow future issue-handler integration seam.
func (service *Service) LinkIssue(
	ctx context.Context,
	userID, issueID, projectID uuid.UUID,
) error {
	issueScope, err := service.authorization.AuthorizeIssue(
		ctx,
		userID,
		issueID,
		identity.PermissionProductWrite,
	)
	if err != nil {
		return err
	}
	projectWorkspace, err := service.authorizeProject(
		ctx,
		userID,
		projectID,
		identity.PermissionProductWrite,
	)
	if err != nil {
		return err
	}
	if issueScope.WorkspaceID != projectWorkspace {
		return identity.ErrNotFound
	}
	return mapBoundaryError(service.store.LinkIssue(
		ctx,
		issueScope.WorkspaceID,
		issueID,
		projectID,
		userID,
		service.clock().UTC(),
	))
}

// UnlinkIssue removes the relationship without exposing whether it existed.
func (service *Service) UnlinkIssue(
	ctx context.Context,
	userID, issueID uuid.UUID,
) error {
	scope, err := service.authorization.AuthorizeIssue(
		ctx,
		userID,
		issueID,
		identity.PermissionProductWrite,
	)
	if err != nil {
		return err
	}
	return service.store.UnlinkIssue(ctx, scope.WorkspaceID, issueID)
}

// ProjectForIssue resolves an active relationship after issue read scope.
func (service *Service) ProjectForIssue(
	ctx context.Context,
	userID, issueID uuid.UUID,
) (Project, error) {
	scope, err := service.authorization.AuthorizeIssue(
		ctx,
		userID,
		issueID,
		identity.PermissionProductRead,
	)
	if err != nil {
		return Project{}, err
	}
	return mapProjectError(service.store.ProjectForIssue(ctx, scope.WorkspaceID, issueID))
}

func (service *Service) authorizeProject(
	ctx context.Context,
	userID, projectID uuid.UUID,
	permission identity.Permission,
) (uuid.UUID, error) {
	workspaceID, err := service.store.WorkspaceID(ctx, projectID)
	if errors.Is(err, ErrNotFound) {
		return uuid.Nil, identity.ErrNotFound
	}
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := service.authorization.AuthorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		permission,
	); err != nil {
		return uuid.Nil, err
	}
	return workspaceID, nil
}

func mapProjectError(project Project, err error) (Project, error) {
	if errors.Is(err, ErrNotFound) {
		return Project{}, identity.ErrNotFound
	}
	return project, err
}

func mapResourceError(resource Resource, err error) (Resource, error) {
	if errors.Is(err, ErrNotFound) {
		return Resource{}, identity.ErrNotFound
	}
	return resource, err
}

func mapBoundaryError(err error) error {
	if errors.Is(err, ErrNotFound) {
		return identity.ErrNotFound
	}
	return err
}
