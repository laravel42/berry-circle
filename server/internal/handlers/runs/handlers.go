// Package runs exports direct run routes and issue-nested admission routes.
package runs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	runrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
	"github.com/laravel42/berry-circle/server/internal/service/runadmission"
)

const (
	defaultRetention = 24 * time.Hour
	defaultHeartbeat = 10 * time.Second
	defaultPoll      = 500 * time.Millisecond
)

// Reader is the durable query/replay seam used by HTTP handlers.
type Reader interface {
	Get(context.Context, uuid.UUID) (runrepo.Run, error)
	List(context.Context, runrepo.ListFilter) ([]runrepo.Run, error)
	ListByBoard(context.Context, runrepo.BoardListFilter) ([]runrepo.Run, error)
	ResolveIssueID(context.Context, string) (uuid.UUID, error)
	ResolveRunCursor(context.Context, uuid.UUID, uuid.UUID, time.Time) (int64, error)
	ListRunEvents(context.Context, uuid.UUID, int64, time.Time, int) ([]runrepo.Event, error)
}

// Coordinator is the admission/dispatch lifecycle seam.
type Coordinator interface {
	Admit(context.Context, runrepo.AdmitParams) (runrepo.Run, error)
	Queue(uuid.UUID) error
	Get(context.Context, uuid.UUID) (runrepo.Run, error)
	Cancel(context.Context, uuid.UUID, uuid.UUID) (runrepo.Run, error)
	Close(context.Context) error
}

