package catalogs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const labelProjection = `
	label.id,
	label.workspace_id,
	label.name,
	label.description,
	label.color,
	label.created_by,
	label.created_at,
	label.updated_at,
	label.archived_at`

const statusProjection = `
	status.id,
	status.workspace_id,
	status.key,
	status.name,
	status.description,
	status.category,
	status.color,
	status.sort_order,
	status.is_system,
	status.created_by,
	status.created_at,
	status.updated_at,
	status.archived_at`

// Repository is the authoritative pgx boundary for P2 catalogs.
type Repository struct {
	pool *pgxpool.Pool
}

// New rejects an unavailable database.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("catalog repository pool is nil")
	}
	return &Repository{pool: pool}, nil
}

// ListLabels returns one over-fetched, filtered workspace page.
func (repository *Repository) ListLabels(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter ListFilter,
	after *TimeCursor,
	limit int,
) ([]Label, error) {
	var afterTime *time.Time
	var afterID *uuid.UUID
	if after != nil {
		afterTime = &after.UpdatedAt
		afterID = &after.ID
	}
	rows, err := repository.pool.Query(
		ctx,
		`SELECT `+labelProjection+`
		   FROM issue_labels AS label
		  WHERE label.workspace_id = $1
		    AND ($2::boolean OR label.archived_at IS NULL)
		    AND (
		        $3::text = ''
		        OR label.name ILIKE ('%' || $3 || '%') ESCAPE '\'
		        OR COALESCE(label.description, '') ILIKE ('%' || $3 || '%') ESCAPE '\'
		    )
		    AND (
		        $4::timestamptz IS NULL
		        OR (label.updated_at, label.id) < ($4, $5::uuid)
		    )
		  ORDER BY label.updated_at DESC, label.id DESC
		  LIMIT $6`,
		workspaceID,
		filter.IncludeArchived,
		escapeCatalogLike(filter.Query),
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list issue labels: %w", err)
	}
	defer rows.Close()
	result := make([]Label, 0, limit)
	for rows.Next() {
		label, err := scanLabelRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan issue label list: %w", err)
		}
		result = append(result, label)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate issue labels: %w", err)
	}
	return result, nil
}

