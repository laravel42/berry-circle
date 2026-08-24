package core

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const issueProjection = `
	i.id, i.board_id, b.slug, i.number, i.title, i.description,
	i.status::text, i.priority::text, i.sort_order, i.due_date,
	i.assignee_type::text, i.assignee_id, assignee_user.name, assignee_user.avatar_url,
	i.active_run_id,
	i.created_by, creator.name, creator.avatar_url,
	i.created_at, i.updated_at`

var issueIdentifierPattern = regexp.MustCompile(`^(.+)-([1-9][0-9]*)$`)

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
		`SELECT `+issueProjection+`
		   FROM issues AS i
		   JOIN boards AS b ON b.id = i.board_id
		   LEFT JOIN users AS assignee_user
		     ON i.assignee_type = 'user' AND assignee_user.id = i.assignee_id
		   LEFT JOIN users AS creator ON creator.id = i.created_by
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
				(b.slug || '-' || i.number::text) ILIKE $8::text ESCAPE E'\\'
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
	match := issueIdentifierPattern.FindStringSubmatch(reference)
	if match == nil {
		return Issue{}, ErrNotFound
	}
	number, err := strconv.ParseInt(match[2], 10, 32)
	if err != nil {
		return Issue{}, ErrNotFound
	}
	issue, err := scanIssue(repository.Pool.QueryRow(
		ctx,
		`SELECT `+issueProjection+`
		   FROM issues AS i
		   JOIN boards AS b ON b.id = i.board_id
		   LEFT JOIN users AS assignee_user
		     ON i.assignee_type = 'user' AND assignee_user.id = i.assignee_id
		   LEFT JOIN users AS creator ON creator.id = i.created_by
		  WHERE lower(b.slug) = lower($1) AND i.number = $2`,
		match[1],
		number,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Issue{}, ErrNotFound
	}
	return issue, err
}

// CreateIssue allocates the board number and inserts all durable facts in one transaction.
func (repository *Repository) CreateIssue(
	ctx context.Context,
	params CreateIssueParams,
) (Issue, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Issue{}, fmt.Errorf("begin issue creation: %w", err)
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
			return Issue{}, ErrNotFound
		}
		return Issue{}, fmt.Errorf("lock issue board: %w", err)
	}
	if err := validateAssignee(ctx, tx, params.Assignee); err != nil {
		return Issue{}, err
	}

	var number int32
	if err := tx.QueryRow(
		ctx,
		`SELECT berry_next_issue_number($1)`,
		params.BoardID,
	).Scan(&number); err != nil {
		return Issue{}, fmt.Errorf("allocate issue number: %w", err)
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
		return Issue{}, classifyWriteError("create issue", err)
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
			return Issue{}, classifyWriteError("record issue assignment", err)
		}
	}
	created, err := getIssueByID(ctx, tx, params.ID, false)
	if err != nil {
		return Issue{}, err
	}
	if created.BoardSlug != boardSlug {
		return Issue{}, errors.New("create issue: board scope changed")
	}
	if err := tx.Commit(ctx); err != nil {
		return Issue{}, fmt.Errorf("commit issue creation: %w", err)
	}
	return created, nil
}

// UpdateIssue serializes workflow and assignment changes under a row lock.
func (repository *Repository) UpdateIssue(
	ctx context.Context,
	params UpdateIssueParams,
) (Issue, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Issue{}, fmt.Errorf("begin issue update: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var currentStatus string
	if err := tx.QueryRow(
		ctx,
		`SELECT status::text FROM issues WHERE id = $1 FOR UPDATE`,
		params.IssueID,
	).Scan(&currentStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Issue{}, ErrNotFound
		}
		return Issue{}, fmt.Errorf("lock issue: %w", err)
	}
	if params.Patch.Status != nil && !canTransition(currentStatus, *params.Patch.Status) {
		return Issue{}, &StateTransitionError{
			From: dbStatusToAPI(currentStatus),
			To:   dbStatusToAPI(*params.Patch.Status),
		}
	}
	if params.Patch.AssigneeSet {
		if err := validateAssignee(ctx, tx, params.Patch.Assignee); err != nil {
			return Issue{}, err
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
		return Issue{}, classifyWriteError("update issue", err)
	}
	if tag.RowsAffected() != 1 {
		return Issue{}, ErrNotFound
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
			return Issue{}, classifyWriteError("record issue assignment", err)
		}
	}
	updated, err := getIssueByID(ctx, tx, params.IssueID, false)
	if err != nil {
		return Issue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Issue{}, fmt.Errorf("commit issue update: %w", err)
	}
	return updated, nil
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
		`SELECT `+issueProjection+`
		   FROM issues AS i
		   JOIN boards AS b ON b.id = i.board_id
		   LEFT JOIN users AS assignee_user
		     ON i.assignee_type = 'user' AND assignee_user.id = i.assignee_id
		   LEFT JOIN users AS creator ON creator.id = i.created_by
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
	)
	if err := row.Scan(
		&issue.ID,
		&issue.BoardID,
		&issue.BoardSlug,
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
		"in_review":   {"in_progress", "done", "blocked", "cancelled"},
		"done":        {"in_review"},
		"blocked":     {"todo", "in_progress", "cancelled"},
		"cancelled":   {"backlog", "todo"},
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
