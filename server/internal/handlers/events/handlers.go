// Package events exports the authenticated durable event streams: one per
// board and one per workspace.
//
// The board stream subscribes on the board id for live wakeups; publishers
// set it as the event's BoardID beside the workspace, so a board-less fact
// never reaches a board subscriber. The workspace stream subscribes on the
// workspace id and replays the goal, workflow, approval and plan facts that
// belong to no board, plus the issue and agent moments a workspace-wide
// consumer needs.
package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	runrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
)

const (
	minimumRetention = 24 * time.Hour
	defaultHeartbeat = 10 * time.Second
	defaultPoll      = 500 * time.Millisecond
	replayBatch      = 200
	maxCursorBytes   = 512
)

// Store is the durable replay seam for board and workspace events.
type Store interface {
	ResolveBoardCursor(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) (runrepo.BoardCursor, error)
	ListBoardEvents(
		context.Context,
		uuid.UUID,
		*runrepo.BoardCursor,
		time.Time,
		int,
	) ([]runrepo.Event, error)
	ResolveWorkspaceCursor(
		context.Context,
		uuid.UUID,
		[]string,
		uuid.UUID,
		time.Time,
	) (runrepo.BoardCursor, error)
	ListWorkspaceEvents(
		context.Context,
		uuid.UUID,
		[]string,
		*runrepo.BoardCursor,
		time.Time,
		int,
	) ([]runrepo.Event, error)
}

// Authorizer is the narrow board/workspace boundary consumed before replay
// or follow.
type Authorizer interface {
	AuthorizeBoard(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
	AuthorizeWorkspace(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Role, error)
}

// WorkspaceTopics is what GET /api/v1/events?workspaceId= replays: the facts
// that belong to no board (goals, workflows, approvals, plans) plus the issue
// and agent moments a workspace-wide consumer needs to notice. The outbox
// replay matches topics exactly, so the list is spelled out.
var WorkspaceTopics = []string{
	"goal.created", "goal.updated", "goal.started", "goal.completed", "goal.cancelled", "goal.archived",
	"workflow.created", "workflow.activated", "workflow.paused", "workflow.archived",
	"workflow.run.started", "workflow.run.waiting", "workflow.run.resumed", "workflow.run.succeeded", "workflow.run.failed", "workflow.run.cancelled",
	"workflow.step.started", "workflow.step.succeeded", "workflow.step.failed", "workflow.step.skipped", "workflow.step.waiting",
	"approval.requested", "approval.approved", "approval.rejected", "approval.expired",
	"plan.generated", "plan.updated", "plan.blocked", "plan.patched", "plan.approved", "plan.compiled", "plan.compile_failed",
	"issue.created", "issue.completed", "issue.deleted",
	"agent.started", "agent.completed", "agent.failed",
	"artifact.created",
}

// streamScope is the one scope a request names: a board or a workspace.
type streamScope struct {
	boardID     uuid.UUID
	workspaceID uuid.UUID
}

func (scope streamScope) workspace() bool { return scope.workspaceID != uuid.Nil }

// Options explicitly supplies durable storage, auth, clock, and wakeups.
type Options struct {
	Pool          *pgxpool.Pool
	Store         Store
	Sessions      auth.SessionResolver
	Authorization Authorizer
	Clock         func() time.Time
	Broadcaster   realtime.Broadcaster
	Retention     time.Duration
	Heartbeat     time.Duration
	PollInterval  time.Duration
}

type handler struct {
	store         Store
	authorization Authorizer
	clock         func() time.Time
	broadcaster   realtime.Broadcaster
	retention     time.Duration
	heartbeat     time.Duration
	pollInterval  time.Duration
}

// NewMount builds the disjoint /api/v1/events subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Sessions == nil {
		return httpapi.Mount{}, errors.New("event handler session resolver is nil")
	}
	if options.Authorization == nil {
		return httpapi.Mount{}, errors.New("event handler authorizer is nil")
	}
	if options.Clock == nil {
		return httpapi.Mount{}, errors.New("event handler clock is nil")
	}
	if options.Broadcaster == nil {
		return httpapi.Mount{}, errors.New("event handler broadcaster is nil")
	}
	store := options.Store
	if store == nil {
		repository, err := runrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		store = repository
	}
	retention := options.Retention
	if retention == 0 {
		retention = minimumRetention
	}
	heartbeat := options.Heartbeat
	if heartbeat == 0 {
		heartbeat = defaultHeartbeat
	}
	poll := options.PollInterval
	if poll == 0 {
		poll = defaultPoll
	}
	if retention < minimumRetention {
		return httpapi.Mount{}, errors.New("event retention must be at least 24 hours")
	}
	if heartbeat <= 0 || heartbeat > 15*time.Second {
		return httpapi.Mount{}, errors.New("event heartbeat must be within 15 seconds")
	}
	if poll <= 0 || poll > heartbeat {
		return httpapi.Mount{}, errors.New("event poll interval is invalid")
	}
	target := &handler{
		store:         store,
		authorization: options.Authorization,
		clock:         options.Clock,
		broadcaster:   options.Broadcaster,
		retention:     retention,
		heartbeat:     heartbeat,
		pollInterval:  poll,
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", target.stream)
	return httpapi.Mount{Prefix: "/api/v1/events", Handler: router}, nil
}

