// Package issues exports the authenticated /api/v1/issues mount.
package issues

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
	"github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/handlers/comments"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	goalrepo "github.com/laravel42/berry-circle/server/internal/repository/goals"
)

// Options are explicit process dependencies; no handler uses package globals.
type Options struct {
	Pool             *pgxpool.Pool
	Sessions         auth.SessionResolver
	Authorization    Authorizer
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Broadcaster      realtime.Broadcaster
	// RunHandler optionally mounts /{issueRef}/runs. The issue router owns auth.
	RunHandler http.Handler
	// Optional P2 collaboration subtrees. The issue router owns auth.
	AttachmentHandler http.Handler
	// AutoReviews reads the peer verdicts on an issue. Optional.
	AutoReviews AutoReviewStore
	// ArtifactHandler lists what the agents on an issue produced. Optional.
	ArtifactHandler http.Handler
	// Goals links an issue to a goal; built from the pool when nil.
	Goals GoalStore
	// Approvals names the gate that refused a status move; built from the
	// pool when nil.
	Approvals ApprovalLookup
}

// GoalStore is what the goal link on an issue write needs.
type GoalStore interface {
	Get(context.Context, uuid.UUID) (goalrepo.Goal, error)
	LinkIssue(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, time.Time) error
	ClearIssueGoal(context.Context, uuid.UUID) error
}

// ApprovalLookup finds the approval an APPROVAL_REQUIRED refusal points at.
type ApprovalLookup interface {
	LatestForIssue(context.Context, uuid.UUID, approvalrepo.Kind) (approvalrepo.Approval, error)
}

// Authorizer is the narrow board/issue workspace boundary.
type Authorizer interface {
	AuthorizeBoard(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
	AuthorizeIssue(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
	AuthorizeIssueReference(
		context.Context,
		uuid.UUID,
		string,
		identity.Permission,
	) (identity.Scope, error)
	AuthorizeComment(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
	ValidateAssignee(
		context.Context,
		uuid.UUID,
		string,
		uuid.UUID,
	) error
}

// NewMount validates dependencies and builds issues plus nested comments.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Pool == nil {
		return httpapi.Mount{}, errors.New("issue handler pool is nil")
	}
	if options.Sessions == nil {
		return httpapi.Mount{}, errors.New("issue handler session resolver is nil")
	}
	if options.Authorization == nil {
		return httpapi.Mount{}, errors.New("issue handler authorizer is nil")
	}
	if options.Clock == nil {
		return httpapi.Mount{}, errors.New("issue handler clock is nil")
	}
	if options.NewID == nil {
		return httpapi.Mount{}, errors.New("issue handler ID generator is nil")
	}
	if options.IdempotencyStore == nil {
		return httpapi.Mount{}, errors.New("issue handler idempotency store is nil")
	}
	repository, err := core.New(options.Pool)
	if err != nil {
		return httpapi.Mount{}, err
	}
	if options.Goals == nil {
		goals, err := goalrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Goals = goals
	}
	if options.Approvals == nil {
		approvals, err := approvalrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Approvals = approvals
	}
	commentRoutes, err := comments.NewIssueHandler(comments.Options{
		Pool:             options.Pool,
		Sessions:         options.Sessions,
		Authorization:    options.Authorization,
		Clock:            options.Clock,
		NewID:            options.NewID,
		IdempotencyStore: options.IdempotencyStore,
		Broadcaster:      options.Broadcaster,
	})
	if err != nil {
		return httpapi.Mount{}, err
	}

	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", listHandler(repository, options.Authorization))
	router.Post(
		"/",
		requireIdempotency(
			options.IdempotencyStore,
			options.Clock,
			http.HandlerFunc(createHandler(repository, options)),
		).ServeHTTP,
	)
	router.Mount("/{issueRef}/comments", commentRoutes)
	if options.RunHandler != nil {
		router.Mount(
			"/{issueRef}/runs",
			authorizeIssueNested(
				options.Authorization,
				identity.PermissionRunsDispatch,
				options.RunHandler,
			),
		)
	}
	if options.AttachmentHandler != nil {
		router.Mount(
			"/{issueRef}/attachments",
			authorizeIssueNested(
				options.Authorization,
				identity.PermissionWrite,
				options.AttachmentHandler,
			),
		)
	}
	if options.ArtifactHandler != nil {
		// Read, not write: nobody uploads an artifact, an agent produces one.
		router.Mount(
			"/{issueRef}/artifacts",
			authorizeIssueNested(
				options.Authorization,
				identity.PermissionRead,
				options.ArtifactHandler,
			),
		)
	}
	router.Get("/{issueRef}", getHandler(repository, options))
	router.Patch("/{issueRef}", updateHandler(repository, options))
	router.Delete("/{issueRef}", deleteHandler(repository, options))
	router.Get("/{issueRef}/reviews", listAutoReviewsHandler(options.AutoReviews))
	router.Get("/{issueRef}/dependencies", listDependenciesHandler(repository, options))
	router.Post("/{issueRef}/dependencies", addDependencyHandler(repository, options))
	router.Delete("/{issueRef}/dependencies/{dependsOnRef}", removeDependencyHandler(repository, options))
	return httpapi.Mount{Prefix: "/api/v1/issues", Handler: router}, nil
}

// Mounts follows the shared registry convention and fails fast on invalid wiring.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic(fmt.Sprintf("construct issue handlers: %v", err))
	}
	return []httpapi.Mount{mount}
}

