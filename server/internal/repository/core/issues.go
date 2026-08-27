package core

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/issueid"
)

const issueProjection = `
	i.id, i.board_id, w.id, b.slug, w.settings->>'issuePrefix', i.number, i.title, i.description,
	i.status::text, i.priority::text, i.sort_order, i.due_date,
	i.assignee_type::text, i.assignee_id,
	COALESCE(assignee_user.name, assignee_agent.name),
	COALESCE(assignee_user.avatar_url, assignee_agent.avatar_url),
	i.active_run_id,
	project.id, project.name,
	i.created_by, creator.name, creator.avatar_url,
	i.created_at, i.updated_at`

// issueSource resolves an issue and both kinds of assignee.
//
// Shared rather than repeated: this clause was duplicated at each call site and
// every copy joined only users, so an issue assigned to an agent came back with
// a null name and rendered as the literal word "Agent" with no avatar. Keeping
// it in one place means the agent join cannot be forgotten at a fourth site.
//
// The live predicate rides on the board join rather than each caller's WHERE.
// For an inner join the two are equivalent, and putting it here means a query
// cannot read a deleted issue by forgetting to exclude one. issueSourceAny is
// the same clause without it, for the one reader that must describe a deleted
// issue: the event that records its deletion.
const issueSource = `
	   FROM issues AS i
	   JOIN boards AS b ON b.id = i.board_id AND i.deleted_at IS NULL` + issueSourceJoins

const issueSourceAny = `
	   FROM issues AS i
	   JOIN boards AS b ON b.id = i.board_id` + issueSourceJoins

const issueSourceJoins = `
	   JOIN workspaces AS w ON w.id = b.workspace_id AND w.deleted_at IS NULL
	   LEFT JOIN users AS assignee_user
	     ON i.assignee_type = 'user' AND assignee_user.id = i.assignee_id
	   LEFT JOIN agents AS assignee_agent
	     ON i.assignee_type = 'agent' AND assignee_agent.id = i.assignee_id
	   LEFT JOIN users AS creator ON creator.id = i.created_by
	   -- An issue belongs to at most one project, and the link table's primary
	   -- key on issue_id is what guarantees that, so this cannot fan out.
	   LEFT JOIN issue_project_links AS link ON link.issue_id = i.id
	   LEFT JOIN projects AS project
	     ON project.id = link.project_id AND project.deleted_at IS NULL`

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// ListIssues returns one over-fetched filtered stable page.
func (repository *Repository) ListIssues(
	ctx context.Context,
	filter IssueListFilter,
) ([]Issue, error) {
	if filter.Limit < 1 {
		return nil, errors.New("list issues: invalid limit")
	}
	var (
		assigneeEnabled bool
		assigneeType    *string
		assigneeID      *uuid.UUID
		queryEnabled    bool
		queryValue      *string
		afterEnabled    bool
		afterTime       any
		afterID         any
	)
	if filter.Assignee != nil {
		assigneeEnabled = true
		assigneeType = &filter.Assignee.Type
		assigneeID = &filter.Assignee.ID
	}
	if filter.Query != nil {
		queryEnabled = true
		queryValue = filter.Query
	}
	if filter.After != nil {
		afterEnabled = true
		afterTime = filter.After.UpdatedAt
		afterID = filter.After.ID
	}

	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+issueProjection+issueSource+`
		  WHERE i.board_id = $1
		    AND (
				COALESCE(cardinality($2::text[]), 0) = 0 OR
				i.status::text = ANY($2::text[])
			)
		    AND (
				COALESCE(cardinality($3::text[]), 0) = 0 OR
				i.priority::text = ANY($3::text[])
			)
		    AND (NOT $4::boolean OR (
				i.assignee_type::text = $5::text AND i.assignee_id = $6::uuid
			))
		    AND (NOT $7::boolean OR (
				i.title ILIKE $8::text ESCAPE E'\\' OR
				(w.settings->>'issuePrefix' || '-' || i.number::text) ILIKE $8::text ESCAPE E'\\'
			))
		    AND (NOT $9::boolean OR
				(i.updated_at, i.id) < ($10::timestamptz, $11::uuid)
			)
		  ORDER BY i.updated_at DESC, i.id DESC
		  LIMIT $12`,
		filter.BoardID,
		filter.Statuses,
		filter.Priorities,
		assigneeEnabled,
		assigneeType,
		assigneeID,
		queryEnabled,
		queryValue,
		afterEnabled,
		afterTime,
		afterID,
		filter.Limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list issues: %w", err)
	}
	defer rows.Close()

	issues := make([]Issue, 0, filter.Limit)
	for rows.Next() {
		issue, err := scanIssue(rows)
		if err != nil {
			return nil, err
		}
		issues = append(issues, issue)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate issues: %w", err)
	}
	return issues, nil
}

