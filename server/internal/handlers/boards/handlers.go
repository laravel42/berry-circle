// Package boards exports the disjoint authenticated /api/v1/boards mount.
package boards

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

const boardCursorScope = "boards.list"

// Options are explicit process dependencies; no handler uses package globals.
type Options struct {
	Pool             *pgxpool.Pool
	Sessions         auth.SessionResolver
	Authorization    Authorizer
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	RunHandler       http.Handler
}

// Authorizer is the narrow workspace boundary consumed by board routes.
type Authorizer interface {
	AuthorizeWorkspace(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Role, error)
	AuthorizeBoard(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
}

// NewMount validates dependencies and builds the board subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Pool == nil {
		return httpapi.Mount{}, errors.New("board handler pool is nil")
	}
	if options.Sessions == nil {
		return httpapi.Mount{}, errors.New("board handler session resolver is nil")
	}
	if options.Authorization == nil {
		return httpapi.Mount{}, errors.New("board handler authorizer is nil")
	}
	if options.Clock == nil {
		return httpapi.Mount{}, errors.New("board handler clock is nil")
	}
	if options.NewID == nil {
		return httpapi.Mount{}, errors.New("board handler ID generator is nil")
	}
	if options.IdempotencyStore == nil {
		return httpapi.Mount{}, errors.New("board handler idempotency store is nil")
	}
	repository, err := core.New(options.Pool)
	if err != nil {
		return httpapi.Mount{}, err
	}

	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", listHandler(repository))
	router.Post(
		"/",
		requireIdempotency(
			options.IdempotencyStore,
			options.Clock,
			http.HandlerFunc(createHandler(repository, options)),
		).ServeHTTP,
	)
	router.Get("/{boardId}", getHandler(repository, options.Authorization))
	router.Patch("/{boardId}", updateHandler(repository, options))
	if options.RunHandler != nil {
		router.Mount(
			"/{boardId}/runs",
			authorizeBoardNested(options.Authorization, options.RunHandler),
		)
	}
	return httpapi.Mount{Prefix: "/api/v1/boards", Handler: router}, nil
}

// Mounts follows the shared registry convention and fails fast on bad wiring.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic(fmt.Sprintf("construct board handlers: %v", err))
	}
	return []httpapi.Mount{mount}
}

type boardResource struct {
	ID          uuid.UUID          `json:"id"`
	Name        string             `json:"name"`
	Slug        string             `json:"slug"`
	Description *string            `json:"description"`
	Columns     []core.BoardColumn `json:"columns"`
	CreatedAt   string             `json:"createdAt"`
	UpdatedAt   string             `json:"updatedAt"`
}

type pageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type boardConnection struct {
	Nodes    []boardResource `json:"nodes"`
	PageInfo pageInfo        `json:"pageInfo"`
}

func listHandler(repository *core.Repository) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		first, encodedAfter, ok := parsePage(response, request)
		if !ok {
			return
		}
		var after *core.BoardCursor
		if encodedAfter != "" {
			var decoded core.BoardCursor
			if err := httpapi.DecodeCursor(encodedAfter, boardCursorScope, &decoded); err != nil ||
				decoded.ID == uuid.Nil || decoded.CreatedAt.IsZero() {
				writeInvalidCursor(response, request)
				return
			}
			after = &decoded
		}
		user := auth.MustUser(request.Context())
		rows, err := repository.ListBoards(request.Context(), user.ID, after, first+1)
		if err != nil {
			writeInternal(response, request)
			return
		}
		hasNextPage := len(rows) > first
		if hasNextPage {
			rows = rows[:first]
		}
		nodes := make([]boardResource, 0, len(rows))
		for _, board := range rows {
			nodes = append(nodes, serializeBoard(board))
		}
		var endCursor *string
		if len(rows) > 0 {
			last := rows[len(rows)-1]
			encoded, err := httpapi.EncodeCursor(boardCursorScope, core.BoardCursor{
				CreatedAt: last.CreatedAt,
				ID:        last.ID,
			})
			if err != nil {
				writeInternal(response, request)
				return
			}
			endCursor = &encoded
		}
		httpapi.WriteJSON(response, http.StatusOK, boardConnection{
			Nodes: nodes,
			PageInfo: pageInfo{
				HasNextPage: hasNextPage,
				EndCursor:   endCursor,
			},
		})
	}
}

