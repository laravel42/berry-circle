package catalogs

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/identity"
)

var propertyOptionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// Store is the persistence contract behind the catalog product service.
type Store interface {
	ListLabels(context.Context, uuid.UUID, ListFilter, *TimeCursor, int) ([]Label, error)
	GetLabel(context.Context, uuid.UUID, uuid.UUID) (Label, error)
	CreateLabel(context.Context, CreateLabelParams) (Label, error)
	UpdateLabel(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		LabelPatch,
		time.Time,
	) (Label, error)
	ArchiveLabel(context.Context, uuid.UUID, uuid.UUID, time.Time) error
	ListIssueLabels(context.Context, uuid.UUID, uuid.UUID) ([]Label, error)
	AttachIssueLabel(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) error
	DetachIssueLabel(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error

	ListStatuses(
		context.Context,
		uuid.UUID,
		ListFilter,
		*PositionCursor,
		int,
	) ([]StatusDefinition, error)
	GetStatus(context.Context, uuid.UUID, uuid.UUID) (StatusDefinition, error)
	CreateStatus(context.Context, CreateStatusParams) (StatusDefinition, error)
	UpdateStatus(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		StatusPatch,
		time.Time,
	) (StatusDefinition, error)
	ArchiveStatus(context.Context, uuid.UUID, uuid.UUID, time.Time) error
	ReorderStatuses(context.Context, uuid.UUID, []uuid.UUID, time.Time) error

	ListProperties(
		context.Context,
		uuid.UUID,
		ListFilter,
		*PositionCursor,
		int,
	) ([]PropertyDefinition, error)
	GetProperty(context.Context, uuid.UUID, uuid.UUID) (PropertyDefinition, error)
	CreateProperty(context.Context, CreatePropertyParams) (PropertyDefinition, error)
	UpdateProperty(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		PropertyPatch,
		time.Time,
	) (PropertyDefinition, error)
	ArchiveProperty(context.Context, uuid.UUID, uuid.UUID, time.Time) error
	ListIssuePropertyValues(context.Context, uuid.UUID, uuid.UUID) ([]PropertyValue, error)
	SetIssuePropertyValue(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		json.RawMessage,
		time.Time,
	) (PropertyValue, error)
	ClearIssuePropertyValue(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error

	ListQuickActions(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		ListFilter,
		*TimeCursor,
		int,
	) ([]QuickAction, error)
	GetQuickAction(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (QuickAction, error)
	QuickActionForInvocation(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
	) (QuickAction, string, error)
	CreateQuickAction(context.Context, CreateQuickActionParams) (QuickAction, error)
	UpdateQuickAction(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		QuickActionPatch,
		time.Time,
	) (QuickAction, error)
	ArchiveQuickAction(context.Context, uuid.UUID, uuid.UUID, time.Time) error
}

// Authorizer is the narrow identity boundary consumed by catalogs.
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

// ServiceOptions make catalog IDs and time deterministic.
type ServiceOptions struct {
	Store         Store
	Authorization Authorizer
	Clock         func() time.Time
	NewID         func() uuid.UUID
}

// Service applies role and issue-scope rules before persistence.
type Service struct {
	store         Store
	authorization Authorizer
	clock         func() time.Time
	newID         func() uuid.UUID
}

// NewService rejects missing product dependencies.
func NewService(options ServiceOptions) (*Service, error) {
	if options.Store == nil {
		return nil, errors.New("catalog service store is nil")
	}
	if options.Authorization == nil {
		return nil, errors.New("catalog service authorizer is nil")
	}
	if options.Clock == nil {
		return nil, errors.New("catalog service clock is nil")
	}
	if options.NewID == nil {
		return nil, errors.New("catalog service ID generator is nil")
	}
	return &Service{
		store:         options.Store,
		authorization: options.Authorization,
		clock:         options.Clock,
		newID:         options.NewID,
	}, nil
}

func (service *Service) ListLabels(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter ListFilter,
	after *TimeCursor,
	limit int,
) ([]Label, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return nil, err
	}
	return service.store.ListLabels(ctx, workspaceID, filter, after, limit)
}

func (service *Service) GetLabel(
	ctx context.Context,
	userID, workspaceID, labelID uuid.UUID,
) (Label, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return Label{}, err
	}
	return mapLabelError(service.store.GetLabel(ctx, workspaceID, labelID))
}

func (service *Service) CreateLabel(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	input CreateLabelParams,
) (Label, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return Label{}, err
	}
	input.ID = service.newID()
	input.WorkspaceID = workspaceID
	input.CreatedBy = userID
	input.CreatedAt = service.clock().UTC()
	return service.store.CreateLabel(ctx, input)
}