// GetIssue resolves either a UUID or case-insensitive human identifier.
func (repository *Repository) GetIssue(ctx context.Context, reference string) (Issue, error) {
	if id, err := ParseUUID(reference); err == nil {
		return getIssueByID(ctx, repository.Pool, id, false)
	}
	prefix, number, ok := issueid.Parse(reference)
	if !ok {
		return Issue{}, ErrNotFound
	}
	issue, err := scanIssue(repository.Pool.QueryRow(
		ctx,
		`SELECT `+issueProjection+issueSource+`
		  WHERE lower(w.settings->>'issuePrefix') = lower($1) AND i.number = $2`,
		prefix,
		number,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Issue{}, ErrNotFound
	}
	return issue, err
}

// CreateIssue allocates the board number and inserts all durable facts in one
// transaction, including the issue.created outbox row. The returned events are
// for the caller to publish live once the commit is known to have happened.
func (repository *Repository) CreateIssue(
	ctx context.Context,
	params CreateIssueParams,
) (Issue, []IssueMutationEvent, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Issue{}, nil, fmt.Errorf("begin issue creation: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var boardSlug string
	if err := tx.QueryRow(
		ctx,
		`SELECT slug FROM boards WHERE id = $1 FOR KEY SHARE`,
		params.BoardID,
	).Scan(&boardSlug); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Issue{}, nil, ErrNotFound
		}
		return Issue{}, nil, fmt.Errorf("lock issue board: %w", err)
	}
	if err := validateAssignee(ctx, tx, params.Assignee); err != nil {
		return Issue{}, nil, err
	}

	var number int32
	if err := tx.QueryRow(
		ctx,
		`SELECT berry_next_issue_number($1)`,
		params.BoardID,
	).Scan(&number); err != nil {
		return Issue{}, nil, fmt.Errorf("allocate issue number: %w", err)
	}
	var (
		assigneeType *string
		assigneeID   *uuid.UUID
	)
	if params.Assignee != nil {
		assigneeType = &params.Assignee.Type
		assigneeID = &params.Assignee.ID
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO issues (
			id, board_id, number, title, description, status, priority,
			sort_order, due_date, assignee_type, assignee_id, created_by,
			created_at, updated_at
		 ) VALUES (
			$1, $2, $3, $4, $5, $6::issue_status, $7::issue_priority,
			$8, $9, $10::assignee_type, $11, $12, $13, $13
		 )`,
		params.ID,
		params.BoardID,
		number,
		params.Title,
		params.Description,
		params.Status,
		params.Priority,
		params.SortOrder,
		params.DueDate,
		assigneeType,
		assigneeID,
		params.CreatedBy,
		params.CreatedAt,
	); err != nil {
		return Issue{}, nil, classifyWriteError("create issue", err)
	}
	if params.Assignee != nil {
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO assignments (
				id, issue_id, assignee_type, assignee_id, assigned_by, created_at
			 ) VALUES ($1, $2, $3::assignee_type, $4, $5, $6)`,
			params.AssignmentID,
			params.ID,
			params.Assignee.Type,
			params.Assignee.ID,
			params.CreatedBy,
			params.CreatedAt,
		); err != nil {
			return Issue{}, nil, classifyWriteError("record issue assignment", err)
		}
	}
	if params.Project != nil {
		if err := setIssueProject(ctx, tx, params.ID, params.Project, params.CreatedBy); err != nil {
			return Issue{}, nil, err
		}
	}
	// Read back after linking so the returned issue carries its project, which
	// is what lets a caller render the new issue without a second request.
	created, err := getIssueByID(ctx, tx, params.ID, false)
	if err != nil {
		return Issue{}, nil, err
	}
	if created.BoardSlug != boardSlug {
		return Issue{}, nil, errors.New("create issue: board scope changed")
	}
	events, err := RecordIssueEvents(ctx, tx, IssueEventParams{
		IssueID:    params.ID,
		Kind:       IssueEventCreated,
		Actor:      &ActorKey{Type: "user", ID: params.CreatedBy},
		OccurredAt: params.CreatedAt,
		NewID:      params.NewID,
	})
	if err != nil {
		return Issue{}, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Issue{}, nil, fmt.Errorf("commit issue creation: %w", err)
	}
	return created, events, nil
}

