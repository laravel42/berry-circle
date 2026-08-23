// Package p2 applies workspace authorization and P2 product rules over the
// durable repository. It contains no process-global state.
package p2

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/identity"
	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
)

type Authorizer interface {
	AuthorizeWorkspace(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Role, error)
}

type ProjectTargetValidator interface {
	ProjectExists(context.Context, uuid.UUID, uuid.UUID) (bool, error)
}

type Store interface {
	ListSavedViews(context.Context, uuid.UUID, uuid.UUID, *p2repo.SavedViewCursor, int) ([]p2repo.SavedView, error)
	CreateSavedView(context.Context, p2repo.CreateSavedViewParams) (p2repo.SavedView, error)
	GetSavedView(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (p2repo.SavedView, error)
	UpdateSavedView(context.Context, p2repo.UpdateSavedViewParams) (p2repo.SavedView, error)
	DeleteSavedView(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
	GetViewPreference(context.Context, uuid.UUID, uuid.UUID) (p2repo.ViewPreference, error)
	PutViewPreference(context.Context, uuid.UUID, uuid.UUID, *uuid.UUID, json.RawMessage, time.Time) (p2repo.ViewPreference, error)
	ListPins(context.Context, uuid.UUID, uuid.UUID) ([]p2repo.Pin, error)
	CreatePin(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, string, uuid.UUID, time.Time) (p2repo.Pin, bool, error)
	ReorderPins(context.Context, uuid.UUID, uuid.UUID, []uuid.UUID) error
	DeletePin(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
	IssuePinTargetExists(context.Context, uuid.UUID, uuid.UUID) (bool, error)
	ViewPinTargetExists(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (bool, error)
	ListInbox(context.Context, uuid.UUID, uuid.UUID, p2repo.InboxFilter) ([]p2repo.InboxItem, error)
	CountUnreadInbox(context.Context, uuid.UUID, uuid.UUID) (int64, error)
	UpdateInboxItem(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, string, time.Time) (p2repo.InboxItem, error)
	BulkUpdateInbox(context.Context, uuid.UUID, uuid.UUID, []uuid.UUID, string, time.Time) ([]uuid.UUID, error)
	GetNotificationPreferences(context.Context, uuid.UUID, uuid.UUID) (p2repo.NotificationPreferences, error)
	PutNotificationPreferences(context.Context, uuid.UUID, uuid.UUID, json.RawMessage, time.Time) (p2repo.NotificationPreferences, error)
	Search(context.Context, uuid.UUID, p2repo.SearchFilter) ([]p2repo.SearchResult, error)
	ListIssueGroups(context.Context, uuid.UUID, p2repo.IssueFilter, string, *p2repo.IssueGroupCursor, int) ([]p2repo.IssueGroup, error)
	ListIssueRows(context.Context, uuid.UUID, p2repo.IssueFilter, string, string, *p2repo.IssueRowCursor, int) ([]p2repo.IssueRow, error)
	ListIssueFacets(context.Context, uuid.UUID, p2repo.IssueFilter) ([]p2repo.FacetCount, error)
	BatchUpdateIssues(context.Context, uuid.UUID, []uuid.UUID, p2repo.BatchIssuePatch, time.Time) ([]p2repo.BatchResult, error)
	BatchDeleteIssues(context.Context, uuid.UUID, []uuid.UUID) ([]p2repo.BatchResult, error)
}

type Options struct {
	Store         Store
	Authorization Authorizer
	Projects      ProjectTargetValidator
	Clock         func() time.Time
	NewID         func() uuid.UUID
}

type Service struct {
	store         Store
	authorization Authorizer
	projects      ProjectTargetValidator
	clock         func() time.Time
	newID         func() uuid.UUID
}

func New(options Options) (*Service, error) {
	switch {
	case options.Store == nil:
		return nil, errors.New("p2 service store is nil")
	case options.Authorization == nil:
		return nil, errors.New("p2 service authorizer is nil")
	case options.Clock == nil:
		return nil, errors.New("p2 service clock is nil")
	case options.NewID == nil:
		return nil, errors.New("p2 service ID generator is nil")
	}
	return &Service{
		store:         options.Store,
		authorization: options.Authorization,
		projects:      options.Projects,
		clock:         options.Clock,
		newID:         options.NewID,
	}, nil
}

func (service *Service) authorize(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	permission identity.Permission,
) error {
	_, err := service.authorization.AuthorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		permission,
	)
	return err
}

func (service *Service) ListSavedViews(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	after *p2repo.SavedViewCursor,
	limit int,
) ([]p2repo.SavedView, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return nil, err
	}
	return service.store.ListSavedViews(ctx, workspaceID, userID, after, limit)
}

func (service *Service) CreateSavedView(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	name, visibility string,
	definitionVersion int,
	query, display json.RawMessage,
) (p2repo.SavedView, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionWrite); err != nil {
		return p2repo.SavedView{}, err
	}
	return service.store.CreateSavedView(ctx, p2repo.CreateSavedViewParams{
		ID:                service.newID(),
		WorkspaceID:       workspaceID,
		OwnerID:           userID,
		Name:              name,
		Visibility:        visibility,
		DefinitionVersion: definitionVersion,
		Query:             query,
		Display:           display,
		CreatedAt:         service.clock().UTC(),
	})
}

func (service *Service) GetSavedView(
	ctx context.Context,
	userID, workspaceID, viewID uuid.UUID,
) (p2repo.SavedView, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return p2repo.SavedView{}, err
	}
	return service.store.GetSavedView(ctx, workspaceID, userID, viewID)
}