func (service *Service) UpdateLabel(
	ctx context.Context,
	userID, workspaceID, labelID uuid.UUID,
	patch LabelPatch,
) (Label, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return Label{}, err
	}
	return mapLabelError(service.store.UpdateLabel(
		ctx,
		workspaceID,
		labelID,
		patch,
		service.clock().UTC(),
	))
}

func (service *Service) DeleteLabel(
	ctx context.Context,
	userID, workspaceID, labelID uuid.UUID,
) error {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return err
	}
	return mapCatalogBoundary(service.store.ArchiveLabel(
		ctx,
		workspaceID,
		labelID,
		service.clock().UTC(),
	))
}

// ListIssueLabels is the read seam for later issue-handler integration.
func (service *Service) ListIssueLabels(
	ctx context.Context,
	userID, issueID uuid.UUID,
) ([]Label, error) {
	scope, err := service.authorization.AuthorizeIssue(
		ctx,
		userID,
		issueID,
		identity.PermissionProductRead,
	)
	if err != nil {
		return nil, err
	}
	return service.store.ListIssueLabels(ctx, scope.WorkspaceID, issueID)
}

// AttachIssueLabel is the write seam for later issue-handler integration.
func (service *Service) AttachIssueLabel(
	ctx context.Context,
	userID, issueID, labelID uuid.UUID,
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
	return mapCatalogBoundary(service.store.AttachIssueLabel(
		ctx,
		scope.WorkspaceID,
		issueID,
		labelID,
		userID,
		service.clock().UTC(),
	))
}

// DetachIssueLabel is idempotent after issue write authorization.
func (service *Service) DetachIssueLabel(
	ctx context.Context,
	userID, issueID, labelID uuid.UUID,
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
	return service.store.DetachIssueLabel(ctx, scope.WorkspaceID, issueID, labelID)
}

func (service *Service) ListStatuses(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter ListFilter,
	after *PositionCursor,
	limit int,
) ([]StatusDefinition, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return nil, err
	}
	return service.store.ListStatuses(ctx, workspaceID, filter, after, limit)
}

func (service *Service) GetStatus(
	ctx context.Context,
	userID, workspaceID, statusID uuid.UUID,
) (StatusDefinition, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return StatusDefinition{}, err
	}
	return mapStatusError(service.store.GetStatus(ctx, workspaceID, statusID))
}

func (service *Service) CreateStatus(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	input CreateStatusParams,
) (StatusDefinition, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return StatusDefinition{}, err
	}
	input.ID = service.newID()
	input.WorkspaceID = workspaceID
	input.CreatedBy = userID
	input.CreatedAt = service.clock().UTC()
	return service.store.CreateStatus(ctx, input)
}

func (service *Service) UpdateStatus(
	ctx context.Context,
	userID, workspaceID, statusID uuid.UUID,
	patch StatusPatch,
) (StatusDefinition, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return StatusDefinition{}, err
	}
	return mapStatusError(service.store.UpdateStatus(
		ctx,
		workspaceID,
		statusID,
		patch,
		service.clock().UTC(),
	))
}

func (service *Service) DeleteStatus(
	ctx context.Context,
	userID, workspaceID, statusID uuid.UUID,
) error {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return err
	}
	return mapCatalogBoundary(service.store.ArchiveStatus(
		ctx,
		workspaceID,
		statusID,
		service.clock().UTC(),
	))
}

func (service *Service) ReorderStatuses(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	statusIDs []uuid.UUID,
) error {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return err
	}
	return service.store.ReorderStatuses(ctx, workspaceID, statusIDs, service.clock().UTC())
}