// Authorizer is the narrow issue/run/agent/board workspace boundary.
type Authorizer interface {
	AuthorizeIssue(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
	AuthorizeBoard(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
	AuthorizeRun(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
	AuthorizeAgent(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
}

// Options explicitly supplies persistence, auth, runtime, fanout, and workers.
type Options struct {
	Pool             *pgxpool.Pool
	Repository       Reader
	RunStore         runadmission.Store
	Service          Coordinator
	Sessions         auth.SessionResolver
	Authorization    Authorizer
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	OpenFang         openfang.Runtime
	Broadcaster      realtime.Broadcaster
	// Dispatcher routes admitted runs. Nil keeps the in-process worker pool.
	Dispatcher    runadmission.Dispatcher
	WorkerContext context.Context
	Workers       int
	QueueSize     int
	Retention     time.Duration
	Heartbeat     time.Duration
	PollInterval  time.Duration
	// Artifacts lists what a run produced (ADR-0006). Optional.
	Artifacts ArtifactStore
}

// Handlers shares one worker service between direct and nested route trees.
type Handlers struct {
	service       Coordinator
	repository    Reader
	sessions      auth.SessionResolver
	authorization Authorizer
	clock         func() time.Time
	newID         func() uuid.UUID
	idempotency   httpapi.IdempotencyStore
	broadcaster   realtime.Broadcaster
	retention     time.Duration
	heartbeat     time.Duration
	pollInterval  time.Duration
	// artifacts lists a run's outputs. Optional: a deployment without it
	// answers an empty list rather than 404, so the route's shape does not
	// depend on whether promotion is configured.
	artifacts ArtifactStore
}

// New constructs one lifecycle-owned run handler set.
func New(options Options) (*Handlers, error) {
	if options.Sessions == nil {
		return nil, errors.New("run handler session resolver is nil")
	}
	if options.Authorization == nil {
		return nil, errors.New("run handler authorizer is nil")
	}
	if options.Clock == nil {
		return nil, errors.New("run handler clock is nil")
	}
	if options.NewID == nil {
		return nil, errors.New("run handler ID generator is nil")
	}
	if options.IdempotencyStore == nil {
		return nil, errors.New("run handler idempotency store is nil")
	}
	if options.Broadcaster == nil {
		return nil, errors.New("run handler broadcaster is nil")
	}
	retention := options.Retention
	if retention == 0 {
		retention = defaultRetention
	}
	heartbeat := options.Heartbeat
	if heartbeat == 0 {
		heartbeat = defaultHeartbeat
	}
	poll := options.PollInterval
	if poll == 0 {
		poll = defaultPoll
	}
	if retention < defaultRetention {
		return nil, errors.New("run event retention must be at least 24 hours")
	}
	if heartbeat <= 0 || heartbeat > 15*time.Second {
		return nil, errors.New("run event heartbeat must be within 15 seconds")
	}
	if poll <= 0 || poll > heartbeat {
		return nil, errors.New("run event poll interval is invalid")
	}

	reader := options.Repository
	store := options.RunStore
	if reader == nil || (options.Service == nil && store == nil) {
		repository, err := runrepo.New(options.Pool)
		if err != nil {
			return nil, err
		}
		if reader == nil {
			reader = repository
		}
		if store == nil {
			store = repository
		}
	}
	service := options.Service
	if service == nil {
		created, err := runadmission.New(runadmission.Options{
			Store:         store,
			OpenFang:      options.OpenFang,
			Broadcaster:   options.Broadcaster,
			Clock:         options.Clock,
			NewID:         options.NewID,
			Dispatcher:    options.Dispatcher,
			WorkerContext: options.WorkerContext,
			Workers:       options.Workers,
			QueueSize:     options.QueueSize,
		})
		if err != nil {
			return nil, err
		}
		service = created
	}
	return &Handlers{
		service:       service,
		repository:    reader,
		sessions:      options.Sessions,
		authorization: options.Authorization,
		clock:         options.Clock,
		newID:         options.NewID,
		idempotency:   options.IdempotencyStore,
		broadcaster:   options.Broadcaster,
		retention:     retention,
		heartbeat:     heartbeat,
		pollInterval:  poll,
		artifacts:     options.Artifacts,
	}, nil
}

// Mount returns the disjoint /api/v1/runs subtree.
func (handlers *Handlers) Mount() httpapi.Mount {
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(handlers.sessions))
	router.Get("/{runId}", handlers.get)
	router.Post("/{runId}/cancel", handlers.cancel)
	router.Get("/{runId}/events", handlers.streamRunEvents)
	router.Get("/{runId}/artifacts", handlers.listRunArtifacts)
	return httpapi.Mount{Prefix: "/api/v1/runs", Handler: router}
}

// IssueHandler returns routes mounted under /api/v1/issues/{issueRef}/runs.
// The owning issue router applies RequireSession before entering this subtree.
func (handlers *Handlers) IssueHandler() http.Handler {
	router := httpapi.NewSubrouter()
	router.Get("/", handlers.listIssueRuns)
	router.Post("/", handlers.createIssueRun)
	return router
}

// BoardHandler returns routes mounted under /api/v1/boards/{boardId}/runs.
// The owning board router applies RequireSession before entering this subtree.
func (handlers *Handlers) BoardHandler() http.Handler {
	router := httpapi.NewSubrouter()
	router.Get("/", handlers.listBoardRuns)
	return router
}

// Close is the graceful worker shutdown seam for the process owner.
func (handlers *Handlers) Close(ctx context.Context) error {
	if handlers == nil || handlers.service == nil {
		return nil
	}
	return handlers.service.Close(ctx)
}

type runResource struct {
	ID          uuid.UUID        `json:"id"`
	IssueID     uuid.UUID        `json:"issueId"`
	AgentID     uuid.UUID        `json:"agentId"`
	Status      runrepo.Status   `json:"status"`
	Sequence    int64            `json:"sequence"`
	Summary     *string          `json:"summary"`
	Usage       usageResource    `json:"usage"`
	Failure     *failureResource `json:"failure"`
	CreatedAt   string           `json:"createdAt"`
	StartedAt   *string          `json:"startedAt"`
	CompletedAt *string          `json:"completedAt"`
}

type usageResource struct {
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	TotalTokens  int64   `json:"totalTokens"`
	CostMicros   *int64  `json:"costMicros"`
	Currency     *string `json:"currency"`
}

type failureResource struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type connection struct {
	Nodes    []runResource `json:"nodes"`
	PageInfo pageInfo      `json:"pageInfo"`
}

type pageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

func (handlers *Handlers) get(response http.ResponseWriter, request *http.Request) {
	runID, ok := parseRunID(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handlers.authorization.AuthorizeRun(
		request.Context(),
		user.ID,
		runID,
		identity.PermissionRead,
	); !writeRunAuthorization(response, request, err, "run") {
		return
	}
	run, err := handlers.repository.Get(request.Context(), runID)
	if errors.Is(err, runrepo.ErrNotFound) {
		writeNotFound(response, request)
		return
	}
	if err != nil {
		writeInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serialize(run))
}

func (handlers *Handlers) cancel(response http.ResponseWriter, request *http.Request) {
	runID, ok := parseRunID(response, request)
	if !ok {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, 1024))
	if err != nil {
		httpapi.WriteError(
			response,
			request,
			http.StatusRequestEntityTooLarge,
			"PAYLOAD_TOO_LARGE",
			"Request body is too large.",
			nil,
		)
		return
	}
	if len(bytes.TrimSpace(body)) > 0 {
		writeValidation(
			response,
			request,
			httpapi.FieldError{
				Path:    "/",
				Code:    "unrecognized_body",
				Message: "Cancellation does not accept a request body.",
			},
		)
		return
	}
	user, ok := auth.UserFromContext(request.Context())
	if !ok {
		writeUnauthenticated(response, request)
		return
	}
	if _, err := handlers.authorization.AuthorizeRun(
		request.Context(),
		user.ID,
		runID,
		identity.PermissionRunsDispatch,
	); !writeRunAuthorization(response, request, err, "run") {
		return
	}
	run, err := handlers.service.Cancel(request.Context(), runID, user.ID)
	switch {
	case errors.Is(err, runrepo.ErrNotFound):
		writeNotFound(response, request)
	case errors.Is(err, runrepo.ErrRunTerminal):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"RUN_TERMINAL",
			"The run is already terminal.",
			nil,
		)
	case errors.Is(err, runrepo.ErrCancellationUnconfirmed), err != nil:
		httpapi.WriteError(
			response,
			request,
			http.StatusServiceUnavailable,
			"DEPENDENCY_UNAVAILABLE",
			"The runtime cancellation could not be confirmed.",
			nil,
		)
	default:
		httpapi.WriteJSON(response, http.StatusAccepted, serialize(run))
	}
}

func (handlers *Handlers) listIssueRuns(
	response http.ResponseWriter,
	request *http.Request,
) {
	issueID, err := handlers.repository.ResolveIssueID(
		request.Context(),
		chi.URLParam(request, "issueRef"),
	)
	if errors.Is(err, runrepo.ErrNotFound) {
		writeIssueNotFound(response, request)
		return
	}
	if err != nil {
		writeInternal(response, request)
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handlers.authorization.AuthorizeIssue(
		request.Context(),
		user.ID,
		issueID,
		identity.PermissionRead,
	); !writeRunAuthorization(response, request, err, "issue") {
		return
	}
	first, afterToken, status, ok := parseRunListQuery(response, request)
	if !ok {
		return
	}
	scope := runListScope(issueID, status)
	var after *runrepo.Cursor
	if afterToken != "" {
		var decoded runrepo.Cursor
		if err := httpapi.DecodeCursor(afterToken, scope, &decoded); err != nil ||
			decoded.ID == uuid.Nil || decoded.CreatedAt.IsZero() {
			writeInvalidCursor(response, request)
			return
		}
		after = &decoded
	}
	found, err := handlers.repository.List(request.Context(), runrepo.ListFilter{
		IssueID: issueID,
		Status:  status,
		After:   after,
		Limit:   first + 1,
	})
	if err != nil {
		writeInternal(response, request)
		return
	}
	hasNextPage := len(found) > first
	if hasNextPage {
		found = found[:first]
	}
	nodes := make([]runResource, 0, len(found))
	for _, run := range found {
		nodes = append(nodes, serialize(run))
	}
	var endCursor *string
	if len(found) > 0 {
		last := found[len(found)-1]
		encoded, err := httpapi.EncodeCursor(scope, runrepo.Cursor{
			CreatedAt: last.CreatedAt,
			ID:        last.ID,
		})
		if err != nil {
			writeInternal(response, request)
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, connection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNextPage,
			EndCursor:   endCursor,
		},
	})
}

func (handlers *Handlers) listBoardRuns(
	response http.ResponseWriter,
	request *http.Request,
) {
	boardID, err := uuid.Parse(chi.URLParam(request, "boardId"))
	if err != nil || boardID == uuid.Nil || boardID.String() != chi.URLParam(request, "boardId") {
		writeBoardNotFound(response, request)
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handlers.authorization.AuthorizeBoard(
		request.Context(),
		user.ID,
		boardID,
		identity.PermissionRead,
	); !writeRunAuthorization(response, request, err, "board") {
		return
	}
	first, afterToken, status, agentID, ok := parseBoardRunListQuery(response, request)
	if !ok {
		return
	}
	scope := boardRunListScope(boardID, agentID, status)
	var after *runrepo.Cursor
	if afterToken != "" {
		var decoded runrepo.Cursor
		if err := httpapi.DecodeCursor(afterToken, scope, &decoded); err != nil ||
			decoded.ID == uuid.Nil || decoded.CreatedAt.IsZero() {
			writeInvalidCursor(response, request)
			return
		}
		after = &decoded
	}
	found, err := handlers.repository.ListByBoard(request.Context(), runrepo.BoardListFilter{
		BoardID: boardID,
		AgentID: agentID,
		Status:  status,
		After:   after,
		Limit:   first + 1,
	})
	if err != nil {
		writeInternal(response, request)
		return
	}
	hasNextPage := len(found) > first
	if hasNextPage {
		found = found[:first]
	}
	nodes := make([]runResource, 0, len(found))
	for _, run := range found {
		nodes = append(nodes, serialize(run))
	}
	var endCursor *string
	if len(found) > 0 {
		last := found[len(found)-1]
		encoded, err := httpapi.EncodeCursor(scope, runrepo.Cursor{
			CreatedAt: last.CreatedAt,
			ID:        last.ID,
		})
		if err != nil {
			writeInternal(response, request)
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, connection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNextPage,
			EndCursor:   endCursor,
		},
	})
}

func writeRunAuthorization(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	resource string,
) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, identity.ErrNotFound):
		switch resource {
		case "issue":
			writeIssueNotFound(response, request)
		case "board":
			writeBoardNotFound(response, request)
		case "agent":
			httpapi.WriteError(
				response,
				request,
				http.StatusNotFound,
				"NOT_FOUND",
				"Agent not found.",
				nil,
			)
		default:
			writeNotFound(response, request)
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
		writeInternal(response, request)
	}
	return false
}