func (service *Service) UpdateSavedView(
	ctx context.Context,
	userID, workspaceID, viewID uuid.UUID,
	name, visibility *string,
	query, display json.RawMessage,
	expectedRevision int,
) (p2repo.SavedView, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionWrite); err != nil {
		return p2repo.SavedView{}, err
	}
	return service.store.UpdateSavedView(ctx, p2repo.UpdateSavedViewParams{
		ID:               viewID,
		WorkspaceID:      workspaceID,
		ActorID:          userID,
		Name:             name,
		Visibility:       visibility,
		Query:            query,
		Display:          display,
		ExpectedRevision: expectedRevision,
		UpdatedAt:        service.clock().UTC(),
	})
}

func (service *Service) DeleteSavedView(
	ctx context.Context,
	userID, workspaceID, viewID uuid.UUID,
) error {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionWrite); err != nil {
		return err
	}
	return service.store.DeleteSavedView(ctx, workspaceID, userID, viewID)
}

func (service *Service) GetViewPreference(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
) (p2repo.ViewPreference, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return p2repo.ViewPreference{}, err
	}
	return service.store.GetViewPreference(ctx, workspaceID, userID)
}

func (service *Service) PutViewPreference(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	activeView *uuid.UUID,
	preferences json.RawMessage,
) (p2repo.ViewPreference, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return p2repo.ViewPreference{}, err
	}
	return service.store.PutViewPreference(
		ctx,
		workspaceID,
		userID,
		activeView,
		preferences,
		service.clock().UTC(),
	)
}

func (service *Service) ListPins(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
) ([]p2repo.Pin, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return nil, err
	}
	return service.store.ListPins(ctx, workspaceID, userID)
}

func (service *Service) CreatePin(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	targetType string,
	targetID uuid.UUID,
) (p2repo.Pin, bool, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return p2repo.Pin{}, false, err
	}
	var (
		exists bool
		err    error
	)
	switch targetType {
	case "issue":
		exists, err = service.store.IssuePinTargetExists(ctx, workspaceID, targetID)
	case "view":
		exists, err = service.store.ViewPinTargetExists(ctx, workspaceID, userID, targetID)
	case "project":
		if service.projects == nil {
			return p2repo.Pin{}, false, ErrProjectValidationUnavailable
		}
		exists, err = service.projects.ProjectExists(ctx, workspaceID, targetID)
	default:
		return p2repo.Pin{}, false, ErrInvalidTarget
	}
	if err != nil {
		return p2repo.Pin{}, false, err
	}
	if !exists {
		return p2repo.Pin{}, false, p2repo.ErrNotFound
	}
	return service.store.CreatePin(
		ctx,
		service.newID(),
		workspaceID,
		userID,
		targetType,
		targetID,
		service.clock().UTC(),
	)
}