func createHandler(
	repository *core.Repository,
	options Options,
) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		input, ok := parseCreateBoard(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		if user.CurrentWorkspaceID == nil {
			writeBoardNotFound(response, request)
			return
		}
		if _, err := options.Authorization.AuthorizeWorkspace(
			request.Context(),
			user.ID,
			*user.CurrentWorkspaceID,
			identity.PermissionWrite,
		); !writeAuthorizationError(response, request, err) {
			return
		}
		now := options.Clock().UTC()
		created, err := repository.CreateBoard(request.Context(), core.Board{
			ID:          options.NewID(),
			Name:        input.Name,
			Slug:        input.Slug,
			Description: input.Description,
			Columns:     input.Columns,
			CreatedAt:   now,
			UpdatedAt:   now,
		}, user.ID, *user.CurrentWorkspaceID)
		if err != nil {
			switch {
			case errors.Is(err, core.ErrConflict):
				httpapi.WriteError(
					response,
					request,
					http.StatusConflict,
					"CONFLICT",
					"A board with this slug already exists.",
					nil,
				)
			case errors.Is(err, core.ErrNotFound):
				writeUnauthenticated(response, request)
			default:
				writeInternal(response, request)
			}
			return
		}
		response.Header().Set("Location", "/api/v1/boards/"+created.ID.String())
		httpapi.WriteJSON(response, http.StatusCreated, serializeBoard(created))
	}
}

func getHandler(repository *core.Repository, authorizer Authorizer) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		id, err := core.ParseUUID(chi.URLParam(request, "boardId"))
		if err != nil {
			writeBoardNotFound(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := authorizer.AuthorizeBoard(
			request.Context(),
			user.ID,
			id,
			identity.PermissionRead,
		)
		if !writeAuthorizationError(response, request, err) {
			return
		}
		board, err := repository.GetBoard(request.Context(), id, scope.WorkspaceID)
		if errors.Is(err, core.ErrNotFound) {
			writeBoardNotFound(response, request)
			return
		}
		if err != nil {
			writeInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, serializeBoard(board))
	}
}

func updateHandler(
	repository *core.Repository,
	options Options,
) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		id, err := core.ParseUUID(chi.URLParam(request, "boardId"))
		if err != nil {
			writeBoardNotFound(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := options.Authorization.AuthorizeBoard(
			request.Context(),
			user.ID,
			id,
			identity.PermissionWrite,
		)
		if !writeAuthorizationError(response, request, err) {
			return
		}
		patch, ok := parseBoardPatch(response, request)
		if !ok {
			return
		}
		board, err := repository.UpdateBoard(
			request.Context(),
			id,
			scope.WorkspaceID,
			patch,
			options.Clock().UTC(),
		)
		switch {
		case errors.Is(err, core.ErrNotFound):
			writeBoardNotFound(response, request)
			return
		case errors.Is(err, core.ErrConflict):
			httpapi.WriteError(
				response,
				request,
				http.StatusConflict,
				"CONFLICT",
				"A board with this slug already exists.",
				nil,
			)
			return
		case errors.Is(err, core.ErrColumnInUse):
			httpapi.WriteError(
				response,
				request,
				http.StatusConflict,
				"CONFLICT",
				"A status column cannot be removed while non-terminal issues use it.",
				nil,
			)
			return
		case err != nil:
			writeInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, serializeBoard(board))
	}
}

func writeAuthorizationError(
	response http.ResponseWriter,
	request *http.Request,
	err error,
) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, identity.ErrNotFound):
		writeBoardNotFound(response, request)
	case errors.Is(err, identity.ErrForbidden):
		httpapi.WriteError(
			response,
			request,
			http.StatusForbidden,
			"FORBIDDEN",
			"You do not have permission to perform this action.",
			nil,
		)
	default:
		writeInternal(response, request)
	}
	return false
}

func serializeBoard(board core.Board) boardResource {
	return boardResource{
		ID:          board.ID,
		Name:        board.Name,
		Slug:        board.Slug,
		Description: board.Description,
		Columns:     board.Columns,
		CreatedAt:   board.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   board.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func writeInvalidCursor(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_CURSOR",
		"The pagination cursor is invalid.",
		nil,
	)
}

func authorizeBoardNested(authorizer Authorizer, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		boardID, err := core.ParseUUID(chi.URLParam(request, "boardId"))
		if err != nil || boardID == uuid.Nil {
			writeBoardNotFound(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		if _, err := authorizer.AuthorizeBoard(
			request.Context(),
			user.ID,
			boardID,
			identity.PermissionRead,
		); !writeAuthorizationError(response, request, err) {
			return
		}
		next.ServeHTTP(response, request)
	})
}

func writeBoardNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		"Board not found.",
		nil,
	)
}