func (service *Service) ListProperties(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter ListFilter,
	after *PositionCursor,
	limit int,
) ([]PropertyDefinition, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return nil, err
	}
	return service.store.ListProperties(ctx, workspaceID, filter, after, limit)
}

func (service *Service) GetProperty(
	ctx context.Context,
	userID, workspaceID, propertyID uuid.UUID,
) (PropertyDefinition, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return PropertyDefinition{}, err
	}
	return mapPropertyError(service.store.GetProperty(ctx, workspaceID, propertyID))
}

func (service *Service) CreateProperty(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	input CreatePropertyParams,
) (PropertyDefinition, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return PropertyDefinition{}, err
	}
	if err := ValidatePropertyConfig(input.Kind, input.Config); err != nil {
		return PropertyDefinition{}, err
	}
	input.ID = service.newID()
	input.WorkspaceID = workspaceID
	input.CreatedBy = userID
	input.CreatedAt = service.clock().UTC()
	return service.store.CreateProperty(ctx, input)
}

func (service *Service) UpdateProperty(
	ctx context.Context,
	userID, workspaceID, propertyID uuid.UUID,
	patch PropertyPatch,
) (PropertyDefinition, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return PropertyDefinition{}, err
	}
	if patch.Config != nil {
		existing, err := service.store.GetProperty(ctx, workspaceID, propertyID)
		if errors.Is(err, ErrNotFound) {
			return PropertyDefinition{}, identity.ErrNotFound
		}
		if err != nil {
			return PropertyDefinition{}, err
		}
		if err := ValidatePropertyConfig(existing.Kind, *patch.Config); err != nil {
			return PropertyDefinition{}, err
		}
		if !configPreservesOptionIDs(existing.Config, *patch.Config) {
			return PropertyDefinition{}, ErrConflict
		}
	}
	return mapPropertyError(service.store.UpdateProperty(
		ctx,
		workspaceID,
		propertyID,
		patch,
		service.clock().UTC(),
	))
}

func (service *Service) DeleteProperty(
	ctx context.Context,
	userID, workspaceID, propertyID uuid.UUID,
) error {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionSettingsWrite,
	); err != nil {
		return err
	}
	return mapCatalogBoundary(service.store.ArchiveProperty(
		ctx,
		workspaceID,
		propertyID,
		service.clock().UTC(),
	))
}

// ListIssuePropertyValues is the typed issue read seam.
func (service *Service) ListIssuePropertyValues(
	ctx context.Context,
	userID, issueID uuid.UUID,
) ([]PropertyValue, error) {
	scope, err := service.authorization.AuthorizeIssue(
		ctx,
		userID,
		issueID,
		identity.PermissionProductRead,
	)
	if err != nil {
		return nil, err
	}
	return service.store.ListIssuePropertyValues(ctx, scope.WorkspaceID, issueID)
}

// SetIssuePropertyValue validates and canonicalizes JSON before persistence.
func (service *Service) SetIssuePropertyValue(
	ctx context.Context,
	userID, issueID, propertyID uuid.UUID,
	value json.RawMessage,
) (PropertyValue, error) {
	scope, err := service.authorization.AuthorizeIssue(
		ctx,
		userID,
		issueID,
		identity.PermissionProductWrite,
	)
	if err != nil {
		return PropertyValue{}, err
	}
	property, err := service.store.GetProperty(ctx, scope.WorkspaceID, propertyID)
	if errors.Is(err, ErrNotFound) || (err == nil && property.ArchivedAt != nil) {
		return PropertyValue{}, identity.ErrNotFound
	}
	if err != nil {
		return PropertyValue{}, err
	}
	canonical, err := ValidatePropertyValue(property, value)
	if err != nil {
		return PropertyValue{}, err
	}
	result, err := service.store.SetIssuePropertyValue(
		ctx,
		scope.WorkspaceID,
		issueID,
		propertyID,
		userID,
		canonical,
		service.clock().UTC(),
	)
	if errors.Is(err, ErrNotFound) {
		return PropertyValue{}, identity.ErrNotFound
	}
	return result, err
}

