package catalogs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const propertyProjection = `
	property.id,
	property.workspace_id,
	property.name,
	property.description,
	property.kind,
	property.config,
	property.icon,
	property.sort_order,
	property.created_by,
	property.created_at,
	property.updated_at,
	property.archived_at`

const quickActionProjection = `
	action.id,
	action.workspace_id,
	action.name,
	action.description,
	action.target_agent_id,
	action.visibility,
	action.created_by,
	action.created_at,
	action.updated_at,
	action.archived_at`

// ListProperties returns ordered property definitions.
func (repository *Repository) ListProperties(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter ListFilter,
	after *PositionCursor,
	limit int,
) ([]PropertyDefinition, error) {
	var afterOrder *int
	var afterID *uuid.UUID
	if after != nil {
		afterOrder = &after.SortOrder
		afterID = &after.ID
	}
	rows, err := repository.pool.Query(
		ctx,
		`SELECT `+propertyProjection+`
		   FROM issue_property_definitions AS property
		  WHERE property.workspace_id = $1
		    AND ($2::boolean OR property.archived_at IS NULL)
		    AND (
		        $3::text = ''
		        OR property.name ILIKE ('%' || $3 || '%') ESCAPE '\'
		        OR COALESCE(property.description, '') ILIKE ('%' || $3 || '%') ESCAPE '\'
		    )
		    AND (
		        $4::integer IS NULL
		        OR (property.sort_order, property.id) > ($4, $5::uuid)
		    )
		  ORDER BY property.sort_order, property.id
		  LIMIT $6`,
		workspaceID,
		filter.IncludeArchived,
		escapeCatalogLike(filter.Query),
		afterOrder,
		afterID,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list issue properties: %w", err)
	}
	defer rows.Close()
	result := make([]PropertyDefinition, 0, limit)
	for rows.Next() {
		property, err := scanPropertyRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan issue property list: %w", err)
		}
		result = append(result, property)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate issue properties: %w", err)
	}
	return result, nil
}