type issueResource struct {
	ID          uuid.UUID        `json:"id"`
	BoardID     uuid.UUID        `json:"boardId"`
	Number      int32            `json:"number"`
	Identifier  string           `json:"identifier"`
	Title       string           `json:"title"`
	Description *string          `json:"description"`
	Status      string           `json:"status"`
	Priority    string           `json:"priority"`
	SortOrder   int32            `json:"sortOrder"`
	DueDate     *string          `json:"dueDate"`
	Assignee    *core.ActorRef   `json:"assignee"`
	ActiveRunID *uuid.UUID       `json:"activeRunId"`
	Project     *core.ProjectRef `json:"project"`
	CreatedBy   *core.ActorRef   `json:"createdBy"`
	CreatedAt   string           `json:"createdAt"`
	UpdatedAt   string           `json:"updatedAt"`
	// Goal, Origin, DependsOn and Blocks are the issue's place in a plan:
	// what it serves, which workflow run created it, and what must finish
	// before and after it.
	Goal      *core.GoalRef             `json:"goal"`
	Origin    *core.IssueOrigin         `json:"origin"`
	DependsOn []core.IssueDependencyRef `json:"dependsOn"`
	Blocks    []core.IssueDependencyRef `json:"blocks"`
}

type issuePageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type issueConnection struct {
	Nodes    []issueResource `json:"nodes"`
	PageInfo issuePageInfo   `json:"pageInfo"`
}