func parseRunListQuery(
	response http.ResponseWriter,
	request *http.Request,
) (int, string, runrepo.Status, bool) {
	values := request.URL.Query()
	for name, entries := range values {
		if name != "first" && name != "after" && name != "status" {
			writeInvalidRequest(response, request, httpapi.FieldError{
				Path: "/query/" + name, Code: "invalid", Message: "Unknown query parameter.",
			})
			return 0, "", "", false
		}
		if len(entries) != 1 {
			writeInvalidRequest(response, request, httpapi.FieldError{
				Path: "/query/" + name, Code: "invalid", Message: "Query parameter must appear once.",
			})
			return 0, "", "", false
		}
	}
	first := 50
	if raw := values.Get("first"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeInvalidRequest(response, request, httpapi.FieldError{
				Path: "/query/first", Code: "invalid", Message: "first must be an integer from 1 to 100.",
			})
			return 0, "", "", false
		}
		first = parsed
	}
	status := runrepo.Status(values.Get("status"))
	if status != "" && !validRunStatus(status) {
		writeInvalidRequest(response, request, httpapi.FieldError{
			Path: "/query/status", Code: "invalid_enum_value", Message: "status is not supported.",
		})
		return 0, "", "", false
	}
	return first, values.Get("after"), status, true
}

