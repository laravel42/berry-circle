// Package comments exports direct comment CRUD and issue-nested comment routes.
package comments

import (
	"context"
	"crypto/sha256"
	"encoding/json"
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
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Options are explicit process dependencies; no handler uses package globals.
type Options struct {
	Pool             *pgxpool.Pool
	Sessions         auth.SessionResolver
	Authorization    Authorizer
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	// Broadcaster is optional until the parent process wires the P2 lane.
	// Durable outbox records are persisted regardless of live delivery.
	Broadcaster realtime.Broadcaster
	// Optional P2 collaboration subtrees on the direct comment mount.
	AttachmentHandler http.Handler
	ReactionHandler   http.Handler
	ResolutionHandler http.Handler
}

// Authorizer is the narrow issue/comment workspace boundary.
type Authorizer interface {
	AuthorizeIssue(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
	AuthorizeComment(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
}

// NewMount returns the disjoint direct /api/v1/comments mount.
func NewMount(options Options) (httpapi.Mount, error) {
	if err := validateOptions(options); err != nil {
		return httpapi.Mount{}, err
	}
	repository, err := core.New(options.Pool)
	if err != nil {
		return httpapi.Mount{}, err
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/{commentId}", getHandler(repository, options.Authorization))
	router.Patch("/{commentId}", updateHandler(repository, options))
	router.Delete("/{commentId}", deleteHandler(repository, options))
	if options.AttachmentHandler != nil {
		router.Mount("/{commentId}/attachments", options.AttachmentHandler)
	}
	if options.ReactionHandler != nil {
		router.Mount("/{commentId}/reactions", options.ReactionHandler)
	}
	if options.ResolutionHandler != nil {
		router.Mount("/{commentId}/resolution", options.ResolutionHandler)
	}
	return httpapi.Mount{Prefix: "/api/v1/comments", Handler: router}, nil
}

// NewIssueHandler returns routes mounted below /api/v1/issues/{issueRef}/comments.
// The owning issue router applies RequireSession before entering this subtree.
func NewIssueHandler(options Options) (http.Handler, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	repository, err := core.New(options.Pool)
	if err != nil {
		return nil, err
	}
	router := httpapi.NewSubrouter()
	router.Get("/", listHandler(repository, options.Authorization))
	router.Post(
		"/",
		requireIdempotency(
			options.IdempotencyStore,
			options.Clock,
			http.HandlerFunc(createHandler(repository, options)),
		).ServeHTTP,
	)
	return router, nil
}

// Mounts follows the shared registry convention and fails fast on invalid wiring.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic(fmt.Sprintf("construct comment handlers: %v", err))
	}
	return []httpapi.Mount{mount}
}

func validateOptions(options Options) error {
	if options.Pool == nil {
		return errors.New("comment handler pool is nil")
	}
	if options.Sessions == nil {
		return errors.New("comment handler session resolver is nil")
	}
	if options.Authorization == nil {
		return errors.New("comment handler authorizer is nil")
	}
	if options.Clock == nil {
		return errors.New("comment handler clock is nil")
	}
	if options.NewID == nil {
		return errors.New("comment handler ID generator is nil")
	}
	if options.IdempotencyStore == nil {
		return errors.New("comment handler idempotency store is nil")
	}
	return nil
}

type commentResource struct {
	ID         uuid.UUID      `json:"id"`
	IssueID    uuid.UUID      `json:"issueId"`
	Body       string         `json:"body"`
	Author     core.ActorRef  `json:"author"`
	ParentID   *uuid.UUID     `json:"parentId"`
	Revision   int64          `json:"revision"`
	ResolvedAt *string        `json:"resolvedAt"`
	ResolvedBy *core.ActorRef `json:"resolvedBy"`
	CreatedAt  string         `json:"createdAt"`
	UpdatedAt  string         `json:"updatedAt"`
}

type commentPageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type commentConnection struct {
	Nodes    []commentResource `json:"nodes"`
	PageInfo commentPageInfo   `json:"pageInfo"`
}

func listHandler(repository *core.Repository, authorizer Authorizer) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		issue, err := repository.GetIssue(request.Context(), chi.URLParam(request, "issueRef"))
		if errors.Is(err, core.ErrNotFound) {
			writeIssueNotFound(response, request)
			return
		}
		if err != nil {
			writeCommentInternal(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		if _, err := authorizer.AuthorizeIssue(
			request.Context(),
			user.ID,
			issue.ID,
			identity.PermissionRead,
		); !writeCommentAuthorization(response, request, err, true) {
			return
		}
		first, encodedAfter, ok := parseCommentPage(response, request)
		if !ok {
			return
		}
		scope := commentCursorScope(issue.ID)
		var after *core.CommentCursor
		if encodedAfter != "" {
			var decoded core.CommentCursor
			if err := httpapi.DecodeCursor(encodedAfter, scope, &decoded); err != nil ||
				decoded.ID == uuid.Nil || decoded.CreatedAt.IsZero() {
				writeCommentInvalidCursor(response, request)
				return
			}
			after = &decoded
		}
		rows, err := repository.ListComments(request.Context(), issue.ID, after, first+1)
		if err != nil {
			writeCommentInternal(response, request)
			return
		}
		hasNextPage := len(rows) > first
		if hasNextPage {
			rows = rows[:first]
		}
		nodes := make([]commentResource, 0, len(rows))
		for _, comment := range rows {
			nodes = append(nodes, serializeComment(comment))
		}
		var endCursor *string
		if len(rows) > 0 {
			last := rows[len(rows)-1]
			encoded, err := httpapi.EncodeCursor(scope, core.CommentCursor{
				CreatedAt: last.CreatedAt,
				ID:        last.ID,
			})
			if err != nil {
				writeCommentInternal(response, request)
				return
			}
			endCursor = &encoded
		}
		httpapi.WriteJSON(response, http.StatusOK, commentConnection{
			Nodes: nodes,
			PageInfo: commentPageInfo{
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
		issue, err := repository.GetIssue(request.Context(), chi.URLParam(request, "issueRef"))
		if errors.Is(err, core.ErrNotFound) {
			writeIssueNotFound(response, request)
			return
		}
		if err != nil {
			writeCommentInternal(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		if _, err := options.Authorization.AuthorizeIssue(
			request.Context(),
			user.ID,
			issue.ID,
			identity.PermissionCommentWrite,
		); !writeCommentAuthorization(response, request, err, true) {
			return
		}
		body, parentID, ok := parseCreateComment(response, request)
		if !ok {
			return
		}
		created, event, err := repository.CreateComment(request.Context(), core.CreateCommentParams{
			ID:         options.NewID(),
			IssueID:    issue.ID,
			AuthorType: "user",
			AuthorID:   user.ID,
			Body:       body,
			ParentID:   parentID,
			CreatedAt:  options.Clock().UTC(),
		}, options.NewID())
		switch {
		case errors.Is(err, core.ErrInvalidParent):
			writeCommentValidation(response, request, commentFieldError(
				"/parentId",
				"invalid_parent",
				"A reply cannot be nested under another reply.",
			))
			return
		case errors.Is(err, core.ErrNotFound):
			httpapi.WriteError(
				response,
				request,
				http.StatusNotFound,
				"NOT_FOUND",
				"Parent comment not found.",
				nil,
			)
			return
		case err != nil:
			writeCommentInternal(response, request)
			return
		}
		publishCommentEvent(request.Context(), options.Broadcaster, event)
		response.Header().Set("Location", "/api/v1/comments/"+created.ID.String())
		httpapi.WriteJSON(response, http.StatusCreated, serializeComment(created))
	}
}

func getHandler(repository *core.Repository, authorizer Authorizer) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		id, ok := parseCommentID(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		if _, err := authorizer.AuthorizeComment(
			request.Context(),
			user.ID,
			id,
			identity.PermissionRead,
		); !writeCommentAuthorization(response, request, err, false) {
			return
		}
		comment, err := repository.GetComment(request.Context(), id)
		if errors.Is(err, core.ErrNotFound) {
			writeCommentNotFound(response, request)
			return
		}
		if err != nil {
			writeCommentInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, serializeComment(comment))
	}
}

func updateHandler(
	repository *core.Repository,
	options Options,
) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		id, ok := parseCommentID(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := options.Authorization.AuthorizeComment(
			request.Context(),
			user.ID,
			id,
			identity.PermissionCommentWrite,
		)
		if !writeCommentAuthorization(response, request, err, false) {
			return
		}
		existing, err := repository.GetComment(request.Context(), id)
		if errors.Is(err, core.ErrNotFound) {
			writeCommentNotFound(response, request)
			return
		}
		if err != nil {
			writeCommentInternal(response, request)
			return
		}
		moderator := scope.Role == identity.RoleOwner || scope.Role == identity.RoleAdmin
		if !moderator &&
			(existing.Author.Type != "user" || existing.Author.ID != user.ID) {
			writeCommentForbidden(response, request, "edit")
			return
		}
		body, expectedRevision, valid := parseUpdateComment(response, request)
		if !valid {
			return
		}
		updated, event, err := repository.UpdateComment(
			request.Context(),
			id,
			user.ID,
			moderator,
			body,
			expectedRevision,
			options.NewID(),
			options.Clock().UTC(),
		)
		switch {
		case errors.Is(err, core.ErrNotFound):
			writeCommentNotFound(response, request)
			return
		case errors.Is(err, core.ErrForbidden):
			writeCommentForbidden(response, request, "edit")
			return
		case errors.Is(err, core.ErrRevisionConflict):
			var conflict *core.RevisionConflictError
			if !errors.As(err, &conflict) {
				writeCommentInternal(response, request)
				return
			}
			httpapi.WriteError(
				response,
				request,
				http.StatusConflict,
				"REVISION_CONFLICT",
				"The comment changed since it was last read.",
				map[string]int64{"currentRevision": conflict.CurrentRevision},
			)
			return
		case err != nil:
			writeCommentInternal(response, request)
			return
		}
		publishCommentEvent(request.Context(), options.Broadcaster, event)
		httpapi.WriteJSON(response, http.StatusOK, serializeComment(updated))
	}
}

func deleteHandler(repository *core.Repository, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		id, ok := parseCommentID(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := options.Authorization.AuthorizeComment(
			request.Context(),
			user.ID,
			id,
			identity.PermissionCommentWrite,
		)
		if !writeCommentAuthorization(response, request, err, false) {
			return
		}
		moderator := scope.Role == identity.RoleOwner || scope.Role == identity.RoleAdmin
		event, err := repository.DeleteComment(
			request.Context(),
			id,
			user.ID,
			moderator,
			options.NewID(),
			options.Clock().UTC(),
		)
		switch {
		case errors.Is(err, core.ErrNotFound):
			writeCommentNotFound(response, request)
			return
		case errors.Is(err, core.ErrForbidden):
			writeCommentForbidden(response, request, "delete")
			return
		case err != nil:
			writeCommentInternal(response, request)
			return
		}
		publishCommentEvent(request.Context(), options.Broadcaster, event)
		response.WriteHeader(http.StatusNoContent)
	}
}

func writeCommentAuthorization(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	issue bool,
) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, identity.ErrNotFound):
		if issue {
			writeIssueNotFound(response, request)
		} else {
			writeCommentNotFound(response, request)
		}
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
		writeCommentInternal(response, request)
	}
	return false
}

func parseCommentID(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, bool) {
	id, err := core.ParseUUID(chi.URLParam(request, "commentId"))
	if err != nil {
		writeCommentNotFound(response, request)
		return uuid.Nil, false
	}
	return id, true
}

func serializeComment(comment core.Comment) commentResource {
	var resolvedAt *string
	if comment.ResolvedAt != nil {
		formatted := comment.ResolvedAt.UTC().Format(time.RFC3339Nano)
		resolvedAt = &formatted
	}
	return commentResource{
		ID:         comment.ID,
		IssueID:    comment.IssueID,
		Body:       comment.Body,
		Author:     comment.Author,
		ParentID:   comment.ParentID,
		Revision:   comment.Revision,
		ResolvedAt: resolvedAt,
		ResolvedBy: comment.ResolvedBy,
		CreatedAt:  comment.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:  comment.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func publishCommentEvent(
	ctx context.Context,
	broadcaster realtime.Broadcaster,
	event core.CommentMutationEvent,
) {
	if broadcaster == nil || event.ID == uuid.Nil {
		return
	}
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = broadcaster.Publish(publishCtx, realtime.Event{
		ID:          event.ID.String(),
		WorkspaceID: event.WorkspaceID.String(),
		Type:        event.Type,
		Payload:     json.RawMessage(event.Payload),
		OccurredAt:  event.OccurredAt,
	})
}

func commentCursorScope(issueID uuid.UUID) string {
	sum := sha256.Sum256([]byte(issueID.String()))
	return fmt.Sprintf("comments.list.%x", sum[:8])
}

func writeIssueNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		"Issue not found.",
		nil,
	)
}

func writeCommentNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		"Comment not found.",
		nil,
	)
}

func writeCommentForbidden(
	response http.ResponseWriter,
	request *http.Request,
	operation string,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusForbidden,
		"FORBIDDEN",
		"Only the author or an administrator may "+operation+" this comment.",
		nil,
	)
}

func writeCommentUnauthenticated(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnauthorized,
		"UNAUTHENTICATED",
		"Authentication required.",
		nil,
	)
}

func writeCommentInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusInternalServerError,
		"INTERNAL",
		"Internal server error.",
		nil,
	)
}