// envelope is the board stream frame. runId and sequence are null for facts
// no run produced (issue and comment mutations); issueId is the nil uuid for
// an aggregate that belongs to no issue.
type envelope struct {
	ID          uuid.UUID       `json:"id"`
	Type        string          `json:"type"`
	OccurredAt  string          `json:"occurredAt"`
	WorkspaceID uuid.UUID       `json:"workspaceId"`
	BoardID     uuid.UUID       `json:"boardId"`
	IssueID     uuid.UUID       `json:"issueId"`
	RunID       *uuid.UUID      `json:"runId"`
	Sequence    *int64          `json:"sequence"`
	Payload     json.RawMessage `json:"payload"`
}

// workspaceEnvelope is the workspace stream frame: the same fields, with
// boardId and issueId null for facts that belong to no board or issue.
type workspaceEnvelope struct {
	ID          uuid.UUID       `json:"id"`
	Type        string          `json:"type"`
	OccurredAt  string          `json:"occurredAt"`
	WorkspaceID uuid.UUID       `json:"workspaceId"`
	BoardID     *uuid.UUID      `json:"boardId"`
	IssueID     *uuid.UUID      `json:"issueId"`
	RunID       *uuid.UUID      `json:"runId"`
	Sequence    *int64          `json:"sequence"`
	Payload     json.RawMessage `json:"payload"`
}