// ClearIssuePropertyValue is idempotent after issue write authorization.
func (service *Service) ClearIssuePropertyValue(
	ctx context.Context,
	userID, issueID, propertyID uuid.UUID,
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
	return service.store.ClearIssuePropertyValue(
		ctx,
		scope.WorkspaceID,
		issueID,
		propertyID,
	)
}

func (service *Service) ListQuickActions(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	filter ListFilter,
	after *TimeCursor,
	limit int,
) ([]QuickAction, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return nil, err
	}
	return service.store.ListQuickActions(ctx, workspaceID, userID, filter, after, limit)
}

func (service *Service) GetQuickAction(
	ctx context.Context,
	userID, workspaceID, actionID uuid.UUID,
) (QuickAction, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return QuickAction{}, err
	}
	return mapQuickActionError(service.store.GetQuickAction(
		ctx,
		workspaceID,
		actionID,
		userID,
	))
}

func (service *Service) CreateQuickAction(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	input CreateQuickActionParams,
) (QuickAction, error) {
	permission := identity.PermissionProductWrite
	if input.Visibility == QuickActionWorkspace {
		permission = identity.PermissionSettingsWrite
	}
	if err := service.authorizeWorkspace(ctx, userID, workspaceID, permission); err != nil {
		return QuickAction{}, err
	}
	input.ID = service.newID()
	input.WorkspaceID = workspaceID
	input.CreatedBy = userID
	input.CreatedAt = service.clock().UTC()
	return service.store.CreateQuickAction(ctx, input)
}

func (service *Service) UpdateQuickAction(
	ctx context.Context,
	userID, workspaceID, actionID uuid.UUID,
	patch QuickActionPatch,
) (QuickAction, error) {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return QuickAction{}, err
	}
	existing, err := service.store.GetQuickAction(ctx, workspaceID, actionID, userID)
	if errors.Is(err, ErrNotFound) {
		return QuickAction{}, identity.ErrNotFound
	}
	if err != nil {
		return QuickAction{}, err
	}
	nextVisibility := existing.Visibility
	if patch.Visibility != nil {
		nextVisibility = *patch.Visibility
	}
	permission := identity.PermissionProductWrite
	if existing.Visibility == QuickActionWorkspace ||
		nextVisibility == QuickActionWorkspace {
		permission = identity.PermissionSettingsWrite
	}
	if err := service.authorizeWorkspace(ctx, userID, workspaceID, permission); err != nil {
		return QuickAction{}, err
	}
	return mapQuickActionError(service.store.UpdateQuickAction(
		ctx,
		workspaceID,
		actionID,
		patch,
		service.clock().UTC(),
	))
}

func (service *Service) DeleteQuickAction(
	ctx context.Context,
	userID, workspaceID, actionID uuid.UUID,
) error {
	if err := service.authorizeWorkspace(
		ctx,
		userID,
		workspaceID,
		identity.PermissionProductRead,
	); err != nil {
		return err
	}
	existing, err := service.store.GetQuickAction(ctx, workspaceID, actionID, userID)
	if errors.Is(err, ErrNotFound) {
		return identity.ErrNotFound
	}
	if err != nil {
		return err
	}
	permission := identity.PermissionProductWrite
	if existing.Visibility == QuickActionWorkspace {
		permission = identity.PermissionSettingsWrite
	}
	if err := service.authorizeWorkspace(ctx, userID, workspaceID, permission); err != nil {
		return err
	}
	return mapCatalogBoundary(service.store.ArchiveQuickAction(
		ctx,
		workspaceID,
		actionID,
		service.clock().UTC(),
	))
}

