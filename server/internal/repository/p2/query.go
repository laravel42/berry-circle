package p2

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (repository *Repository) Search(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter SearchFilter,
) ([]SearchResult, error) {
	if filter.Limit < 1 || filter.Limit > 101 {
		return nil, errors.New("search: invalid limit")
	}
	issueEnabled, boardEnabled := false, false
	for _, resourceType := range filter.Types {
		switch resourceType {
		case "issue":
			issueEnabled = true
		case "board":
			boardEnabled = true
		}
	}
	exact := strings.ToLower(filter.Query)
	contains := "%" + escapeLike(exact) + "%"
	prefix := escapeLike(exact) + "%"
	afterEnabled := filter.After != nil
	var afterRank, afterNormalized, afterType, afterID any
	if filter.After != nil {
		afterRank = filter.After.Rank
		afterNormalized = filter.After.Normalized
		afterType = filter.After.ResourceType
		afterID = filter.After.ID
	}
	tx, err := repository.beginBoundedRead(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(
		ctx,
		`WITH search_results AS (
			SELECT
				'issue'::text AS resource_type,
				issue.id,
				issue.title,
				board.name::text AS subtitle,
				upper(board.slug) || '-' || issue.number::text AS identifier,
				issue.board_id,
				CASE
					WHEN lower(board.slug || '-' || issue.number::text) = $2 THEN 100
					WHEN lower(issue.title) = $2 THEN 90
					WHEN lower(board.slug || '-' || issue.number::text) LIKE $3 ESCAPE '\' THEN 80
					WHEN lower(issue.title) LIKE $3 ESCAPE '\' THEN 70
					WHEN lower(issue.title) LIKE $4 ESCAPE '\' THEN 50
					WHEN lower(COALESCE(issue.description, '')) LIKE $4 ESCAPE '\' THEN 30
					ELSE 10
				END AS rank,
				lower(issue.title) AS normalized
			FROM issues AS issue
			JOIN boards AS board ON board.id = issue.board_id
			 AND issue.deleted_at IS NULL
			WHERE $5::boolean
			  AND board.workspace_id = $1
			  AND (
				lower(issue.title) LIKE $4 ESCAPE '\'
				OR lower(COALESCE(issue.description, '')) LIKE $4 ESCAPE '\'
				OR lower(board.slug || '-' || issue.number::text) LIKE $4 ESCAPE '\'
			  )
			UNION ALL
			SELECT
				'board'::text,
				board.id,
				board.name,
				board.description,
				upper(board.slug),
				NULL::uuid,
				CASE
					WHEN lower(board.slug) = $2 THEN 100
					WHEN lower(board.name) = $2 THEN 90
					WHEN lower(board.slug) LIKE $3 ESCAPE '\' THEN 80
					WHEN lower(board.name) LIKE $3 ESCAPE '\' THEN 70
					WHEN lower(board.name) LIKE $4 ESCAPE '\' THEN 50
					WHEN lower(COALESCE(board.description, '')) LIKE $4 ESCAPE '\' THEN 30
					ELSE 10
				END,
				lower(board.name)
			FROM boards AS board
			WHERE $6::boolean
			  AND board.workspace_id = $1
			  AND (
				lower(board.name) LIKE $4 ESCAPE '\'
				OR lower(COALESCE(board.description, '')) LIKE $4 ESCAPE '\'
				OR lower(board.slug) LIKE $4 ESCAPE '\'
			  )
		)
		SELECT resource_type, id, title, subtitle, identifier, board_id, rank, normalized
		FROM search_results
		WHERE NOT $7::boolean OR (
			rank < $8::integer
			OR (rank = $8::integer AND normalized > $9::text)
			OR (
				rank = $8::integer AND normalized = $9::text
				AND resource_type > $10::text
			)
			OR (
				rank = $8::integer AND normalized = $9::text
				AND resource_type = $10::text AND id > $11::uuid
			)
		)
		ORDER BY rank DESC, normalized ASC, resource_type ASC, id ASC
		LIMIT $12`,
		workspaceID,
		exact,
		prefix,
		contains,
		issueEnabled,
		boardEnabled,
		afterEnabled,
		afterRank,
		afterNormalized,
		afterType,
		afterID,
		filter.Limit,
	)
	if err != nil {
		return nil, classifyQueryError("search workspace", err)
	}
	result := make([]SearchResult, 0, filter.Limit)
	for rows.Next() {
		var item SearchResult
		if err := rows.Scan(
			&item.Type,
			&item.ID,
			&item.Title,
			&item.Subtitle,
			&item.Identifier,
			&item.BoardID,
			&item.Rank,
			&item.Normalized,
		); err != nil {
			rows.Close()
			return nil, errors.New("scan search result")
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, classifyQueryError("iterate search results", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, classifyQueryError("commit search", err)
	}
	return result, nil
}

func (repository *Repository) ListIssueGroups(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter IssueFilter,
	groupBy string,
	after *IssueGroupCursor,
	limit int,
) ([]IssueGroup, error) {
	if limit < 1 || limit > 101 {
		return nil, errors.New("list issue groups: invalid limit")
	}
	keyExpression, labelExpression, err := issueGroupExpressions(groupBy)
	if err != nil {
		return nil, err
	}
	args := issueFilterArgs(workspaceID, filter)
	afterEnabled := after != nil
	var afterCount, afterKey any
	if after != nil {
		afterCount, afterKey = after.Count, after.Key
		if groupBy == "status" {
			afterKey = apiStatusToDatabase(after.Key)
		}
	}
	args = append(args, afterEnabled, afterCount, afterKey, limit)
	query := `WITH filtered AS (
		SELECT ` + keyExpression + ` AS group_key, ` + labelExpression + ` AS group_label
		FROM issues AS issue
		JOIN boards AS board ON board.id = issue.board_id
		 AND issue.deleted_at IS NULL
		LEFT JOIN users AS assignee_user
		  ON issue.assignee_type = 'user' AND assignee_user.id = issue.assignee_id
		LEFT JOIN agents AS assignee_agent
		  ON issue.assignee_type = 'agent' AND assignee_agent.id = issue.assignee_id
		WHERE ` + issueFilterWhere + `
	), grouped AS (
		SELECT group_key, min(group_label) AS group_label, count(*) AS issue_count
		FROM filtered
		GROUP BY group_key
	)
	SELECT group_key, group_label, issue_count
	FROM grouped
	WHERE NOT $16::boolean
	   OR issue_count < $17::bigint
	   OR (issue_count = $17::bigint AND group_key > $18::text)
	ORDER BY issue_count DESC, group_key ASC
	LIMIT $19`
	tx, err := repository.beginBoundedRead(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, classifyQueryError("list issue groups", err)
	}
	result := make([]IssueGroup, 0, limit)
	for rows.Next() {
		var group IssueGroup
		if err := rows.Scan(&group.Key, &group.Label, &group.Count); err != nil {
			rows.Close()
			return nil, errors.New("scan issue group")
		}
		group.Key = databaseStatusToAPI(group.Key)
		group.Label = databaseStatusToAPI(group.Label)
		result = append(result, group)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, classifyQueryError("iterate issue groups", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, classifyQueryError("commit issue groups", err)
	}
	return result, nil
}

func (repository *Repository) ListIssueRows(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter IssueFilter,
	groupBy, groupKey string,
	after *IssueRowCursor,
	limit int,
) ([]IssueRow, error) {
	if limit < 1 || limit > 101 {
		return nil, errors.New("list issue rows: invalid limit")
	}
	keyExpression, _, err := issueGroupExpressions(groupBy)
	if err != nil {
		return nil, err
	}
	if groupBy == "status" {
		groupKey = apiStatusToDatabase(groupKey)
	}
	groupEnabled := groupBy != "none"
	afterEnabled := after != nil
	var afterTime, afterID any
	if after != nil {
		afterTime, afterID = after.UpdatedAt, after.ID
	}
	args := issueFilterArgs(workspaceID, filter)
	args = append(args, groupEnabled, groupKey, afterEnabled, afterTime, afterID, limit)
	query := `WITH filtered AS (
		SELECT
			issue.id, issue.board_id,
			upper(board.slug) || '-' || issue.number::text AS identifier,
			issue.title, issue.status::text, issue.priority::text,
			issue.assignee_type::text, issue.assignee_id, issue.due_date,
			issue.updated_at, ` + keyExpression + ` AS group_key
		FROM issues AS issue
		JOIN boards AS board ON board.id = issue.board_id
		 AND issue.deleted_at IS NULL
		LEFT JOIN users AS assignee_user
		  ON issue.assignee_type = 'user' AND assignee_user.id = issue.assignee_id
		LEFT JOIN agents AS assignee_agent
		  ON issue.assignee_type = 'agent' AND assignee_agent.id = issue.assignee_id
		WHERE ` + issueFilterWhere + `
	)
	SELECT id, board_id, identifier, title, status, priority,
	       assignee_type, assignee_id, due_date, updated_at
	FROM filtered
	WHERE (NOT $16::boolean OR group_key = $17::text)
	  AND (NOT $18::boolean OR
	       (updated_at, id) < ($19::timestamptz, $20::uuid))
	ORDER BY updated_at DESC, id DESC
	LIMIT $21`
	tx, err := repository.beginBoundedRead(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, classifyQueryError("list issue rows", err)
	}
	result := make([]IssueRow, 0, limit)
	for rows.Next() {
		var row IssueRow
		if err := rows.Scan(
			&row.ID,
			&row.BoardID,
			&row.Identifier,
			&row.Title,
			&row.Status,
			&row.Priority,
			&row.AssigneeType,
			&row.AssigneeID,
			&row.DueDate,
			&row.UpdatedAt,
		); err != nil {
			rows.Close()
			return nil, errors.New("scan issue row")
		}
		row.Status = databaseStatusToAPI(row.Status)
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, classifyQueryError("iterate issue rows", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, classifyQueryError("commit issue rows", err)
	}
	return result, nil
}

func (repository *Repository) ListIssueFacets(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter IssueFilter,
) ([]FacetCount, error) {
	args := issueFilterArgs(workspaceID, filter)
	tx, err := repository.beginBoundedRead(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(
		ctx,
		`WITH filtered AS (
			SELECT issue.status::text AS status, issue.priority::text AS priority,
			       board.id, board.name,
			       COALESCE(
			           issue.assignee_type::text || ':' || issue.assignee_id::text,
			           'unassigned'
			       ) AS assignee_key,
			       COALESCE(assignee_user.name, assignee_agent.name, 'Unassigned') AS assignee_name
			FROM issues AS issue
			JOIN boards AS board ON board.id = issue.board_id
			 AND issue.deleted_at IS NULL
			LEFT JOIN users AS assignee_user
			  ON issue.assignee_type = 'user' AND assignee_user.id = issue.assignee_id
			LEFT JOIN agents AS assignee_agent
			  ON issue.assignee_type = 'agent' AND assignee_agent.id = issue.assignee_id
			WHERE `+issueFilterWhere+`
		)
		SELECT facet, key, min(label), count
		FROM (
			SELECT 'status'::text AS facet, status AS key, status AS label, count(*) AS count
			FROM filtered GROUP BY status
			UNION ALL
			SELECT 'priority', priority, priority, count(*)
			FROM filtered GROUP BY priority
			UNION ALL
			SELECT 'board', id::text, min(name), count(*)
			FROM filtered GROUP BY id
			UNION ALL
			SELECT 'assignee', assignee_key, min(assignee_name), count(*)
			FROM filtered GROUP BY assignee_key
		) AS facets
		GROUP BY facet, key, count
		ORDER BY facet ASC, count DESC, key ASC
		LIMIT 500`,
		args...,
	)
	if err != nil {
		return nil, classifyQueryError("list issue facets", err)
	}
	result := make([]FacetCount, 0)
	for rows.Next() {
		var facet FacetCount
		if err := rows.Scan(&facet.Facet, &facet.Key, &facet.Label, &facet.Count); err != nil {
			rows.Close()
			return nil, errors.New("scan issue facet")
		}
		if facet.Facet == "status" {
			facet.Key = databaseStatusToAPI(facet.Key)
			facet.Label = databaseStatusToAPI(facet.Label)
		}
		result = append(result, facet)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, classifyQueryError("iterate issue facets", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, classifyQueryError("commit issue facets", err)
	}
	return result, nil
}

const issueFilterWhere = `
	board.workspace_id = $1
	AND (COALESCE(cardinality($2::uuid[]), 0) = 0 OR issue.board_id = ANY($2::uuid[]))
	AND (COALESCE(cardinality($3::text[]), 0) = 0 OR issue.status::text = ANY($3::text[]))
	AND (COALESCE(cardinality($4::text[]), 0) = 0 OR issue.priority::text = ANY($4::text[]))
	AND (NOT $5::boolean OR (
		issue.assignee_type::text = $6::text AND issue.assignee_id = $7::uuid
	))
	AND (NOT $8::boolean OR (
		issue.assignee_type = 'user' AND issue.assignee_id = $9::uuid
	))
	AND (NOT $10::boolean OR (
		lower(issue.title) LIKE $11::text ESCAPE '\'
		OR lower(board.slug || '-' || issue.number::text) LIKE $11::text ESCAPE '\'
	))
	AND (NOT $12::boolean OR issue.created_at >= $13::timestamptz)
	AND (NOT $14::boolean OR issue.updated_at >= $15::timestamptz)`

func issueFilterArgs(workspaceID uuid.UUID, filter IssueFilter) []any {
	assigneeEnabled := filter.AssigneeType != nil && filter.AssigneeID != nil
	var assigneeType, assigneeID any
	if assigneeEnabled {
		assigneeType, assigneeID = *filter.AssigneeType, *filter.AssigneeID
	}
	queryEnabled := filter.Query != nil
	var query any
	if filter.Query != nil {
		query = "%" + escapeLike(strings.ToLower(*filter.Query)) + "%"
	}
	createdEnabled, updatedEnabled := filter.CreatedAfter != nil, filter.UpdatedAfter != nil
	var createdAfter, updatedAfter any
	if filter.CreatedAfter != nil {
		createdAfter = *filter.CreatedAfter
	}
	if filter.UpdatedAfter != nil {
		updatedAfter = *filter.UpdatedAfter
	}
	return []any{
		workspaceID,
		filter.BoardIDs,
		filter.Statuses,
		filter.Priorities,
		assigneeEnabled,
		assigneeType,
		assigneeID,
		filter.AssignedToMe,
		filter.UserID,
		queryEnabled,
		query,
		createdEnabled,
		createdAfter,
		updatedEnabled,
		updatedAfter,
	}
}

func issueGroupExpressions(groupBy string) (string, string, error) {
	switch groupBy {
	case "none":
		return "'all'::text", "'All issues'::text", nil
	case "status":
		return "issue.status::text", "issue.status::text", nil
	case "priority":
		return "issue.priority::text", "issue.priority::text", nil
	case "board":
		return "board.id::text", "board.name", nil
	case "assignee":
		return `COALESCE(
			issue.assignee_type::text || ':' || issue.assignee_id::text,
			'unassigned'
		)`, "COALESCE(assignee_user.name, assignee_agent.name, 'Unassigned')", nil
	default:
		return "", "", errors.New("invalid issue group")
	}
}

func (repository *Repository) beginBoundedRead(ctx context.Context) (pgx.Tx, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, errors.New("begin bounded query")
	}
	timeout := repository.StatementTimeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	if _, err := tx.Exec(
		ctx,
		"SELECT set_config('statement_timeout', $1, true)",
		fmt.Sprintf("%dms", timeout.Milliseconds()),
	); err != nil {
		_ = tx.Rollback(context.Background())
		return nil, errors.New("set query statement timeout")
	}
	return tx, nil
}

func classifyQueryError(operation string, err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "57014" {
		return ErrQueryTimeout
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func escapeLike(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(value)
}

func databaseStatusToAPI(value string) string {
	switch value {
	case "in_progress":
		return "inProgress"
	case "in_review":
		return "inReview"
	default:
		return value
	}
}

func apiStatusToDatabase(value string) string {
	switch value {
	case "inProgress":
		return "in_progress"
	case "inReview":
		return "in_review"
	default:
		return value
	}
}