func listHandler(repository *core.Repository, authorizer Authorizer) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		query, ok := parseIssueQuery(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		if _, err := authorizer.AuthorizeBoard(
			request.Context(),
			user.ID,
			query.BoardID,
			identity.PermissionRead,
		); !writeIssueAuthorization(response, request, err, true) {
			return
		}
		scope := issueCursorScope(query)
		var after *core.IssueCursor
		if query.After != "" {
			var decoded core.IssueCursor
			if err := httpapi.DecodeCursor(query.After, scope, &decoded); err != nil ||
				decoded.ID == uuid.Nil || decoded.UpdatedAt.IsZero() {
				writeIssueInvalidCursor(response, request)
				return
			}
			after = &decoded
		}
		rows, err := repository.ListIssues(request.Context(), core.IssueListFilter{
			BoardID:    query.BoardID,
			Statuses:   query.Statuses,
			Priorities: query.Priorities,
			Assignee:   query.Assignee,
			Query:      query.Query,
			After:      after,
			Limit:      query.First + 1,
		})
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		hasNextPage := len(rows) > query.First
		if hasNextPage {
			rows = rows[:query.First]
		}
		ids := make([]uuid.UUID, 0, len(rows))
		for _, issue := range rows {
			ids = append(ids, issue.ID)
		}
		relations, err := core.LoadIssueRelations(request.Context(), repository.Pool, ids)
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		nodes := make([]issueResource, 0, len(rows))
		for _, issue := range rows {
			nodes = append(nodes, serializeIssue(issue, relations[issue.ID]))
		}
		var endCursor *string
		if len(rows) > 0 {
			last := rows[len(rows)-1]
			encoded, err := httpapi.EncodeCursor(scope, core.IssueCursor{
				UpdatedAt: last.UpdatedAt,
				ID:        last.ID,
			})
			if err != nil {
				writeIssueInternal(response, request)
				return
			}
			endCursor = &encoded
		}
		httpapi.WriteJSON(response, http.StatusOK, issueConnection{
			Nodes: nodes,
			PageInfo: issuePageInfo{
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
		input, ok := parseCreateIssue(response, request)
		if !ok {
			return
		}
		if input.Status == "in_review" || input.Status == "done" {
			writeTransition(response, request, "backlog", dbStatusToAPI(input.Status))
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := options.Authorization.AuthorizeBoard(
			request.Context(),
			user.ID,
			input.BoardID,
			identity.PermissionWrite,
		)
		if !writeIssueAuthorization(response, request, err, true) {
			return
		}
		if input.Assignee != nil {
			err := options.Authorization.ValidateAssignee(
				request.Context(),
				scope.WorkspaceID,
				input.Assignee.Type,
				input.Assignee.ID,
			)
			if !writeAssigneeAuthorization(response, request, err) {
				return
			}
		}
		var assignmentID uuid.UUID
		if input.Assignee != nil {
			assignmentID = options.NewID()
		}
		created, events, err := repository.CreateIssue(request.Context(), core.CreateIssueParams{
			ID:           options.NewID(),
			AssignmentID: assignmentID,
			BoardID:      input.BoardID,
			Title:        input.Title,
			Description:  input.Description,
			Status:       input.Status,
			Priority:     input.Priority,
			SortOrder:    input.SortOrder,
			DueDate:      input.DueDate,
			Assignee:     input.Assignee,
			Project:      input.Project,
			CreatedBy:    user.ID,
			CreatedAt:    options.Clock().UTC(),
			NewID:        options.NewID,
		})
		switch {
		case errors.Is(err, core.ErrNotFound):
			httpapi.WriteError(
				response,
				request,
				http.StatusNotFound,
				"NOT_FOUND",
				"Board or assignee not found.",
				nil,
			)
			return
		case errors.Is(err, core.ErrApprovalRequired):
			writeApprovalRequired(response, request, options, uuid.Nil)
			return
		case errors.Is(err, core.ErrConflict):
			httpapi.WriteError(
				response,
				request,
				http.StatusConflict,
				"CONFLICT",
				"Issue could not be created because its state conflicts.",
				nil,
			)
			return
		case err != nil:
			writeIssueInternal(response, request)
			return
		}
		shared.PublishIssue(request.Context(), options.Broadcaster, events)
		if !applyGoalChange(response, request, options, scope.WorkspaceID, created.ID, input.Goal) {
			return
		}
		relations, err := loadRelations(request.Context(), repository, created.ID)
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		response.Header().Set("Location", "/api/v1/issues/"+created.ID.String())
		httpapi.WriteJSON(response, http.StatusCreated, serializeIssue(created, relations))
	}
}

// applyGoalChange links or unlinks the issue's goal after the issue write.
// The goal must live in the issue's workspace; anything else reads as an
// unknown goal rather than revealing another workspace's goals.
func applyGoalChange(
	response http.ResponseWriter,
	request *http.Request,
	options Options,
	workspaceID, issueID uuid.UUID,
	change goalChange,
) bool {
	if !change.Set || options.Goals == nil {
		return true
	}
	if change.ID == nil {
		if err := options.Goals.ClearIssueGoal(request.Context(), issueID); err != nil {
			writeIssueInternal(response, request)
			return false
		}
		return true
	}
	goal, err := options.Goals.Get(request.Context(), *change.ID)
	if errors.Is(err, goalrepo.ErrNotFound) || (err == nil && goal.WorkspaceID != workspaceID) {
		httpapi.WriteError(
			response,
			request,
			http.StatusUnprocessableEntity,
			"GOAL_NOT_FOUND",
			"That goal does not exist in this workspace.",
			nil,
		)
		return false
	}
	if err != nil {
		writeIssueInternal(response, request)
		return false
	}
	user := auth.MustUser(request.Context())
	if err := options.Goals.LinkIssue(request.Context(), workspaceID, goal.ID, issueID, user.ID, options.Clock().UTC()); err != nil {
		writeIssueInternal(response, request)
		return false
	}
	return true
}

func loadRelations(ctx context.Context, repository *core.Repository, issueID uuid.UUID) (core.IssueRelations, error) {
	relations, err := core.LoadIssueRelations(ctx, repository.Pool, []uuid.UUID{issueID})
	if err != nil {
		return core.IssueRelations{}, err
	}
	return relations[issueID], nil
}

// writeApprovalRequired answers a refused status move with the gate that
// refused it, so a client can offer the approval rather than a dead end.
func writeApprovalRequired(response http.ResponseWriter, request *http.Request, options Options, issueID uuid.UUID) {
	details := map[string]any{"approvalId": nil}
	if options.Approvals != nil && issueID != uuid.Nil {
		if approval, err := options.Approvals.LatestForIssue(request.Context(), issueID, approvalrepo.KindIssueStart); err == nil {
			details["approvalId"] = approval.ID
		}
	}
	httpapi.WriteError(
		response,
		request,
		http.StatusConflict,
		"APPROVAL_REQUIRED",
		"The issue is waiting for approval and cannot be queued for an agent.",
		details,
	)
}

func getHandler(repository *core.Repository, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		issue, err := repository.GetIssue(request.Context(), chi.URLParam(request, "issueRef"))
		if errors.Is(err, core.ErrNotFound) {
			writeIssueNotFound(response, request)
			return
		}
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		if _, err := options.Authorization.AuthorizeIssue(
			request.Context(),
			user.ID,
			issue.ID,
			identity.PermissionRead,
		); !writeIssueAuthorization(response, request, err, false) {
			return
		}
		relations, err := loadRelations(request.Context(), repository, issue.ID)
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, serializeIssue(issue, relations))
	}
}

func updateHandler(
	repository *core.Repository,
	options Options,
) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		found, err := repository.GetIssue(request.Context(), chi.URLParam(request, "issueRef"))
		if errors.Is(err, core.ErrNotFound) {
			writeIssueNotFound(response, request)
			return
		}
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := options.Authorization.AuthorizeIssue(
			request.Context(),
			user.ID,
			found.ID,
			identity.PermissionWrite,
		)
		if !writeIssueAuthorization(response, request, err, false) {
			return
		}
		patch, goal, ok := parseIssuePatch(response, request)
		if !ok {
			return
		}
		if patch.AssigneeSet && patch.Assignee != nil {
			err := options.Authorization.ValidateAssignee(
				request.Context(),
				scope.WorkspaceID,
				patch.Assignee.Type,
				patch.Assignee.ID,
			)
			if !writeAssigneeAuthorization(response, request, err) {
				return
			}
		}
		var assignmentID uuid.UUID
		if patch.AssigneeSet && patch.Assignee != nil {
			assignmentID = options.NewID()
		}
		updated := found
		var events []core.IssueMutationEvent
		if patch.Title != nil || patch.DescriptionSet || patch.Status != nil || patch.Priority != nil ||
			patch.SortOrder != nil || patch.DueDateSet || patch.AssigneeSet || patch.ProjectSet {
			updated, events, err = repository.UpdateIssue(request.Context(), core.UpdateIssueParams{
				IssueID:      found.ID,
				Patch:        patch,
				AssignmentID: assignmentID,
				AssignedBy:   user.ID,
				UpdatedAt:    options.Clock().UTC(),
				NewID:        options.NewID,
			})
		}
		var transition *core.StateTransitionError
		switch {
		case errors.As(err, &transition):
			writeTransition(response, request, transition.From, transition.To)
			return
		case errors.Is(err, core.ErrApprovalRequired):
			writeApprovalRequired(response, request, options, found.ID)
			return
		case errors.Is(err, core.ErrProjectNotFound):
			httpapi.WriteError(
				response,
				request,
				http.StatusUnprocessableEntity,
				"PROJECT_NOT_FOUND",
				"That project does not exist in this workspace.",
				nil,
			)
			return
		case errors.Is(err, core.ErrNotFound):
			httpapi.WriteError(
				response,
				request,
				http.StatusNotFound,
				"NOT_FOUND",
				"Issue or assignee not found.",
				nil,
			)
			return
		case errors.Is(err, core.ErrConflict):
			httpapi.WriteError(
				response,
				request,
				http.StatusConflict,
				"CONFLICT",
				"Issue could not be updated because its state conflicts.",
				nil,
			)
			return
		case err != nil:
			writeIssueInternal(response, request)
			return
		}
		shared.PublishIssue(request.Context(), options.Broadcaster, events)
		if !applyGoalChange(response, request, options, scope.WorkspaceID, found.ID, goal) {
			return
		}
		relations, err := loadRelations(request.Context(), repository, found.ID)
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, serializeIssue(updated, relations))
	}
}