// RenderQuickAction returns safe metadata and never loads the hidden prompt.
func (service *Service) RenderQuickAction(
	ctx context.Context,
	userID, workspaceID, issueID, actionID uuid.UUID,
) (QuickActionRender, error) {
	scope, err := service.authorization.AuthorizeIssue(
		ctx,
		userID,
		issueID,
		identity.PermissionProductRead,
	)
	if err != nil {
		return QuickActionRender{}, err
	}
	if scope.WorkspaceID != workspaceID {
		return QuickActionRender{}, identity.ErrNotFound
	}
	action, err := service.store.GetQuickAction(ctx, workspaceID, actionID, userID)
	if errors.Is(err, ErrNotFound) || (err == nil && action.ArchivedAt != nil) {
		return QuickActionRender{}, identity.ErrNotFound
	}
	if err != nil {
		return QuickActionRender{}, err
	}
	return QuickActionRender{
		ActionID:      action.ID,
		IssueID:       issueID,
		Name:          action.Name,
		Description:   action.Description,
		TargetAgentID: action.TargetAgentID,
		Ready:         true,
	}, nil
}

// AuthorizeQuickActionRun validates dispatch scope without loading the prompt.
func (service *Service) AuthorizeQuickActionRun(
	ctx context.Context,
	userID, workspaceID, issueID, actionID uuid.UUID,
) (QuickActionRender, error) {
	scope, err := service.authorization.AuthorizeIssue(
		ctx,
		userID,
		issueID,
		identity.PermissionRunsDispatch,
	)
	if err != nil {
		return QuickActionRender{}, err
	}
	if scope.WorkspaceID != workspaceID {
		return QuickActionRender{}, identity.ErrNotFound
	}
	action, err := service.store.GetQuickAction(ctx, workspaceID, actionID, userID)
	if errors.Is(err, ErrNotFound) || (err == nil && action.ArchivedAt != nil) {
		return QuickActionRender{}, identity.ErrNotFound
	}
	if err != nil {
		return QuickActionRender{}, err
	}
	return QuickActionRender{
		ActionID:      action.ID,
		IssueID:       issueID,
		Name:          action.Name,
		Description:   action.Description,
		TargetAgentID: action.TargetAgentID,
		Ready:         true,
	}, nil
}

// PrepareQuickActionInvocation is the only seam that reads the prompt.
func (service *Service) PrepareQuickActionInvocation(
	ctx context.Context,
	userID, workspaceID, issueID, actionID uuid.UUID,
) (QuickActionInvocation, error) {
	if _, err := service.AuthorizeQuickActionRun(
		ctx,
		userID,
		workspaceID,
		issueID,
		actionID,
	); err != nil {
		return QuickActionInvocation{}, err
	}
	action, prompt, err := service.store.QuickActionForInvocation(
		ctx,
		workspaceID,
		actionID,
		userID,
	)
	if errors.Is(err, ErrNotFound) {
		return QuickActionInvocation{}, identity.ErrNotFound
	}
	if err != nil {
		return QuickActionInvocation{}, err
	}
	return QuickActionInvocation{
		ActionID:      action.ID,
		WorkspaceID:   workspaceID,
		IssueID:       issueID,
		TargetAgentID: action.TargetAgentID,
		ActorID:       userID,
		Prompt:        prompt,
	}, nil
}