// GetProperty hides definitions outside the supplied workspace.
func (repository *Repository) GetProperty(
	ctx context.Context,
	workspaceID, propertyID uuid.UUID,
) (PropertyDefinition, error) {
	property, err := scanPropertyRow(repository.pool.QueryRow(
		ctx,
		`SELECT `+propertyProjection+`
		   FROM issue_property_definitions AS property
		  WHERE property.workspace_id = $1 AND property.id = $2`,
		workspaceID,
		propertyID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return PropertyDefinition{}, ErrNotFound
	}
	if err != nil {
		return PropertyDefinition{}, fmt.Errorf("get issue property: %w", err)
	}
	return property, nil
}

// CreateProperty inserts one typed custom-field definition.
func (repository *Repository) CreateProperty(
	ctx context.Context,
	params CreatePropertyParams,
) (PropertyDefinition, error) {
	config, err := json.Marshal(params.Config)
	if err != nil {
		return PropertyDefinition{}, errors.New("encode issue property config")
	}
	property, err := scanPropertyRow(repository.pool.QueryRow(
		ctx,
		`INSERT INTO issue_property_definitions AS property (
		    id,
		    workspace_id,
		    name,
		    description,
		    kind,
		    config,
		    icon,
		    sort_order,
		    created_by,
		    created_at,
		    updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $10)
		 RETURNING `+propertyProjection,
		params.ID,
		params.WorkspaceID,
		params.Name,
		params.Description,
		propertyKindToDatabase(params.Kind),
		config,
		params.Icon,
		params.SortOrder,
		params.CreatedBy,
		params.CreatedAt,
	))
	if err != nil {
		return PropertyDefinition{}, classifyCatalogWrite("create issue property", err)
	}
	return property, nil
}

// UpdateProperty preserves the immutable kind.
func (repository *Repository) UpdateProperty(
	ctx context.Context,
	workspaceID, propertyID uuid.UUID,
	patch PropertyPatch,
	updatedAt time.Time,
) (PropertyDefinition, error) {
	var config []byte
	var err error
	if patch.Config != nil {
		config, err = json.Marshal(*patch.Config)
		if err != nil {
			return PropertyDefinition{}, errors.New("encode issue property config")
		}
	}
	property, err := scanPropertyRow(repository.pool.QueryRow(
		ctx,
		`UPDATE issue_property_definitions AS property
		    SET name = CASE WHEN $3 THEN $4::text ELSE property.name END,
		        description = CASE WHEN $5 THEN $6::text ELSE property.description END,
		        config = CASE WHEN $7 THEN $8::jsonb ELSE property.config END,
		        icon = CASE WHEN $9 THEN $10::text ELSE property.icon END,
		        sort_order = CASE WHEN $11 THEN $12::integer ELSE property.sort_order END,
		        updated_at = $13
		  WHERE property.workspace_id = $1
		    AND property.id = $2
		    AND property.archived_at IS NULL
		  RETURNING `+propertyProjection,
		workspaceID,
		propertyID,
		patch.Name != nil,
		patch.Name,
		patch.DescriptionSet,
		patch.Description,
		patch.Config != nil,
		config,
		patch.IconSet,
		patch.Icon,
		patch.SortOrder != nil,
		patch.SortOrder,
		updatedAt,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return PropertyDefinition{}, ErrNotFound
	}
	if err != nil {
		return PropertyDefinition{}, classifyCatalogWrite("update issue property", err)
	}
	return property, nil
}

// ArchiveProperty keeps historical values resolvable.
func (repository *Repository) ArchiveProperty(
	ctx context.Context,
	workspaceID, propertyID uuid.UUID,
	archivedAt time.Time,
) error {
	tag, err := repository.pool.Exec(
		ctx,
		`UPDATE issue_property_definitions
		    SET archived_at = $3, updated_at = $3
		  WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL`,
		workspaceID,
		propertyID,
		archivedAt,
	)
	if err != nil {
		return fmt.Errorf("archive issue property: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// ListIssuePropertyValues is the narrow issue-handler read seam.
func (repository *Repository) ListIssuePropertyValues(
	ctx context.Context,
	workspaceID, issueID uuid.UUID,
) ([]PropertyValue, error) {
	rows, err := repository.pool.Query(
		ctx,
		`SELECT
		    workspace_id,
		    issue_id,
		    property_id,
		    value,
		    updated_by,
		    created_at,
		    updated_at
		   FROM issue_property_values
		  WHERE workspace_id = $1 AND issue_id = $2
		  ORDER BY property_id`,
		workspaceID,
		issueID,
	)
	if err != nil {
		return nil, fmt.Errorf("list issue property values: %w", err)
	}
	defer rows.Close()
	result := make([]PropertyValue, 0)
	for rows.Next() {
		value, err := scanPropertyValueRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan issue property value: %w", err)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate issue property values: %w", err)
	}
	return result, nil
}

// SetIssuePropertyValue upserts an already validated JSON value. Database
// triggers repeat the type and workspace checks for defense in depth.
func (repository *Repository) SetIssuePropertyValue(
	ctx context.Context,
	workspaceID, issueID, propertyID, actorID uuid.UUID,
	value json.RawMessage,
	updatedAt time.Time,
) (PropertyValue, error) {
	result, err := scanPropertyValueRow(repository.pool.QueryRow(
		ctx,
		`INSERT INTO issue_property_values AS property_value (
		    workspace_id,
		    issue_id,
		    property_id,
		    value,
		    updated_by,
		    created_at,
		    updated_at
		 ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)
		 ON CONFLICT (workspace_id, issue_id, property_id) DO UPDATE
		     SET value = EXCLUDED.value,
		         updated_by = EXCLUDED.updated_by,
		         updated_at = EXCLUDED.updated_at
		 RETURNING
		    property_value.workspace_id,
		    property_value.issue_id,
		    property_value.property_id,
		    property_value.value,
		    property_value.updated_by,
		    property_value.created_at,
		    property_value.updated_at`,
		workspaceID,
		issueID,
		propertyID,
		value,
		actorID,
		updatedAt,
	))
	if err != nil {
		return PropertyValue{}, classifyCatalogWrite("set issue property value", err)
	}
	return result, nil
}

// ClearIssuePropertyValue is idempotent after issue authorization.
func (repository *Repository) ClearIssuePropertyValue(
	ctx context.Context,
	workspaceID, issueID, propertyID uuid.UUID,
) error {
	_, err := repository.pool.Exec(
		ctx,
		`DELETE FROM issue_property_values
		  WHERE workspace_id = $1 AND issue_id = $2 AND property_id = $3`,
		workspaceID,
		issueID,
		propertyID,
	)
	if err != nil {
		return fmt.Errorf("clear issue property value: %w", err)
	}
	return nil
}

// ListQuickActions returns safe metadata and enforces private visibility in SQL.
func (repository *Repository) ListQuickActions(
	ctx context.Context,
	workspaceID, viewerID uuid.UUID,
	filter ListFilter,
	after *TimeCursor,
	limit int,
) ([]QuickAction, error) {
	var afterTime *time.Time
	var afterID *uuid.UUID
	if after != nil {
		afterTime = &after.UpdatedAt
		afterID = &after.ID
	}
	rows, err := repository.pool.Query(
		ctx,
		`SELECT `+quickActionProjection+`
		   FROM quick_action_definitions AS action
		  WHERE action.workspace_id = $1
		    AND (action.visibility = 'workspace' OR action.created_by = $2)
		    AND ($3::boolean OR action.archived_at IS NULL)
		    AND (
		        $4::text = ''
		        OR action.name ILIKE ('%' || $4 || '%') ESCAPE '\'
		        OR COALESCE(action.description, '') ILIKE ('%' || $4 || '%') ESCAPE '\'
		    )
		    AND (
		        $5::timestamptz IS NULL
		        OR (action.updated_at, action.id) < ($5, $6::uuid)
		    )
		  ORDER BY action.updated_at DESC, action.id DESC
		  LIMIT $7`,
		workspaceID,
		viewerID,
		filter.IncludeArchived,
		escapeCatalogLike(filter.Query),
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list quick actions: %w", err)
	}
	defer rows.Close()
	result := make([]QuickAction, 0, limit)
	for rows.Next() {
		action, err := scanQuickActionRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan quick action list: %w", err)
		}
		result = append(result, action)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate quick actions: %w", err)
	}
	return result, nil
}

// GetQuickAction returns safe metadata only when visible to viewer.
func (repository *Repository) GetQuickAction(
	ctx context.Context,
	workspaceID, actionID, viewerID uuid.UUID,
) (QuickAction, error) {
	action, err := scanQuickActionRow(repository.pool.QueryRow(
		ctx,
		`SELECT `+quickActionProjection+`
		   FROM quick_action_definitions AS action
		  WHERE action.workspace_id = $1
		    AND action.id = $2
		    AND (action.visibility = 'workspace' OR action.created_by = $3)`,
		workspaceID,
		actionID,
		viewerID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return QuickAction{}, ErrNotFound
	}
	if err != nil {
		return QuickAction{}, fmt.Errorf("get quick action: %w", err)
	}
	return action, nil
}

// QuickActionForInvocation returns hidden prompt only through the server-only
// execution seam; callers cannot JSON-encode it.
func (repository *Repository) QuickActionForInvocation(
	ctx context.Context,
	workspaceID, actionID, viewerID uuid.UUID,
) (QuickAction, string, error) {
	var (
		action QuickAction
		prompt string
	)
	err := repository.pool.QueryRow(
		ctx,
		`SELECT
		    action.id,
		    action.workspace_id,
		    action.name,
		    action.description,
		    action.target_agent_id,
		    action.visibility,
		    action.created_by,
		    action.created_at,
		    action.updated_at,
		    action.archived_at,
		    action.prompt
		   FROM quick_action_definitions AS action
		  WHERE action.workspace_id = $1
		    AND action.id = $2
		    AND action.archived_at IS NULL
		    AND (action.visibility = 'workspace' OR action.created_by = $3)`,
		workspaceID,
		actionID,
		viewerID,
	).Scan(
		&action.ID,
		&action.WorkspaceID,
		&action.Name,
		&action.Description,
		&action.TargetAgentID,
		&action.Visibility,
		&action.CreatedBy,
		&action.CreatedAt,
		&action.UpdatedAt,
		&action.ArchivedAt,
		&prompt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return QuickAction{}, "", ErrNotFound
	}
	if err != nil {
		return QuickAction{}, "", fmt.Errorf("get quick action invocation: %w", err)
	}
	return action, prompt, nil
}

// CreateQuickAction stores the prompt without returning it.
func (repository *Repository) CreateQuickAction(
	ctx context.Context,
	params CreateQuickActionParams,
) (QuickAction, error) {
	action, err := scanQuickActionRow(repository.pool.QueryRow(
		ctx,
		`INSERT INTO quick_action_definitions AS action (
		    id,
		    workspace_id,
		    name,
		    description,
		    target_agent_id,
		    prompt,
		    visibility,
		    created_by,
		    created_at,
		    updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
		 RETURNING `+quickActionProjection,
		params.ID,
		params.WorkspaceID,
		params.Name,
		params.Description,
		params.TargetAgentID,
		params.Prompt,
		params.Visibility,
		params.CreatedBy,
		params.CreatedAt,
	))
	if err != nil {
		return QuickAction{}, classifyCatalogWrite("create quick action", err)
	}
	return action, nil
}

// UpdateQuickAction may replace the hidden prompt but never returns it.
func (repository *Repository) UpdateQuickAction(
	ctx context.Context,
	workspaceID, actionID uuid.UUID,
	patch QuickActionPatch,
	updatedAt time.Time,
) (QuickAction, error) {
	action, err := scanQuickActionRow(repository.pool.QueryRow(
		ctx,
		`UPDATE quick_action_definitions AS action
		    SET name = CASE WHEN $3 THEN $4::text ELSE action.name END,
		        description = CASE WHEN $5 THEN $6::text ELSE action.description END,
		        target_agent_id =
		            CASE WHEN $7 THEN $8::uuid ELSE action.target_agent_id END,
		        prompt = CASE WHEN $9 THEN $10::text ELSE action.prompt END,
		        visibility = CASE WHEN $11 THEN $12::text ELSE action.visibility END,
		        updated_at = $13
		  WHERE action.workspace_id = $1
		    AND action.id = $2
		    AND action.archived_at IS NULL
		  RETURNING `+quickActionProjection,
		workspaceID,
		actionID,
		patch.Name != nil,
		patch.Name,
		patch.DescriptionSet,
		patch.Description,
		patch.TargetAgentID != nil,
		patch.TargetAgentID,
		patch.Prompt != nil,
		patch.Prompt,
		patch.Visibility != nil,
		patch.Visibility,
		updatedAt,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return QuickAction{}, ErrNotFound
	}
	if err != nil {
		return QuickAction{}, classifyCatalogWrite("update quick action", err)
	}
	return action, nil
}

// ArchiveQuickAction keeps historical references resolvable.
func (repository *Repository) ArchiveQuickAction(
	ctx context.Context,
	workspaceID, actionID uuid.UUID,
	archivedAt time.Time,
) error {
	tag, err := repository.pool.Exec(
		ctx,
		`UPDATE quick_action_definitions
		    SET archived_at = $3, updated_at = $3
		  WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL`,
		workspaceID,
		actionID,
		archivedAt,
	)
	if err != nil {
		return fmt.Errorf("archive quick action: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func scanPropertyRow(row pgx.Row) (PropertyDefinition, error) {
	var (
		property PropertyDefinition
		kind     string
		config   []byte
	)
	err := row.Scan(
		&property.ID,
		&property.WorkspaceID,
		&property.Name,
		&property.Description,
		&kind,
		&config,
		&property.Icon,
		&property.SortOrder,
		&property.CreatedBy,
		&property.CreatedAt,
		&property.UpdatedAt,
		&property.ArchivedAt,
	)
	if err != nil {
		return PropertyDefinition{}, err
	}
	return decodeProperty(property, kind, config)
}

func scanPropertyRows(rows pgx.Rows) (PropertyDefinition, error) {
	var (
		property PropertyDefinition
		kind     string
		config   []byte
	)
	err := rows.Scan(
		&property.ID,
		&property.WorkspaceID,
		&property.Name,
		&property.Description,
		&kind,
		&config,
		&property.Icon,
		&property.SortOrder,
		&property.CreatedBy,
		&property.CreatedAt,
		&property.UpdatedAt,
		&property.ArchivedAt,
	)
	if err != nil {
		return PropertyDefinition{}, err
	}
	return decodeProperty(property, kind, config)
}

func decodeProperty(
	property PropertyDefinition,
	kind string,
	config []byte,
) (PropertyDefinition, error) {
	property.Kind = propertyKindFromDatabase(kind)
	if !property.Kind.Valid() {
		return PropertyDefinition{}, errors.New("database returned an invalid property kind")
	}
	if err := json.Unmarshal(config, &property.Config); err != nil {
		return PropertyDefinition{}, errors.New("decode issue property config")
	}
	if property.Config.Options == nil {
		property.Config.Options = []PropertyOption{}
	}
	return property, nil
}

func scanPropertyValueRow(row pgx.Row) (PropertyValue, error) {
	var (
		value   PropertyValue
		encoded []byte
	)
	err := row.Scan(
		&value.WorkspaceID,
		&value.IssueID,
		&value.PropertyID,
		&encoded,
		&value.UpdatedBy,
		&value.CreatedAt,
		&value.UpdatedAt,
	)
	value.Value = append(json.RawMessage(nil), encoded...)
	return value, err
}

func scanPropertyValueRows(rows pgx.Rows) (PropertyValue, error) {
	var (
		value   PropertyValue
		encoded []byte
	)
	err := rows.Scan(
		&value.WorkspaceID,
		&value.IssueID,
		&value.PropertyID,
		&encoded,
		&value.UpdatedBy,
		&value.CreatedAt,
		&value.UpdatedAt,
	)
	value.Value = append(json.RawMessage(nil), encoded...)
	return value, err
}

func scanQuickActionRow(row pgx.Row) (QuickAction, error) {
	var action QuickAction
	err := row.Scan(
		&action.ID,
		&action.WorkspaceID,
		&action.Name,
		&action.Description,
		&action.TargetAgentID,
		&action.Visibility,
		&action.CreatedBy,
		&action.CreatedAt,
		&action.UpdatedAt,
		&action.ArchivedAt,
	)
	if err != nil {
		return QuickAction{}, err
	}
	return validateQuickAction(action)
}

func scanQuickActionRows(rows pgx.Rows) (QuickAction, error) {
	var action QuickAction
	err := rows.Scan(
		&action.ID,
		&action.WorkspaceID,
		&action.Name,
		&action.Description,
		&action.TargetAgentID,
		&action.Visibility,
		&action.CreatedBy,
		&action.CreatedAt,
		&action.UpdatedAt,
		&action.ArchivedAt,
	)
	if err != nil {
		return QuickAction{}, err
	}
	return validateQuickAction(action)
}

func validateQuickAction(action QuickAction) (QuickAction, error) {
	if !action.Visibility.Valid() {
		return QuickAction{}, errors.New("database returned invalid quick-action visibility")
	}
	return action, nil
}

func propertyKindToDatabase(kind PropertyKind) string {
	if kind == PropertyMultiSelect {
		return "multi_select"
	}
	return string(kind)
}

func propertyKindFromDatabase(kind string) PropertyKind {
	if kind == "multi_select" {
		return PropertyMultiSelect
	}
	return PropertyKind(kind)
}
