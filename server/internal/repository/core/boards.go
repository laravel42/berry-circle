package core

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type rowScanner interface {
	Scan(...any) error
}

const boardProjection = `
	boards.id, boards.name, boards.slug, boards.description, boards.columns,
	boards.created_at, boards.updated_at`

// ListBoards returns one over-fetched stable page.
func (repository *Repository) ListBoards(
	ctx context.Context,
	userID uuid.UUID,
	after *BoardCursor,
	limit int,
) ([]Board, error) {
	if limit < 1 {
		return nil, errors.New("list boards: invalid limit")
	}
	query := `SELECT ` + boardProjection + `
		FROM boards
		JOIN workspaces
		  ON workspaces.id = boards.workspace_id
		 AND workspaces.deleted_at IS NULL
		JOIN workspace_memberships
		  ON workspace_memberships.workspace_id = boards.workspace_id
		 AND workspace_memberships.user_id = $1`
	arguments := []any{userID}
	if after != nil {
		query += ` WHERE (boards.created_at, boards.id) < ($2::timestamptz, $3::uuid)`
		arguments = append(arguments, after.CreatedAt, after.ID)
	}
	query += ` ORDER BY boards.created_at DESC, boards.id DESC LIMIT $` +
		fmt.Sprint(len(arguments)+1)
	arguments = append(arguments, limit)

	rows, err := repository.Pool.Query(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("list boards: %w", err)
	}
	defer rows.Close()

	boards := make([]Board, 0, limit)
	for rows.Next() {
		board, err := scanBoard(rows)
		if err != nil {
			return nil, err
		}
		boards = append(boards, board)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate boards: %w", err)
	}
	return boards, nil
}

// GetBoard returns a board by its immutable UUID.
func (repository *Repository) GetBoard(
	ctx context.Context,
	id, workspaceID uuid.UUID,
) (Board, error) {
	board, err := scanBoard(repository.Pool.QueryRow(
		ctx,
		`SELECT `+boardProjection+`
		   FROM boards
		  WHERE id = $1 AND workspace_id = $2`,
		id,
		workspaceID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Board{}, ErrNotFound
	}
	return board, err
}

// BoardExists distinguishes a missing filter scope before listing issues.
func (repository *Repository) BoardExists(ctx context.Context, id uuid.UUID) (bool, error) {
	var exists bool
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT EXISTS (SELECT 1 FROM boards WHERE id = $1)`,
		id,
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("check board existence: %w", err)
	}
	return exists, nil
}

// CreateBoard inserts a board with its authenticated creator.
func (repository *Repository) CreateBoard(
	ctx context.Context,
	board Board,
	createdBy, workspaceID uuid.UUID,
) (Board, error) {
	columns, err := encodeColumns(board.Columns)
	if err != nil {
		return Board{}, err
	}
	created, err := scanBoard(repository.Pool.QueryRow(
		ctx,
		`INSERT INTO boards (
			id, workspace_id, name, slug, description, columns,
			created_by, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8)
		 RETURNING `+boardProjection,
		board.ID,
		workspaceID,
		board.Name,
		board.Slug,
		board.Description,
		columns,
		createdBy,
		board.CreatedAt,
	))
	if err != nil {
		return Board{}, classifyWriteError("create board", err)
	}
	return created, nil
}

// UpdateBoard locks the board, protects live columns, then applies one patch.
func (repository *Repository) UpdateBoard(
	ctx context.Context,
	id, workspaceID uuid.UUID,
	patch BoardPatch,
	updatedAt time.Time,
) (Board, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Board{}, fmt.Errorf("begin board update: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var currentColumnsJSON []byte
	if err := tx.QueryRow(
		ctx,
		`SELECT columns
		   FROM boards
		  WHERE id = $1 AND workspace_id = $2
		  FOR UPDATE`,
		id,
		workspaceID,
	).Scan(&currentColumnsJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Board{}, ErrNotFound
		}
		return Board{}, fmt.Errorf("lock board: %w", err)
	}

	var columnsJSON []byte
	if patch.Columns != nil {
		currentColumns, err := decodeColumns(currentColumnsJSON)
		if err != nil {
			return Board{}, err
		}
		next := make(map[string]struct{}, len(*patch.Columns))
		for _, column := range *patch.Columns {
			next[column.ID] = struct{}{}
		}
		blocking := make([]string, 0)
		for _, column := range currentColumns {
			if _, retained := next[column.ID]; retained ||
				column.ID == "done" || column.ID == "cancelled" {
				continue
			}
			blocking = append(blocking, apiStatusToDB(column.ID))
		}
		if len(blocking) > 0 {
			var inUse bool
			if err := tx.QueryRow(
				ctx,
				`SELECT EXISTS (
					SELECT 1 FROM issues
					 WHERE board_id = $1 AND status::text = ANY($2::text[])
				)`,
				id,
				blocking,
			).Scan(&inUse); err != nil {
				return Board{}, fmt.Errorf("check board columns: %w", err)
			}
			if inUse {
				return Board{}, ErrColumnInUse
			}
		}
		columnsJSON, err = encodeColumns(*patch.Columns)
		if err != nil {
			return Board{}, err
		}
	}

	updated, err := scanBoard(tx.QueryRow(
		ctx,
		`UPDATE boards SET
			name = CASE WHEN $2 THEN $3::text ELSE name END,
			slug = CASE WHEN $4 THEN $5::text ELSE slug END,
			description = CASE WHEN $6 THEN $7::text ELSE description END,
			columns = CASE WHEN $8 THEN $9::jsonb ELSE columns END,
			updated_at = $10
		 WHERE id = $1 AND workspace_id = $11
		 RETURNING `+boardProjection,
		id,
		patch.Name != nil,
		patch.Name,
		patch.Slug != nil,
		patch.Slug,
		patch.DescriptionSet,
		patch.Description,
		patch.Columns != nil,
		columnsJSON,
		updatedAt,
		workspaceID,
	))
	if err != nil {
		return Board{}, classifyWriteError("update board", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Board{}, fmt.Errorf("commit board update: %w", err)
	}
	return updated, nil
}

func scanBoard(row rowScanner) (Board, error) {
	var (
		board       Board
		columnsJSON []byte
	)
	if err := row.Scan(
		&board.ID,
		&board.Name,
		&board.Slug,
		&board.Description,
		&columnsJSON,
		&board.CreatedAt,
		&board.UpdatedAt,
	); err != nil {
		return Board{}, err
	}
	columns, err := decodeColumns(columnsJSON)
	if err != nil {
		return Board{}, err
	}
	board.Columns = columns
	return board, nil
}