func (service *Service) authorizeWorkspace(
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

// ValidatePropertyConfig enforces bounded, stable select options.
func ValidatePropertyConfig(kind PropertyKind, config PropertyConfig) error {
	if !kind.Valid() {
		return ErrInvalidValue
	}
	if kind != PropertySelect && kind != PropertyMultiSelect {
		if len(config.Options) != 0 {
			return ErrInvalidValue
		}
		return nil
	}
	if len(config.Options) < 1 || len(config.Options) > 100 {
		return ErrInvalidValue
	}
	seen := make(map[string]struct{}, len(config.Options))
	for _, option := range config.Options {
		if !propertyOptionIDPattern.MatchString(option.ID) ||
			utf8.RuneCountInString(strings.TrimSpace(option.Name)) < 1 ||
			utf8.RuneCountInString(strings.TrimSpace(option.Name)) > 100 ||
			!validColor(option.Color) {
			return ErrInvalidValue
		}
		if _, duplicate := seen[option.ID]; duplicate {
			return ErrInvalidValue
		}
		seen[option.ID] = struct{}{}
	}
	return nil
}

// ValidatePropertyValue returns canonical JSON for one definition.
func ValidatePropertyValue(
	property PropertyDefinition,
	raw json.RawMessage,
) (json.RawMessage, error) {
	if !json.Valid(raw) {
		return nil, ErrInvalidValue
	}
	var canonical json.RawMessage
	switch property.Kind {
	case PropertyText:
		var value string
		if err := json.Unmarshal(raw, &value); err != nil ||
			utf8.RuneCountInString(value) > 10000 {
			return nil, ErrInvalidValue
		}
		canonical, _ = json.Marshal(value)
	case PropertyNumber:
		var value json.Number
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, ErrInvalidValue
		}
		number, err := value.Float64()
		if err != nil || math.IsInf(number, 0) || math.IsNaN(number) {
			return nil, ErrInvalidValue
		}
		canonical = json.RawMessage(value.String())
	case PropertyBoolean:
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, ErrInvalidValue
		}
		canonical, _ = json.Marshal(value)
	case PropertyDate:
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, ErrInvalidValue
		}
		parsed, err := time.Parse("2006-01-02", value)
		if err != nil || parsed.Format("2006-01-02") != value {
			return nil, ErrInvalidValue
		}
		canonical, _ = json.Marshal(value)
	case PropertyURL:
		var value string
		if err := json.Unmarshal(raw, &value); err != nil ||
			!validExternalURL(value) {
			return nil, ErrInvalidValue
		}
		canonical, _ = json.Marshal(value)
	case PropertySelect:
		var value string
		if err := json.Unmarshal(raw, &value); err != nil ||
			!optionExists(property.Config, value) {
			return nil, ErrInvalidValue
		}
		canonical, _ = json.Marshal(value)
	case PropertyMultiSelect:
		var values []string
		if err := json.Unmarshal(raw, &values); err != nil || len(values) > 50 {
			return nil, ErrInvalidValue
		}
		seen := make(map[string]struct{}, len(values))
		for _, value := range values {
			if !optionExists(property.Config, value) {
				return nil, ErrInvalidValue
			}
			if _, duplicate := seen[value]; duplicate {
				return nil, ErrInvalidValue
			}
			seen[value] = struct{}{}
		}
		canonical, _ = json.Marshal(values)
	default:
		return nil, ErrInvalidValue
	}
	if len(canonical) > 16384 {
		return nil, ErrInvalidValue
	}
	return canonical, nil
}

func configPreservesOptionIDs(previous, next PropertyConfig) bool {
	if len(previous.Options) == 0 {
		return true
	}
	nextIDs := make(map[string]struct{}, len(next.Options))
	for _, option := range next.Options {
		nextIDs[option.ID] = struct{}{}
	}
	for _, option := range previous.Options {
		if _, retained := nextIDs[option.ID]; !retained {
			return false
		}
	}
	return true
}

func optionExists(config PropertyConfig, id string) bool {
	for _, option := range config.Options {
		if option.ID == id {
			return true
		}
	}
	return false
}

func validColor(color string) bool {
	if len(color) != 7 || color[0] != '#' {
		return false
	}
	for _, character := range color[1:] {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func validExternalURL(value string) bool {
	if len(value) < 1 || len(value) > 2048 {
		return false
	}
	parsed, err := url.ParseRequestURI(value)
	return err == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != "" &&
		parsed.User == nil
}

func mapLabelError(label Label, err error) (Label, error) {
	if errors.Is(err, ErrNotFound) {
		return Label{}, identity.ErrNotFound
	}
	return label, err
}

func mapStatusError(status StatusDefinition, err error) (StatusDefinition, error) {
	if errors.Is(err, ErrNotFound) {
		return StatusDefinition{}, identity.ErrNotFound
	}
	return status, err
}

func mapPropertyError(
	property PropertyDefinition,
	err error,
) (PropertyDefinition, error) {
	if errors.Is(err, ErrNotFound) {
		return PropertyDefinition{}, identity.ErrNotFound
	}
	return property, err
}

func mapQuickActionError(action QuickAction, err error) (QuickAction, error) {
	if errors.Is(err, ErrNotFound) {
		return QuickAction{}, identity.ErrNotFound
	}
	return action, err
}

func mapCatalogBoundary(err error) error {
	if errors.Is(err, ErrNotFound) {
		return identity.ErrNotFound
	}
	return err
}