func (handler *handler) stream(response http.ResponseWriter, request *http.Request) {
	scope, cursor, ok := parseRequest(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	if scope.workspace() {
		_, err := handler.authorization.AuthorizeWorkspace(request.Context(), user.ID, scope.workspaceID, identity.PermissionRead)
		if !writeScopeAuthorization(response, request, err, "workspace") {
			return
		}
	} else {
		_, err := handler.authorization.AuthorizeBoard(request.Context(), user.ID, scope.boardID, identity.PermissionRead)
		if !writeScopeAuthorization(response, request, err, "board") {
			return
		}
	}
	cutoff := handler.clock().UTC().Add(-handler.retention)
	var after *runrepo.BoardCursor
	if cursor != "" {
		eventID, err := uuid.Parse(cursor)
		if err != nil || eventID == uuid.Nil || eventID.String() != cursor {
			writeCursorExpired(response, request)
			return
		}
		var resolved runrepo.BoardCursor
		if scope.workspace() {
			resolved, err = handler.store.ResolveWorkspaceCursor(request.Context(), scope.workspaceID, WorkspaceTopics, eventID, cutoff)
		} else {
			resolved, err = handler.store.ResolveBoardCursor(request.Context(), scope.boardID, eventID, cutoff)
		}
		if errors.Is(err, runrepo.ErrCursorExpired) {
			writeCursorExpired(response, request)
			return
		}
		if err != nil {
			writeInternal(response, request)
			return
		}
		after = &resolved
	}
	flusher, ok := response.(http.Flusher)
	if !ok {
		httpapi.WriteError(
			response,
			request,
			http.StatusInternalServerError,
			"STREAMING_UNAVAILABLE",
			"Event streaming is unavailable.",
			nil,
		)
		return
	}
	// A board stream subscribes on its board id, a workspace stream on the
	// workspace id; publishers stamp both so one fact wakes either.
	subscriptionKey := scope.boardID.String()
	if scope.workspace() {
		subscriptionKey = scope.workspaceID.String()
	}
	subscription, _ := handler.broadcaster.Subscribe(request.Context(), subscriptionKey)
	if subscription != nil {
		defer subscription.Close()
	}
	list := func(after *runrepo.BoardCursor) ([]runrepo.Event, error) {
		if scope.workspace() {
			return handler.store.ListWorkspaceEvents(request.Context(), scope.workspaceID, WorkspaceTopics, after, cutoff, replayBatch)
		}
		return handler.store.ListBoardEvents(request.Context(), scope.boardID, after, cutoff, replayBatch)
	}
	write := func(events []runrepo.Event, after *runrepo.BoardCursor) (*runrepo.BoardCursor, bool) {
		if scope.workspace() {
			return writeWorkspaceBatch(response, flusher, events, after)
		}
		return writeBatch(response, flusher, events, after)
	}
	backlog, err := list(after)
	if err != nil {
		writeInternal(response, request)
		return
	}

	response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	response.Header().Set("Cache-Control", "no-cache, no-transform")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	if _, err := fmt.Fprint(response, "retry: 3000\n\n"); err != nil {
		return
	}
	flusher.Flush()

	after, ok = write(backlog, after)
	if !ok {
		return
	}
	for len(backlog) == replayBatch {
		backlog, err = list(after)
		if err != nil {
			return
		}
		after, ok = write(backlog, after)
		if !ok {
			return
		}
	}

	poll := time.NewTicker(handler.pollInterval)
	defer poll.Stop()
	heartbeat := time.NewTimer(handler.heartbeat)
	defer heartbeat.Stop()
	var wakeups <-chan realtime.Event
	if subscription != nil {
		wakeups = subscription.Events()
	}
	for {
		select {
		case <-request.Context().Done():
			return
		case _, open := <-wakeups:
			if !open {
				wakeups = nil
			}
		case <-poll.C:
		case <-heartbeat.C:
			if _, err := fmt.Fprint(response, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
			heartbeat.Reset(handler.heartbeat)
			continue
		}
		for {
			found, err := list(after)
			if err != nil {
				return
			}
			if len(found) == 0 {
				break
			}
			after, ok = write(found, after)
			if !ok {
				return
			}
			resetTimer(heartbeat, handler.heartbeat)
			if len(found) < replayBatch {
				break
			}
		}
	}
}

// parseRequest reads exactly one of boardId or workspaceId and the cursor.
func parseRequest(
	response http.ResponseWriter,
	request *http.Request,
) (streamScope, string, bool) {
	values := request.URL.Query()
	for name, entries := range values {
		if name != "boardId" && name != "workspaceId" && name != "after" {
			writeInvalid(response, request, "Unknown query parameter.")
			return streamScope{}, "", false
		}
		if len(entries) != 1 {
			writeInvalid(response, request, "Query parameters must appear once.")
			return streamScope{}, "", false
		}
	}
	_, hasBoard := values["boardId"]
	_, hasWorkspace := values["workspaceId"]
	if hasBoard == hasWorkspace {
		writeInvalid(response, request, "Provide exactly one of boardId or workspaceId.")
		return streamScope{}, "", false
	}
	var scope streamScope
	if hasWorkspace {
		raw := values.Get("workspaceId")
		workspaceID, err := uuid.Parse(raw)
		if err != nil || workspaceID == uuid.Nil || workspaceID.String() != raw {
			writeValidationField(response, request, "workspaceId")
			return streamScope{}, "", false
		}
		scope.workspaceID = workspaceID
	} else {
		raw := values.Get("boardId")
		boardID, err := uuid.Parse(raw)
		if err != nil || boardID == uuid.Nil || boardID.String() != raw {
			writeValidation(response, request)
			return streamScope{}, "", false
		}
		scope.boardID = boardID
	}
	headerValues := request.Header.Values("Last-Event-ID")
	if len(headerValues) > 1 {
		writeInvalid(response, request, "Last-Event-ID must appear once.")
		return streamScope{}, "", false
	}
	lastEventID := ""
	if len(headerValues) == 1 {
		lastEventID = strings.TrimSpace(headerValues[0])
	}
	after := strings.TrimSpace(values.Get("after"))
	if lastEventID != "" && after != "" {
		writeInvalid(
			response,
			request,
			"Provide either the Last-Event-ID header or the after cursor, not both.",
		)
		return streamScope{}, "", false
	}
	cursor := lastEventID
	if cursor == "" {
		cursor = after
	}
	if len(cursor) > maxCursorBytes {
		writeInvalid(response, request, "The event cursor is malformed.")
		return streamScope{}, "", false
	}
	return scope, cursor, true
}

func writeScopeAuthorization(response http.ResponseWriter, request *http.Request, err error, scope string) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, identity.ErrNotFound):
		code, message := "BOARD_NOT_FOUND", "The requested board was not found."
		if scope == "workspace" {
			code, message = "NOT_FOUND", "The requested workspace was not found."
		}
		httpapi.WriteError(response, request, http.StatusNotFound, code, message, nil)
	case errors.Is(err, identity.ErrForbidden):
		httpapi.WriteError(
			response,
			request,
			http.StatusForbidden,
			"FORBIDDEN",
			"You do not have permission to stream this "+scope+".",
			nil,
		)
	default:
		writeInternal(response, request)
	}
	return false
}