func parseBoardRunListQuery(
	response http.ResponseWriter,
	request *http.Request,
) (int, string, runrepo.Status, uuid.UUID, bool) {
	values := request.URL.Query()
	for name, entries := range values {
		if name != "first" && name != "after" && name != "status" && name != "agentId" {
			writeInvalidRequest(response, request, httpapi.FieldError{
				Path: "/query/" + name, Code: "invalid", Message: "Unknown query parameter.",
			})
			return 0, "", "", uuid.Nil, false
		}
		if len(entries) != 1 {
			writeInvalidRequest(response, request, httpapi.FieldError{
				Path: "/query/" + name, Code: "invalid", Message: "Query parameter must appear once.",
			})
			return 0, "", "", uuid.Nil, false
		}
	}
	first := 50
	if raw := values.Get("first"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeInvalidRequest(response, request, httpapi.FieldError{
				Path: "/query/first", Code: "invalid", Message: "first must be an integer from 1 to 100.",
			})
			return 0, "", "", uuid.Nil, false
		}
		first = parsed
	}
	status := runrepo.Status(values.Get("status"))
	if status != "" && !validRunStatus(status) {
		writeInvalidRequest(response, request, httpapi.FieldError{
			Path: "/query/status", Code: "invalid_enum_value", Message: "status is not supported.",
		})
		return 0, "", "", uuid.Nil, false
	}
	var agentID uuid.UUID
	if raw := values.Get("agentId"); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil || parsed == uuid.Nil || parsed.String() != raw {
			writeInvalidRequest(response, request, httpapi.FieldError{
				Path: "/query/agentId", Code: "invalid", Message: "agentId must be a UUID.",
			})
			return 0, "", "", uuid.Nil, false
		}
		agentID = parsed
	}
	return first, values.Get("after"), status, agentID, true
}