func authorizeIssueNested(
	authorizer Authorizer,
	writePermission identity.Permission,
	next http.Handler,
) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		permission := identity.PermissionRead
		if request.Method != http.MethodGet {
			permission = writePermission
		}
		user := auth.MustUser(request.Context())
		if _, err := authorizer.AuthorizeIssueReference(
			request.Context(),
			user.ID,
			chi.URLParam(request, "issueRef"),
			permission,
		); !writeIssueAuthorization(response, request, err, false) {
			return
		}
		next.ServeHTTP(response, request)
	})
}

func writeIssueAuthorization(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	board bool,
) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, identity.ErrNotFound):
		if board {
			writeBoardNotFound(response, request)
		} else {
			writeIssueNotFound(response, request)
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
		writeIssueInternal(response, request)
	}
	return false
}

func writeAssigneeAuthorization(
	response http.ResponseWriter,
	request *http.Request,
	err error,
) bool {
	if err == nil {
		return true
	}
	if errors.Is(err, identity.ErrNotFound) {
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			"Board or assignee not found.",
			nil,
		)
	} else {
		writeIssueInternal(response, request)
	}
	return false
}

func serializeIssue(issue core.Issue, relations core.IssueRelations) issueResource {
	var dueDate *string
	if issue.DueDate != nil {
		value := issue.DueDate.UTC().Format(time.RFC3339Nano)
		dueDate = &value
	}
	dependsOn := relations.DependsOn
	if dependsOn == nil {
		dependsOn = []core.IssueDependencyRef{}
	}
	blocks := relations.Blocks
	if blocks == nil {
		blocks = []core.IssueDependencyRef{}
	}
	return issueResource{
		Goal:        relations.Goal,
		Origin:      relations.Origin,
		DependsOn:   dependsOn,
		Blocks:      blocks,
		ID:          issue.ID,
		BoardID:     issue.BoardID,
		Number:      issue.Number,
		Identifier:  issue.Identifier(),
		Title:       issue.Title,
		Description: issue.Description,
		Status:      dbStatusToAPI(issue.Status),
		Priority:    issue.Priority,
		SortOrder:   issue.SortOrder,
		DueDate:     dueDate,
		Assignee:    issue.Assignee,
		ActiveRunID: issue.ActiveRunID,
		Project:     issue.Project,
		CreatedBy:   issue.CreatedBy,
		CreatedAt:   issue.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   issue.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func issueCursorScope(query issueQuery) string {
	type scopeShape struct {
		BoardID    uuid.UUID           `json:"boardId"`
		Statuses   []string            `json:"statuses"`
		Priorities []string            `json:"priorities"`
		Assignee   *core.AssigneeInput `json:"assignee"`
		Query      *string             `json:"query"`
	}
	encoded, _ := json.Marshal(scopeShape{
		BoardID:    query.BoardID,
		Statuses:   query.Statuses,
		Priorities: query.Priorities,
		Assignee:   query.Assignee,
		Query:      query.Query,
	})
	sum := sha256.Sum256(encoded)
	return fmt.Sprintf("issues.list.%x", sum[:8])
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

func writeTransition(
	response http.ResponseWriter,
	request *http.Request,
	from, to string,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusConflict,
		"INVALID_STATE_TRANSITION",
		fmt.Sprintf("Cannot transition an issue from %q to %q.", from, to),
		map[string]string{"from": from, "to": to},
	)
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

func writeIssueUnauthenticated(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnauthorized,
		"UNAUTHENTICATED",
		"Authentication required.",
		nil,
	)
}

func writeIssueInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusInternalServerError,
		"INTERNAL",
		"Internal server error.",
		nil,
	)
}