func writeWorkspaceBatch(
	response http.ResponseWriter,
	flusher http.Flusher,
	events []runrepo.Event,
	after *runrepo.BoardCursor,
) (*runrepo.BoardCursor, bool) {
	for _, event := range events {
		frame := workspaceEnvelope{
			ID:          event.ID,
			Type:        event.Type,
			OccurredAt:  event.OccurredAt.UTC().Format(time.RFC3339Nano),
			WorkspaceID: event.WorkspaceID,
			RunID:       event.RunID,
			Sequence:    event.Sequence,
			Payload:     event.Payload,
		}
		if event.BoardID != uuid.Nil {
			boardID := event.BoardID
			frame.BoardID = &boardID
		}
		if event.IssueID != uuid.Nil {
			issueID := event.IssueID
			frame.IssueID = &issueID
		}
		data, err := json.Marshal(frame)
		if err != nil {
			return after, false
		}
		if _, err := fmt.Fprintf(
			response,
			"id: %s\nevent: %s\ndata: %s\n\n",
			event.ID.String(),
			event.Type,
			data,
		); err != nil {
			return after, false
		}
		flusher.Flush()
		after = &runrepo.BoardCursor{
			OccurredAt: event.OccurredAt,
			ID:         event.ID,
		}
	}
	return after, true
}

func writeValidationField(response http.ResponseWriter, request *http.Request, field string) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnprocessableEntity,
		"VALIDATION_FAILED",
		field+" must be a canonical UUID.",
		map[string]any{
			"fields": []httpapi.FieldError{{
				Path:    "/query/" + field,
				Code:    "invalid",
				Message: field + " must be a canonical UUID.",
			}},
		},
	)
}

func writeBatch(
	response http.ResponseWriter,
	flusher http.Flusher,
	events []runrepo.Event,
	after *runrepo.BoardCursor,
) (*runrepo.BoardCursor, bool) {
	for _, event := range events {
		data, err := json.Marshal(envelope{
			ID:          event.ID,
			Type:        event.Type,
			OccurredAt:  event.OccurredAt.UTC().Format(time.RFC3339Nano),
			WorkspaceID: event.WorkspaceID,
			BoardID:     event.BoardID,
			IssueID:     event.IssueID,
			RunID:       event.RunID,
			Sequence:    event.Sequence,
			Payload:     event.Payload,
		})
		if err != nil {
			return after, false
		}
		if _, err := fmt.Fprintf(
			response,
			"id: %s\nevent: %s\ndata: %s\n\n",
			event.ID.String(),
			event.Type,
			data,
		); err != nil {
			return after, false
		}
		flusher.Flush()
		after = &runrepo.BoardCursor{
			OccurredAt: event.OccurredAt,
			ID:         event.ID,
		}
	}
	return after, true
}

func resetTimer(timer *time.Timer, duration time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(duration)
}

func writeInvalid(
	response http.ResponseWriter,
	request *http.Request,
	message string,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		message,
		nil,
	)
}

func writeValidation(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnprocessableEntity,
		"VALIDATION_FAILED",
		"boardId must be a canonical UUID.",
		map[string]any{
			"fields": []httpapi.FieldError{{
				Path:    "/query/boardId",
				Code:    "invalid",
				Message: "boardId must be a canonical UUID.",
			}},
		},
	)
}

func writeCursorExpired(
	response http.ResponseWriter,
	request *http.Request,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusConflict,
		"CURSOR_EXPIRED",
		"The event cursor is older than the retention window; reconnect without a cursor and reconcile from current resources.",
		nil,
	)
}

func writeInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusInternalServerError,
		"INTERNAL",
		"An internal error occurred.",
		nil,
	)
}