// GetLabel hides labels outside the supplied workspace.
func (repository *Repository) GetLabel(
	ctx context.Context,
	workspaceID, labelID uuid.UUID,
) (Label, error) {
	label, err := scanLabelRow(repository.pool.QueryRow(
		ctx,
		`SELECT `+labelProjection+`
		   FROM issue_labels AS label
		  WHERE label.workspace_id = $1 AND label.id = $2`,
		workspaceID,
		labelID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Label{}, ErrNotFound
	}
	if err != nil {
		return Label{}, fmt.Errorf("get issue label: %w", err)
	}
	return label, nil
}

// CreateLabel inserts one active definition.
func (repository *Repository) CreateLabel(
	ctx context.Context,
	params CreateLabelParams,
) (Label, error) {
	label, err := scanLabelRow(repository.pool.QueryRow(
		ctx,
		`INSERT INTO issue_labels AS label (
		    id,
		    workspace_id,
		    name,
		    description,
		    color,
		    created_by,
		    created_at,
		    updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
		 RETURNING `+labelProjection,
		params.ID,
		params.WorkspaceID,
		params.Name,
		params.Description,
		params.Color,
		params.CreatedBy,
		params.CreatedAt,
	))
	if err != nil {
		return Label{}, classifyCatalogWrite("create issue label", err)
	}
	return label, nil
}

// UpdateLabel applies one mutable subset.
func (repository *Repository) UpdateLabel(
	ctx context.Context,
	workspaceID, labelID uuid.UUID,
	patch LabelPatch,
	updatedAt time.Time,
) (Label, error) {
	label, err := scanLabelRow(repository.pool.QueryRow(
		ctx,
		`UPDATE issue_labels AS label
		    SET name = CASE WHEN $3 THEN $4::text ELSE label.name END,
		        description = CASE WHEN $5 THEN $6::text ELSE label.description END,
		        color = CASE WHEN $7 THEN $8::text ELSE label.color END,
		        updated_at = $9
		  WHERE label.workspace_id = $1
		    AND label.id = $2
		    AND label.archived_at IS NULL
		  RETURNING `+labelProjection,
		workspaceID,
		labelID,
		patch.Name != nil,
		patch.Name,
		patch.DescriptionSet,
		patch.Description,
		patch.Color != nil,
		patch.Color,
		updatedAt,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Label{}, ErrNotFound
	}
	if err != nil {
		return Label{}, classifyCatalogWrite("update issue label", err)
	}
	return label, nil
}

// ArchiveLabel keeps memberships historically resolvable.
func (repository *Repository) ArchiveLabel(
	ctx context.Context,
	workspaceID, labelID uuid.UUID,
	archivedAt time.Time,
) error {
	tag, err := repository.pool.Exec(
		ctx,
		`UPDATE issue_labels
		    SET archived_at = $3, updated_at = $3
		  WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL`,
		workspaceID,
		labelID,
		archivedAt,
	)
	if err != nil {
		return fmt.Errorf("archive issue label: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// ListIssueLabels is the narrow issue-handler read seam.
func (repository *Repository) ListIssueLabels(
	ctx context.Context,
	workspaceID, issueID uuid.UUID,
) ([]Label, error) {
	rows, err := repository.pool.Query(
		ctx,
		`SELECT `+labelProjection+`
		   FROM issue_label_memberships AS membership
		   JOIN issue_labels AS label
		     ON label.workspace_id = membership.workspace_id
		    AND label.id = membership.label_id
		  WHERE membership.workspace_id = $1
		    AND membership.issue_id = $2
		  ORDER BY label.name, label.id`,
		workspaceID,
		issueID,
	)
	if err != nil {
		return nil, fmt.Errorf("list labels for issue: %w", err)
	}
	defer rows.Close()
	result := make([]Label, 0)
	for rows.Next() {
		label, err := scanLabelRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan issue label membership: %w", err)
		}
		result = append(result, label)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate labels for issue: %w", err)
	}
	return result, nil
}

// AttachIssueLabel is idempotent and rejects archived or cross-workspace rows.
func (repository *Repository) AttachIssueLabel(
	ctx context.Context,
	workspaceID, issueID, labelID, actorID uuid.UUID,
	createdAt time.Time,
) error {
	tag, err := repository.pool.Exec(
		ctx,
		`INSERT INTO issue_label_memberships (
		    workspace_id, issue_id, label_id, assigned_by, created_at
		 )
		 SELECT $1, $2, label.id, $4, $5
		   FROM issue_labels AS label
		  WHERE label.workspace_id = $1
		    AND label.id = $3
		    AND label.archived_at IS NULL
		 ON CONFLICT (workspace_id, issue_id, label_id) DO NOTHING`,
		workspaceID,
		issueID,
		labelID,
		actorID,
		createdAt,
	)
	if err != nil {
		return classifyCatalogWrite("attach issue label", err)
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := repository.pool.QueryRow(
			ctx,
			`SELECT EXISTS (
			    SELECT 1 FROM issue_label_memberships
			     WHERE workspace_id = $1 AND issue_id = $2 AND label_id = $3
			)`,
			workspaceID,
			issueID,
			labelID,
		).Scan(&exists); err != nil {
			return fmt.Errorf("check issue label membership: %w", err)
		}
		if !exists {
			return ErrNotFound
		}
	}
	return nil
}

// DetachIssueLabel is idempotent after issue authorization.
func (repository *Repository) DetachIssueLabel(
	ctx context.Context,
	workspaceID, issueID, labelID uuid.UUID,
) error {
	_, err := repository.pool.Exec(
		ctx,
		`DELETE FROM issue_label_memberships
		  WHERE workspace_id = $1 AND issue_id = $2 AND label_id = $3`,
		workspaceID,
		issueID,
		labelID,
	)
	if err != nil {
		return fmt.Errorf("detach issue label: %w", err)
	}
	return nil
}

// ListStatuses returns ordered definitions.
func (repository *Repository) ListStatuses(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter ListFilter,
	after *PositionCursor,
	limit int,
) ([]StatusDefinition, error) {
	var afterOrder *int
	var afterID *uuid.UUID
	if after != nil {
		afterOrder = &after.SortOrder
		afterID = &after.ID
	}
	rows, err := repository.pool.Query(
		ctx,
		`SELECT `+statusProjection+`
		   FROM issue_status_definitions AS status
		  WHERE status.workspace_id = $1
		    AND ($2::boolean OR status.archived_at IS NULL)
		    AND (
		        $3::text = ''
		        OR status.name ILIKE ('%' || $3 || '%') ESCAPE '\'
		        OR status.key ILIKE ('%' || $3 || '%') ESCAPE '\'
		    )
		    AND (
		        $4::integer IS NULL
		        OR (status.sort_order, status.id) > ($4, $5::uuid)
		    )
		  ORDER BY status.sort_order, status.id
		  LIMIT $6`,
		workspaceID,
		filter.IncludeArchived,
		escapeCatalogLike(filter.Query),
		afterOrder,
		afterID,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list issue statuses: %w", err)
	}
	defer rows.Close()
	result := make([]StatusDefinition, 0, limit)
	for rows.Next() {
		status, err := scanStatusRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan issue status list: %w", err)
		}
		result = append(result, status)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate issue statuses: %w", err)
	}
	return result, nil
}

// GetStatus hides definitions outside the supplied workspace.
func (repository *Repository) GetStatus(
	ctx context.Context,
	workspaceID, statusID uuid.UUID,
) (StatusDefinition, error) {
	status, err := scanStatusRow(repository.pool.QueryRow(
		ctx,
		`SELECT `+statusProjection+`
		   FROM issue_status_definitions AS status
		  WHERE status.workspace_id = $1 AND status.id = $2`,
		workspaceID,
		statusID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return StatusDefinition{}, ErrNotFound
	}
	if err != nil {
		return StatusDefinition{}, fmt.Errorf("get issue status: %w", err)
	}
	return status, nil
}

// CreateStatus inserts a custom definition with immutable category.
func (repository *Repository) CreateStatus(
	ctx context.Context,
	params CreateStatusParams,
) (StatusDefinition, error) {
	status, err := scanStatusRow(repository.pool.QueryRow(
		ctx,
		`INSERT INTO issue_status_definitions AS status (
		    id,
		    workspace_id,
		    key,
		    name,
		    description,
		    category,
		    color,
		    sort_order,
		    is_system,
		    created_by,
		    created_at,
		    updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, $10)
		 RETURNING `+statusProjection,
		params.ID,
		params.WorkspaceID,
		params.Key,
		params.Name,
		params.Description,
		categoryToDatabase(params.Category),
		params.Color,
		params.SortOrder,
		params.CreatedBy,
		params.CreatedAt,
	))
	if err != nil {
		return StatusDefinition{}, classifyCatalogWrite("create issue status", err)
	}
	return status, nil
}

// UpdateStatus changes presentation only; category and key never enter SQL.
func (repository *Repository) UpdateStatus(
	ctx context.Context,
	workspaceID, statusID uuid.UUID,
	patch StatusPatch,
	updatedAt time.Time,
) (StatusDefinition, error) {
	status, err := scanStatusRow(repository.pool.QueryRow(
		ctx,
		`UPDATE issue_status_definitions AS status
		    SET name = CASE WHEN $3 THEN $4::text ELSE status.name END,
		        description = CASE WHEN $5 THEN $6::text ELSE status.description END,
		        color = CASE WHEN $7 THEN $8::text ELSE status.color END,
		        sort_order = CASE WHEN $9 THEN $10::integer ELSE status.sort_order END,
		        updated_at = $11
		  WHERE status.workspace_id = $1
		    AND status.id = $2
		    AND status.archived_at IS NULL
		  RETURNING `+statusProjection,
		workspaceID,
		statusID,
		patch.Name != nil,
		patch.Name,
		patch.DescriptionSet,
		patch.Description,
		patch.Color != nil,
		patch.Color,
		patch.SortOrder != nil,
		patch.SortOrder,
		updatedAt,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return StatusDefinition{}, ErrNotFound
	}
	if err != nil {
		return StatusDefinition{}, classifyCatalogWrite("update issue status", err)
	}
	return status, nil
}

// ArchiveStatus soft-deletes only custom definitions.
func (repository *Repository) ArchiveStatus(
	ctx context.Context,
	workspaceID, statusID uuid.UUID,
	archivedAt time.Time,
) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin issue status archive: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	var system bool
	err = tx.QueryRow(
		ctx,
		`SELECT is_system
		   FROM issue_status_definitions
		  WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL
		  FOR UPDATE`,
		workspaceID,
		statusID,
	).Scan(&system)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock issue status: %w", err)
	}
	if system {
		return ErrSystemDefinition
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE issue_status_definitions
		    SET archived_at = $3, updated_at = $3
		  WHERE workspace_id = $1 AND id = $2`,
		workspaceID,
		statusID,
		archivedAt,
	); err != nil {
		return fmt.Errorf("archive issue status: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit issue status archive: %w", err)
	}
	return nil
}

// ReorderStatuses requires an exact permutation of all active definitions.
func (repository *Repository) ReorderStatuses(
	ctx context.Context,
	workspaceID uuid.UUID,
	statusIDs []uuid.UUID,
	updatedAt time.Time,
) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin issue status reorder: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	rows, err := tx.Query(
		ctx,
		`SELECT id
		   FROM issue_status_definitions
		  WHERE workspace_id = $1 AND archived_at IS NULL
		  ORDER BY id
		  FOR UPDATE`,
		workspaceID,
	)
	if err != nil {
		return fmt.Errorf("lock issue statuses: %w", err)
	}
	existing := make(map[uuid.UUID]struct{})
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("scan locked issue status: %w", err)
		}
		existing[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate locked issue statuses: %w", err)
	}
	rows.Close()
	if len(existing) != len(statusIDs) {
		return ErrConflict
	}
	seen := make(map[uuid.UUID]struct{}, len(statusIDs))
	for index, id := range statusIDs {
		if _, exists := existing[id]; !exists {
			return ErrConflict
		}
		if _, duplicate := seen[id]; duplicate {
			return ErrConflict
		}
		seen[id] = struct{}{}
		if _, err := tx.Exec(
			ctx,
			`UPDATE issue_status_definitions
			    SET sort_order = $3, updated_at = $4
			  WHERE workspace_id = $1 AND id = $2`,
			workspaceID,
			id,
			(index+1)*1000,
			updatedAt,
		); err != nil {
			return fmt.Errorf("write issue status order: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit issue status reorder: %w", err)
	}
	return nil
}

func scanLabelRow(row pgx.Row) (Label, error) {
	var label Label
	err := row.Scan(
		&label.ID,
		&label.WorkspaceID,
		&label.Name,
		&label.Description,
		&label.Color,
		&label.CreatedBy,
		&label.CreatedAt,
		&label.UpdatedAt,
		&label.ArchivedAt,
	)
	return label, err
}

func scanLabelRows(rows pgx.Rows) (Label, error) {
	var label Label
	err := rows.Scan(
		&label.ID,
		&label.WorkspaceID,
		&label.Name,
		&label.Description,
		&label.Color,
		&label.CreatedBy,
		&label.CreatedAt,
		&label.UpdatedAt,
		&label.ArchivedAt,
	)
	return label, err
}

func scanStatusRow(row pgx.Row) (StatusDefinition, error) {
	var (
		status   StatusDefinition
		category string
	)
	err := row.Scan(
		&status.ID,
		&status.WorkspaceID,
		&status.Key,
		&status.Name,
		&status.Description,
		&category,
		&status.Color,
		&status.SortOrder,
		&status.IsSystem,
		&status.CreatedBy,
		&status.CreatedAt,
		&status.UpdatedAt,
		&status.ArchivedAt,
	)
	if err != nil {
		return StatusDefinition{}, err
	}
	status.Category = categoryFromDatabase(category)
	if !status.Category.Valid() {
		return StatusDefinition{}, errors.New("database returned an invalid workflow category")
	}
	return status, nil
}

func scanStatusRows(rows pgx.Rows) (StatusDefinition, error) {
	var (
		status   StatusDefinition
		category string
	)
	err := rows.Scan(
		&status.ID,
		&status.WorkspaceID,
		&status.Key,
		&status.Name,
		&status.Description,
		&category,
		&status.Color,
		&status.SortOrder,
		&status.IsSystem,
		&status.CreatedBy,
		&status.CreatedAt,
		&status.UpdatedAt,
		&status.ArchivedAt,
	)
	if err != nil {
		return StatusDefinition{}, err
	}
	status.Category = categoryFromDatabase(category)
	if !status.Category.Valid() {
		return StatusDefinition{}, errors.New("database returned an invalid workflow category")
	}
	return status, nil
}

func classifyCatalogWrite(operation string, err error) error {
	var postgres *pgconn.PgError
	if errors.As(err, &postgres) {
		switch postgres.Code {
		case "23503":
			return ErrNotFound
		case "23505", "23514", "23P01":
			return ErrConflict
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func categoryToDatabase(category WorkflowCategory) string {
	switch category {
	case CategoryInProgress:
		return "in_progress"
	case CategoryInReview:
		return "in_review"
	case CategoryBlocked:
		return "blocked"
	default:
		return string(category)
	}
}

func categoryFromDatabase(category string) WorkflowCategory {
	switch category {
	case "in_progress":
		return CategoryInProgress
	case "in_review":
		return CategoryInReview
	case "blocked":
		return CategoryBlocked
	default:
		return WorkflowCategory(category)
	}
}

func escapeCatalogLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}
