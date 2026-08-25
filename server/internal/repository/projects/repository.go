package projects

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

const projectProjection = `
	project.id,
	project.workspace_id,
	project.name,
	project.description,
	project.status,
	project.priority,
	project.start_date,
	project.target_date,
	project.github_repo_id,
	project.github_repo_full_name,
	project.created_by,
	project.created_at,
	project.updated_at`

const resourceProjection = `
	resource.id,
	resource.workspace_id,
	resource.project_id,
	resource.kind,
	resource.url,
	resource.label,
	resource.description,
	resource.sort_order,
	resource.created_by,
	resource.created_at,
	resource.updated_at`

// Repository is the hand-written pgx boundary for the first P2 lane.
type Repository struct {
	pool *pgxpool.Pool
}

// New rejects an unavailable authoritative database.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("projects repository pool is nil")
	}
	return &Repository{pool: pool}, nil
}

// List returns one over-fetched workspace page.
func (repository *Repository) List(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter ListFilter,
	after *Cursor,
	limit int,
) ([]Project, error) {
	if workspaceID == uuid.Nil || limit < 1 {
		return nil, errors.New("list projects: invalid scope")
	}
	var status, priority *string
	if filter.Status != nil {
		value := string(*filter.Status)
		status = &value
	}
	if filter.Priority != nil {
		value := string(*filter.Priority)
		priority = &value
	}
	var afterTime *time.Time
	var afterID *uuid.UUID
	if after != nil {
		afterTime = &after.UpdatedAt
		afterID = &after.ID
	}
	rows, err := repository.pool.Query(
		ctx,
		`SELECT `+projectProjection+`
		   FROM projects AS project
		  WHERE project.workspace_id = $1
		    AND project.deleted_at IS NULL
		    AND (
		        $2::text = ''
		        OR project.name ILIKE ('%' || $2 || '%') ESCAPE '\'
		        OR COALESCE(project.description, '') ILIKE ('%' || $2 || '%') ESCAPE '\'
		    )
		    AND ($3::text IS NULL OR project.status = $3)
		    AND ($4::text IS NULL OR project.priority = $4)
		    AND (
		        $5::timestamptz IS NULL
		        OR (project.updated_at, project.id) < ($5, $6::uuid)
		    )
		  ORDER BY project.updated_at DESC, project.id DESC
		  LIMIT $7`,
		workspaceID,
		escapeLike(filter.Query),
		status,
		priority,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	result := make([]Project, 0, limit)
	for rows.Next() {
		project, err := scanProjectRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan project list: %w", err)
		}
		result = append(result, project)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate projects: %w", err)
	}
	return result, nil
}

// WorkspaceID returns the active project's internal authorization scope.
func (repository *Repository) WorkspaceID(
	ctx context.Context,
	projectID uuid.UUID,
) (uuid.UUID, error) {
	var workspaceID uuid.UUID
	err := repository.pool.QueryRow(
		ctx,
		`SELECT workspace_id
		   FROM projects
		  WHERE id = $1 AND deleted_at IS NULL`,
		projectID,
	).Scan(&workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNotFound
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("resolve project workspace: %w", err)
	}
	return workspaceID, nil
}