func parseRunID(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, bool) {
	raw := chi.URLParam(request, "runId")
	id, err := uuid.Parse(raw)
	if err != nil || id == uuid.Nil || id.String() != raw {
		writeNotFound(response, request)
		return uuid.Nil, false
	}
	return id, true
}

func serialize(run runrepo.Run) runResource {
	var startedAt *string
	if run.StartedAt != nil {
		value := run.StartedAt.UTC().Format(time.RFC3339Nano)
		startedAt = &value
	}
	var completedAt *string
	if run.CompletedAt != nil {
		value := run.CompletedAt.UTC().Format(time.RFC3339Nano)
		completedAt = &value
	}
	var failure *failureResource
	if run.Failure != nil {
		failure = &failureResource{
			Code:      run.Failure.Code,
			Message:   run.Failure.Message,
			Retryable: run.Failure.Retryable,
		}
	}
	return runResource{
		ID:       run.ID,
		IssueID:  run.IssueID,
		AgentID:  run.AgentID,
		Status:   run.Status,
		Sequence: run.Sequence,
		Summary:  run.Summary,
		Usage: usageResource{
			InputTokens:  run.Usage.InputTokens,
			OutputTokens: run.Usage.OutputTokens,
			TotalTokens:  run.Usage.TotalTokens,
			CostMicros:   run.Usage.CostMicros,
			Currency:     run.Usage.Currency,
		},
		Failure:     failure,
		CreatedAt:   run.CreatedAt.UTC().Format(time.RFC3339Nano),
		StartedAt:   startedAt,
		CompletedAt: completedAt,
	}
}

func validRunStatus(status runrepo.Status) bool {
	return status == runrepo.StatusQueued ||
		status == runrepo.StatusRunning ||
		status == runrepo.StatusSucceeded ||
		status == runrepo.StatusFailed ||
		status == runrepo.StatusCancelled
}

func runListScope(issueID uuid.UUID, status runrepo.Status) string {
	return fmt.Sprintf("runs.list.%s.%s", issueID.String(), status)
}

func boardRunListScope(boardID, agentID uuid.UUID, status runrepo.Status) string {
	if agentID != uuid.Nil {
		return fmt.Sprintf("runs.board.%s.agent.%s.%s", boardID.String(), agentID.String(), status)
	}
	return fmt.Sprintf("runs.board.%s.%s", boardID.String(), status)
}