// UpdateIssue serializes workflow and assignment changes under a row lock and
// records issue.updated plus the derived issue.assigned/started/completed
// facts in the same transaction.
func (repository *Repository) UpdateIssue(
	ctx context.Context,
	params UpdateIssueParams,
) (Issue, []IssueMutationEvent, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Issue{}, nil, fmt.Errorf("begin issue update: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var currentStatus string
	if err := tx.QueryRow(
		ctx,
		`SELECT status::text FROM issues WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
		params.IssueID,
	).Scan(&currentStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Issue{}, nil, ErrNotFound
		}
		return Issue{}, nil, fmt.Errorf("lock issue: %w", err)
	}
	if params.Patch.Status != nil && !canTransition(currentStatus, *params.Patch.Status) {
		return Issue{}, nil, &StateTransitionError{
			From: dbStatusToAPI(currentStatus),
			To:   dbStatusToAPI(*params.Patch.Status),
		}
	}
	if params.Patch.AssigneeSet {
		if err := validateAssignee(ctx, tx, params.Patch.Assignee); err != nil {
			return Issue{}, nil, err
		}
	}

	var (
		assigneeType *string
		assigneeID   *uuid.UUID
	)
	if params.Patch.Assignee != nil {
		assigneeType = &params.Patch.Assignee.Type
		assigneeID = &params.Patch.Assignee.ID
	}
	tag, err := tx.Exec(
		ctx,
		`UPDATE issues SET
			title = CASE WHEN $2 THEN $3::text ELSE title END,
			description = CASE WHEN $4 THEN $5::text ELSE description END,
			status = CASE WHEN $6 THEN $7::issue_status ELSE status END,
			priority = CASE WHEN $8 THEN $9::issue_priority ELSE priority END,
			sort_order = CASE WHEN $10 THEN $11::integer ELSE sort_order END,
			due_date = CASE WHEN $12 THEN $13::timestamptz ELSE due_date END,
			assignee_type = CASE WHEN $14 THEN $15::assignee_type ELSE assignee_type END,
			assignee_id = CASE WHEN $14 THEN $16::uuid ELSE assignee_id END,
			updated_at = $17
		 WHERE id = $1`,
		params.IssueID,
		params.Patch.Title != nil,
		params.Patch.Title,
		params.Patch.DescriptionSet,
		params.Patch.Description,
		params.Patch.Status != nil,
		params.Patch.Status,
		params.Patch.Priority != nil,
		params.Patch.Priority,
		params.Patch.SortOrder != nil,
		params.Patch.SortOrder,
		params.Patch.DueDateSet,
		params.Patch.DueDate,
		params.Patch.AssigneeSet,
		assigneeType,
		assigneeID,
		params.UpdatedAt,
	)
	if err != nil {
		return Issue{}, nil, classifyWriteError("update issue", err)
	}
	if tag.RowsAffected() != 1 {
		return Issue{}, nil, ErrNotFound
	}
	if params.Patch.AssigneeSet && params.Patch.Assignee != nil {
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO assignments (
				id, issue_id, assignee_type, assignee_id, assigned_by, created_at
			 ) VALUES ($1, $2, $3::assignee_type, $4, $5, $6)`,
			params.AssignmentID,
			params.IssueID,
			params.Patch.Assignee.Type,
			params.Patch.Assignee.ID,
			params.AssignedBy,
			params.UpdatedAt,
		); err != nil {
			return Issue{}, nil, classifyWriteError("record issue assignment", err)
		}
	}
	if params.Patch.ProjectSet {
		if err := setIssueProject(
			ctx, tx, params.IssueID, params.Patch.Project, params.AssignedBy,
		); err != nil {
			return Issue{}, nil, err
		}
	}
	updated, err := getIssueByID(ctx, tx, params.IssueID, false)
	if err != nil {
		return Issue{}, nil, err
	}
	changed, previousStatus := issuePatchChanges(params.Patch, currentStatus)
	events, err := RecordIssueEvents(ctx, tx, IssueEventParams{
		IssueID:        params.IssueID,
		Kind:           IssueEventUpdated,
		ChangedFields:  changed,
		PreviousStatus: previousStatus,
		Actor:          &ActorKey{Type: "user", ID: params.AssignedBy},
		OccurredAt:     params.UpdatedAt,
		NewID:          params.NewID,
	})
	if err != nil {
		return Issue{}, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Issue{}, nil, fmt.Errorf("commit issue update: %w", err)
	}
	return updated, events, nil
}

// issuePatchChanges names the wire fields a patch touched, and the storage
// status it moved away from when the status actually changed. A status set to
// its current value is a no-op transition and is not reported: consumers
// keyed on issue.started/completed must see a real move, not a repeated PATCH.
func issuePatchChanges(patch IssuePatch, currentStatus string) ([]string, string) {
	changed := make([]string, 0, 8)
	previousStatus := ""
	if patch.Title != nil {
		changed = append(changed, "title")
	}
	if patch.DescriptionSet {
		changed = append(changed, "description")
	}
	if patch.Status != nil && *patch.Status != currentStatus {
		changed = append(changed, "status")
		previousStatus = currentStatus
	}
	if patch.Priority != nil {
		changed = append(changed, "priority")
	}
	if patch.SortOrder != nil {
		changed = append(changed, "sortOrder")
	}
	if patch.DueDateSet {
		changed = append(changed, "dueDate")
	}
	if patch.AssigneeSet {
		changed = append(changed, "assignee")
	}
	if patch.ProjectSet {
		changed = append(changed, "project")
	}
	return changed, previousStatus
}