func (service *Service) ReorderPins(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	ids []uuid.UUID,
) error {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return err
	}
	return service.store.ReorderPins(ctx, workspaceID, userID, ids)
}

func (service *Service) DeletePin(
	ctx context.Context,
	userID, workspaceID, pinID uuid.UUID,
) error {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return err
	}
	return service.store.DeletePin(ctx, workspaceID, userID, pinID)
}

func (service *Service) ListInbox(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter p2repo.InboxFilter,
) ([]p2repo.InboxItem, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return nil, err
	}
	return service.store.ListInbox(ctx, workspaceID, userID, filter)
}

func (service *Service) CountUnreadInbox(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
) (int64, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return 0, err
	}
	return service.store.CountUnreadInbox(ctx, workspaceID, userID)
}

func (service *Service) UpdateInboxItem(
	ctx context.Context,
	userID, workspaceID, itemID uuid.UUID,
	action string,
) (p2repo.InboxItem, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return p2repo.InboxItem{}, err
	}
	return service.store.UpdateInboxItem(
		ctx,
		workspaceID,
		userID,
		itemID,
		action,
		service.clock().UTC(),
	)
}

func (service *Service) BulkUpdateInbox(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	ids []uuid.UUID,
	action string,
) ([]uuid.UUID, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return nil, err
	}
	return service.store.BulkUpdateInbox(
		ctx,
		workspaceID,
		userID,
		ids,
		action,
		service.clock().UTC(),
	)
}

func (service *Service) GetNotificationPreferences(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
) (p2repo.NotificationPreferences, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return p2repo.NotificationPreferences{}, err
	}
	return service.store.GetNotificationPreferences(ctx, workspaceID, userID)
}

func (service *Service) PutNotificationPreferences(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	preferences json.RawMessage,
) (p2repo.NotificationPreferences, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return p2repo.NotificationPreferences{}, err
	}
	return service.store.PutNotificationPreferences(
		ctx,
		workspaceID,
		userID,
		preferences,
		service.clock().UTC(),
	)
}

func (service *Service) Search(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter p2repo.SearchFilter,
) ([]p2repo.SearchResult, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return nil, err
	}
	return service.store.Search(ctx, workspaceID, filter)
}

func (service *Service) ListIssueGroups(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter p2repo.IssueFilter,
	groupBy string,
	after *p2repo.IssueGroupCursor,
	limit int,
) ([]p2repo.IssueGroup, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return nil, err
	}
	filter.UserID = userID
	return service.store.ListIssueGroups(ctx, workspaceID, filter, groupBy, after, limit)
}

func (service *Service) ListIssueRows(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter p2repo.IssueFilter,
	groupBy, groupKey string,
	after *p2repo.IssueRowCursor,
	limit int,
) ([]p2repo.IssueRow, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return nil, err
	}
	filter.UserID = userID
	return service.store.ListIssueRows(
		ctx,
		workspaceID,
		filter,
		groupBy,
		groupKey,
		after,
		limit,
	)
}

func (service *Service) ListIssueFacets(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter p2repo.IssueFilter,
) ([]p2repo.FacetCount, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionRead); err != nil {
		return nil, err
	}
	filter.UserID = userID
	return service.store.ListIssueFacets(ctx, workspaceID, filter)
}

func (service *Service) BatchUpdateIssues(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	ids []uuid.UUID,
	patch p2repo.BatchIssuePatch,
) ([]p2repo.BatchResult, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionWrite); err != nil {
		return nil, err
	}
	return service.store.BatchUpdateIssues(
		ctx,
		workspaceID,
		ids,
		patch,
		service.clock().UTC(),
	)
}

func (service *Service) BatchDeleteIssues(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	ids []uuid.UUID,
) ([]p2repo.BatchResult, error) {
	if err := service.authorize(ctx, userID, workspaceID, identity.PermissionWrite); err != nil {
		return nil, err
	}
	return service.store.BatchDeleteIssues(ctx, workspaceID, ids)
}

var (
	ErrInvalidTarget                = errors.New("invalid pin target type")
	ErrProjectValidationUnavailable = errors.New("project pin validation is unavailable")
)
