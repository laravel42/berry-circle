// Package events exports the authenticated durable board event stream.
//
// The stream subscribes on the board id for live wakeups; publishers set it as
// the event's BoardID beside the workspace, so a board-less fact never reaches
// a board subscriber and a workspace-wide consumer can subscribe on its own
// key without a second publish.
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

// Store is the durable replay seam for board events.
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
}

// Authorizer is the narrow board boundary consumed before replay or follow.
type Authorizer interface {
	AuthorizeBoard(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
}

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

func (handler *handler) stream(response http.ResponseWriter, request *http.Request) {
	boardID, cursor, ok := parseRequest(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handler.authorization.AuthorizeBoard(
		request.Context(),
		user.ID,
		boardID,
		identity.PermissionRead,
	); errors.Is(err, identity.ErrNotFound) {
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"BOARD_NOT_FOUND",
			"The requested board was not found.",
			nil,
		)
		return
	} else if errors.Is(err, identity.ErrForbidden) {
		httpapi.WriteError(
			response,
			request,
			http.StatusForbidden,
			"FORBIDDEN",
			"You do not have permission to stream this board.",
			nil,
		)
		return
	} else if err != nil {
		writeInternal(response, request)
		return
	}
	cutoff := handler.clock().UTC().Add(-handler.retention)
	var after *runrepo.BoardCursor
	if cursor != "" {
		eventID, err := uuid.Parse(cursor)
		if err != nil || eventID == uuid.Nil || eventID.String() != cursor {
			writeCursorExpired(response, request)
			return
		}
		resolved, err := handler.store.ResolveBoardCursor(
			request.Context(),
			boardID,
			eventID,
			cutoff,
		)
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
	subscription, _ := handler.broadcaster.Subscribe(
		request.Context(),
		boardID.String(),
	)
	if subscription != nil {
		defer subscription.Close()
	}
	backlog, err := handler.store.ListBoardEvents(
		request.Context(),
		boardID,
		after,
		cutoff,
		replayBatch,
	)
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

	after, ok = writeBatch(response, flusher, backlog, after)
	if !ok {
		return
	}
	for len(backlog) == replayBatch {
		backlog, err = handler.store.ListBoardEvents(
			request.Context(),
			boardID,
			after,
			cutoff,
			replayBatch,
		)
		if err != nil {
			return
		}
		after, ok = writeBatch(response, flusher, backlog, after)
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
			found, err := handler.store.ListBoardEvents(
				request.Context(),
				boardID,
				after,
				cutoff,
				replayBatch,
			)
			if err != nil {
				return
			}
			if len(found) == 0 {
				break
			}
			after, ok = writeBatch(response, flusher, found, after)
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

func parseRequest(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, string, bool) {
	values := request.URL.Query()
	for name, entries := range values {
		if name != "boardId" && name != "after" {
			writeInvalid(response, request, "Unknown query parameter.")
			return uuid.Nil, "", false
		}
		if len(entries) != 1 {
			writeInvalid(response, request, "Query parameters must appear once.")
			return uuid.Nil, "", false
		}
	}
	rawBoardID := values.Get("boardId")
	boardID, err := uuid.Parse(rawBoardID)
	if err != nil || boardID == uuid.Nil || boardID.String() != rawBoardID {
		writeValidation(response, request)
		return uuid.Nil, "", false
	}
	headerValues := request.Header.Values("Last-Event-ID")
	if len(headerValues) > 1 {
		writeInvalid(response, request, "Last-Event-ID must appear once.")
		return uuid.Nil, "", false
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
		return uuid.Nil, "", false
	}
	cursor := lastEventID
	if cursor == "" {
		cursor = after
	}
	if len(cursor) > maxCursorBytes {
		writeInvalid(response, request, "The event cursor is malformed.")
		return uuid.Nil, "", false
	}
	return boardID, cursor, true
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