func getIssueByID(
	ctx context.Context,
	queryer queryRower,
	id uuid.UUID,
	forUpdate bool,
) (Issue, error) {
	lock := ""
	if forUpdate {
		lock = " FOR UPDATE OF i"
	}
	issue, err := scanIssue(queryer.QueryRow(
		ctx,
		`SELECT `+issueProjection+issueSource+`
		  WHERE i.id = $1`+lock,
		id,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Issue{}, ErrNotFound
	}
	return issue, err
}

func scanIssue(row rowScanner) (Issue, error) {
	var (
		issue           Issue
		assigneeType    *string
		assigneeID      *uuid.UUID
		assigneeName    *string
		assigneeAvatar  *string
		createdByID     *uuid.UUID
		createdByName   *string
		createdByAvatar *string
		projectID       *uuid.UUID
		projectName     *string
	)
	if err := row.Scan(
		&issue.ID,
		&issue.BoardID,
		&issue.WorkspaceID,
		&issue.BoardSlug,
		&issue.IssuePrefix,
		&issue.Number,
		&issue.Title,
		&issue.Description,
		&issue.Status,
		&issue.Priority,
		&issue.SortOrder,
		&issue.DueDate,
		&assigneeType,
		&assigneeID,
		&assigneeName,
		&assigneeAvatar,
		&issue.ActiveRunID,
		&projectID,
		&projectName,
		&createdByID,
		&createdByName,
		&createdByAvatar,
		&issue.CreatedAt,
		&issue.UpdatedAt,
	); err != nil {
		return Issue{}, err
	}
	if assigneeType != nil && assigneeID != nil {
		issue.Assignee = actorRef(*assigneeType, *assigneeID, assigneeName, assigneeAvatar)
	}
	if createdByID != nil {
		issue.CreatedBy = actorRef("user", *createdByID, createdByName, createdByAvatar)
	}
	if projectID != nil {
		name := ""
		if projectName != nil {
			name = *projectName
		}
		issue.Project = &ProjectRef{ID: *projectID, Name: name}
	}
	return issue, nil
}

func actorRef(
	actorType string,
	id uuid.UUID,
	name *string,
	avatar *string,
) *ActorRef {
	resolvedName := "Agent"
	if actorType == "user" {
		resolvedName = "Unknown user"
	}
	if name != nil {
		resolvedName = *name
	}
	return &ActorRef{
		Type:      actorType,
		ID:        id,
		Name:      resolvedName,
		AvatarURL: avatar,
	}
}

func validateAssignee(
	ctx context.Context,
	tx pgx.Tx,
	assignee *AssigneeInput,
) error {
	if assignee == nil || assignee.Type == "agent" {
		return nil
	}
	var id uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`SELECT id FROM users WHERE id = $1 FOR KEY SHARE`,
		assignee.ID,
	).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("validate user assignee: %w", err)
	}
	return nil
}

func canTransition(from, to string) bool {
	if from == to {
		return true
	}
	allowed := map[string][]string{
		"backlog":     {"todo", "cancelled"},
		"todo":        {"backlog", "in_progress", "blocked", "cancelled"},
		"in_progress": {"todo", "in_review", "blocked", "cancelled"},
		// todo: the reviewer sends rejected work back to be done again, and a
		// person looking at the same work must be able to do what it does.
		"in_review": {"todo", "in_progress", "done", "blocked", "cancelled"},
		"done":      {"in_review"},
		"blocked":   {"todo", "in_progress", "cancelled"},
		"cancelled": {"backlog", "todo"},
	}
	for _, candidate := range allowed[from] {
		if candidate == to {
			return true
		}
	}
	return false
}

func apiStatusToDB(status string) string {
	switch status {
	case "inProgress":
		return "in_progress"
	case "inReview":
		return "in_review"
	default:
		return status
	}
}

func dbStatusToAPI(status string) string {
	switch status {
	case "in_progress":
		return "inProgress"
	case "in_review":
		return "inReview"
	default:
		return status
	}
}

// EscapeSearchLiteral keeps user query text literal inside an ILIKE pattern.
func EscapeSearchLiteral(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + replacer.Replace(value) + "%"
}