// Get returns an active project only within the supplied workspace.
func (repository *Repository) Get(
	ctx context.Context,
	workspaceID, projectID uuid.UUID,
) (Project, error) {
	project, err := scanProjectRow(repository.pool.QueryRow(
		ctx,
		`SELECT `+projectProjection+`
		   FROM projects AS project
		  WHERE project.workspace_id = $1
		    AND project.id = $2
		    AND project.deleted_at IS NULL`,
		workspaceID,
		projectID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("get project: %w", err)
	}
	return project, nil
}

// Create inserts a normalized project.
func (repository *Repository) Create(
	ctx context.Context,
	params CreateParams,
) (Project, error) {
	project, err := scanProjectRow(repository.pool.QueryRow(
		ctx,
		`INSERT INTO projects AS project (
		    id,
		    workspace_id,
		    name,
		    description,
		    status,
		    priority,
		    start_date,
		    target_date,
		    created_by,
		    created_at,
		    updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
		 RETURNING `+projectProjection,
		params.ID,
		params.WorkspaceID,
		params.Name,
		params.Description,
		params.Status,
		params.Priority,
		params.StartDate,
		params.TargetDate,
		params.CreatedBy,
		params.CreatedAt,
	))
	if err != nil {
		return Project{}, classifyWrite("create project", err)
	}
	return project, nil
}

// Update applies one non-empty normalized patch.
func (repository *Repository) Update(
	ctx context.Context,
	workspaceID, projectID uuid.UUID,
	patch Patch,
	updatedAt time.Time,
) (Project, error) {
	project, err := scanProjectRow(repository.pool.QueryRow(
		ctx,
		`UPDATE projects AS project
		    SET name = CASE WHEN $3 THEN $4::text ELSE project.name END,
		        description = CASE WHEN $5 THEN $6::text ELSE project.description END,
		        status = CASE WHEN $7 THEN $8::text ELSE project.status END,
		        priority = CASE WHEN $9 THEN $10::text ELSE project.priority END,
		        start_date = CASE WHEN $11 THEN $12::date ELSE project.start_date END,
		        target_date = CASE WHEN $13 THEN $14::date ELSE project.target_date END,
		        -- Both columns move together or neither does, which is what the
		        -- pair constraint requires: a project carrying half a reference
		        -- looks linked and cannot be used.
		        github_repo_id =
		            CASE WHEN $15 THEN $16::bigint ELSE project.github_repo_id END,
		        github_repo_full_name =
		            CASE WHEN $15 THEN $17::text ELSE project.github_repo_full_name END,
		        updated_at = $18
		  WHERE project.workspace_id = $1
		    AND project.id = $2
		    AND project.deleted_at IS NULL
		  RETURNING `+projectProjection,
		workspaceID,
		projectID,
		patch.Name != nil,
		patch.Name,
		patch.DescriptionSet,
		patch.Description,
		patch.Status != nil,
		patch.Status,
		patch.Priority != nil,
		patch.Priority,
		patch.StartDateSet,
		patch.StartDate,
		patch.TargetDateSet,
		patch.TargetDate,
		patch.GitHubRepoSet,
		patch.GitHubRepoID,
		patch.GitHubRepoFullName,
		updatedAt,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, classifyWrite("update project", err)
	}
	return project, nil
}

// Archive soft-deletes one project and makes all nested reads disappear.
func (repository *Repository) Archive(
	ctx context.Context,
	workspaceID, projectID uuid.UUID,
	archivedAt time.Time,
) error {
	tag, err := repository.pool.Exec(
		ctx,
		`UPDATE projects
		    SET deleted_at = $3, updated_at = $3
		  WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
		workspaceID,
		projectID,
		archivedAt,
	)
	if err != nil {
		return fmt.Errorf("archive project: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// ListResources returns one over-fetched stable page for an active project.
func (repository *Repository) ListResources(
	ctx context.Context,
	workspaceID, projectID uuid.UUID,
	after *ResourceCursor,
	limit int,
) ([]Resource, error) {
	var afterOrder *int
	var afterID *uuid.UUID
	if after != nil {
		afterOrder = &after.SortOrder
		afterID = &after.ID
	}
	rows, err := repository.pool.Query(
		ctx,
		`SELECT `+resourceProjection+`
		   FROM project_resources AS resource
		   JOIN projects AS project
		     ON project.workspace_id = resource.workspace_id
		    AND project.id = resource.project_id
		    AND project.deleted_at IS NULL
		  WHERE resource.workspace_id = $1
		    AND resource.project_id = $2
		    AND resource.deleted_at IS NULL
		    AND (
		        $3::integer IS NULL
		        OR (resource.sort_order, resource.id) > ($3, $4::uuid)
		    )
		  ORDER BY resource.sort_order, resource.id
		  LIMIT $5`,
		workspaceID,
		projectID,
		afterOrder,
		afterID,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list project resources: %w", err)
	}
	defer rows.Close()
	result := make([]Resource, 0, limit)
	for rows.Next() {
		resource, err := scanResourceRows(rows)
		if err != nil {
			return nil, fmt.Errorf("scan project resource list: %w", err)
		}
		result = append(result, resource)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate project resources: %w", err)
	}
	return result, nil
}

// CreateResource inserts one normalized external pointer.
func (repository *Repository) CreateResource(
	ctx context.Context,
	params CreateResourceParams,
) (Resource, error) {
	resource, err := scanResourceRow(repository.pool.QueryRow(
		ctx,
		`INSERT INTO project_resources AS resource (
		    id,
		    workspace_id,
		    project_id,
		    kind,
		    url,
		    label,
		    description,
		    sort_order,
		    created_by,
		    created_at,
		    updated_at
		 )
		 SELECT $1, $2, project.id, $4, $5, $6, $7, $8, $9, $10, $10
		   FROM projects AS project
		  WHERE project.workspace_id = $2
		    AND project.id = $3
		    AND project.deleted_at IS NULL
		 RETURNING `+resourceProjection,
		params.ID,
		params.WorkspaceID,
		params.ProjectID,
		params.Kind,
		params.URL,
		params.Label,
		params.Description,
		params.SortOrder,
		params.CreatedBy,
		params.CreatedAt,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Resource{}, ErrNotFound
	}
	if err != nil {
		return Resource{}, classifyWrite("create project resource", err)
	}
	return resource, nil
}

// UpdateResource patches one active pointer nested under one active project.
func (repository *Repository) UpdateResource(
	ctx context.Context,
	workspaceID, projectID, resourceID uuid.UUID,
	patch ResourcePatch,
	updatedAt time.Time,
) (Resource, error) {
	resource, err := scanResourceRow(repository.pool.QueryRow(
		ctx,
		`UPDATE project_resources AS resource
		    SET kind = CASE WHEN $4 THEN $5::text ELSE resource.kind END,
		        url = CASE WHEN $6 THEN $7::text ELSE resource.url END,
		        label = CASE WHEN $8 THEN $9::text ELSE resource.label END,
		        description = CASE WHEN $10 THEN $11::text ELSE resource.description END,
		        sort_order = CASE WHEN $12 THEN $13::integer ELSE resource.sort_order END,
		        updated_at = $14
		   FROM projects AS project
		  WHERE resource.workspace_id = $1
		    AND resource.project_id = $2
		    AND resource.id = $3
		    AND resource.deleted_at IS NULL
		    AND project.workspace_id = resource.workspace_id
		    AND project.id = resource.project_id
		    AND project.deleted_at IS NULL
		  RETURNING `+resourceProjection,
		workspaceID,
		projectID,
		resourceID,
		patch.Kind != nil,
		patch.Kind,
		patch.URL != nil,
		patch.URL,
		patch.LabelSet,
		patch.Label,
		patch.DescriptionSet,
		patch.Description,
		patch.SortOrder != nil,
		patch.SortOrder,
		updatedAt,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Resource{}, ErrNotFound
	}
	if err != nil {
		return Resource{}, classifyWrite("update project resource", err)
	}
	return resource, nil
}

// ArchiveResource soft-deletes one nested pointer.
func (repository *Repository) ArchiveResource(
	ctx context.Context,
	workspaceID, projectID, resourceID uuid.UUID,
	archivedAt time.Time,
) error {
	tag, err := repository.pool.Exec(
		ctx,
		`UPDATE project_resources AS resource
		    SET deleted_at = $4, updated_at = $4
		   FROM projects AS project
		  WHERE resource.workspace_id = $1
		    AND resource.project_id = $2
		    AND resource.id = $3
		    AND resource.deleted_at IS NULL
		    AND project.workspace_id = resource.workspace_id
		    AND project.id = resource.project_id
		    AND project.deleted_at IS NULL`,
		workspaceID,
		projectID,
		resourceID,
		archivedAt,
	)
	if err != nil {
		return fmt.Errorf("archive project resource: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// LinkIssue upserts the one-project-per-issue seam. Database triggers verify
// that the issue, link, and project all carry the same workspace.
func (repository *Repository) LinkIssue(
	ctx context.Context,
	workspaceID, issueID, projectID, actorID uuid.UUID,
	createdAt time.Time,
) error {
	tag, err := repository.pool.Exec(
		ctx,
		`INSERT INTO issue_project_links (
		    workspace_id, issue_id, project_id, linked_by, created_at
		 )
		 SELECT $1, $2, project.id, $4, $5
		   FROM projects AS project
		  WHERE project.workspace_id = $1
		    AND project.id = $3
		    AND project.deleted_at IS NULL
		 ON CONFLICT (issue_id) DO UPDATE
		     SET workspace_id = EXCLUDED.workspace_id,
		         project_id = EXCLUDED.project_id,
		         linked_by = EXCLUDED.linked_by,
		         created_at = EXCLUDED.created_at`,
		workspaceID,
		issueID,
		projectID,
		actorID,
		createdAt,
	)
	if err != nil {
		return classifyWrite("link issue to project", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// UnlinkIssue removes the current project relationship idempotently.
func (repository *Repository) UnlinkIssue(
	ctx context.Context,
	workspaceID, issueID uuid.UUID,
) error {
	_, err := repository.pool.Exec(
		ctx,
		`DELETE FROM issue_project_links
		  WHERE workspace_id = $1 AND issue_id = $2`,
		workspaceID,
		issueID,
	)
	if err != nil {
		return fmt.Errorf("unlink issue from project: %w", err)
	}
	return nil
}

// ProjectForIssue returns the active linked project.
func (repository *Repository) ProjectForIssue(
	ctx context.Context,
	workspaceID, issueID uuid.UUID,
) (Project, error) {
	project, err := scanProjectRow(repository.pool.QueryRow(
		ctx,
		`SELECT `+projectProjection+`
		   FROM issue_project_links AS link
		   JOIN projects AS project
		     ON project.workspace_id = link.workspace_id
		    AND project.id = link.project_id
		    AND project.deleted_at IS NULL
		  WHERE link.workspace_id = $1 AND link.issue_id = $2`,
		workspaceID,
		issueID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("get issue project: %w", err)
	}
	return project, nil
}

func scanProjectRow(row pgx.Row) (Project, error) {
	var project Project
	err := row.Scan(
		&project.ID,
		&project.WorkspaceID,
		&project.Name,
		&project.Description,
		&project.Status,
		&project.Priority,
		&project.StartDate,
		&project.TargetDate,
		&project.GitHubRepoID,
		&project.GitHubRepoFullName,
		&project.CreatedBy,
		&project.CreatedAt,
		&project.UpdatedAt,
	)
	return project, err
}

func scanProjectRows(rows pgx.Rows) (Project, error) {
	var project Project
	err := rows.Scan(
		&project.ID,
		&project.WorkspaceID,
		&project.Name,
		&project.Description,
		&project.Status,
		&project.Priority,
		&project.StartDate,
		&project.TargetDate,
		&project.GitHubRepoID,
		&project.GitHubRepoFullName,
		&project.CreatedBy,
		&project.CreatedAt,
		&project.UpdatedAt,
	)
	return project, err
}

func scanResourceRow(row pgx.Row) (Resource, error) {
	var resource Resource
	err := row.Scan(
		&resource.ID,
		&resource.WorkspaceID,
		&resource.ProjectID,
		&resource.Kind,
		&resource.URL,
		&resource.Label,
		&resource.Description,
		&resource.SortOrder,
		&resource.CreatedBy,
		&resource.CreatedAt,
		&resource.UpdatedAt,
	)
	return resource, err
}

func scanResourceRows(rows pgx.Rows) (Resource, error) {
	var resource Resource
	err := rows.Scan(
		&resource.ID,
		&resource.WorkspaceID,
		&resource.ProjectID,
		&resource.Kind,
		&resource.URL,
		&resource.Label,
		&resource.Description,
		&resource.SortOrder,
		&resource.CreatedBy,
		&resource.CreatedAt,
		&resource.UpdatedAt,
	)
	return resource, err
}

func classifyWrite(operation string, err error) error {
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

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}
