package runs

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	runrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
)

const (
	sseReplayBatch = 200
	sseRetryMillis = 3000
	maxCursorBytes = 512
)

type eventEnvelope struct {
	ID         uuid.UUID       `json:"id"`
	Type       string          `json:"type"`
	OccurredAt string          `json:"occurredAt"`
	BoardID    uuid.UUID       `json:"boardId"`
	IssueID    uuid.UUID       `json:"issueId"`
	RunID      uuid.UUID       `json:"runId"`
	Sequence   int64           `json:"sequence"`
	Payload    json.RawMessage `json:"payload"`
}

func (handlers *Handlers) streamRunEvents(
	response http.ResponseWriter,
	request *http.Request,
) {
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
	cursor, ok := parseEventCursor(response, request)
	if !ok {
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
	cutoff := handlers.clock().UTC().Add(-handlers.retention)
	// Sequence zero is run.created; -1 means replay from the beginning.
	afterSequence := int64(-1)
	if cursor != "" {
		eventID, err := uuid.Parse(cursor)
		if err != nil || eventID == uuid.Nil || eventID.String() != cursor {
			writeCursorExpired(response, request)
			return
		}
		afterSequence, err = handlers.repository.ResolveRunCursor(
			request.Context(),
			runID,
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
	subscription, _ := handlers.broadcaster.Subscribe(
		request.Context(),
		run.BoardID.String(),
	)
	if subscription != nil {
		defer subscription.Close()
	}

	// Query once before committing the SSE response so database failures still
	// use the central JSON envelope.
	backlog, err := handlers.repository.ListRunEvents(
		request.Context(),
		runID,
		afterSequence,
		cutoff,
		sseReplayBatch,
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
	if _, err := fmt.Fprintf(response, "retry: %d\n\n", sseRetryMillis); err != nil {
		return
	}
	flusher.Flush()

	afterSequence, terminal, ok := writeRunEventBatch(
		response,
		flusher,
		backlog,
		afterSequence,
	)
	if !ok || terminal {
		return
	}
	for len(backlog) == sseReplayBatch {
		backlog, err = handlers.repository.ListRunEvents(
			request.Context(),
			runID,
			afterSequence,
			cutoff,
			sseReplayBatch,
		)
		if err != nil {
			return
		}
		afterSequence, terminal, ok = writeRunEventBatch(
			response,
			flusher,
			backlog,
			afterSequence,
		)
		if !ok || terminal {
			return
		}
	}
	if terminalRunStatus(run.Status) {
		return
	}

	poll := time.NewTicker(handlers.pollInterval)
	defer poll.Stop()
	heartbeat := time.NewTimer(handlers.heartbeat)
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
				// Polling remains authoritative if a lossy relay disconnects.
				wakeups = nil
			}
		case <-poll.C:
		case <-heartbeat.C:
			if _, err := fmt.Fprint(response, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
			heartbeat.Reset(handlers.heartbeat)
			continue
		}

		for {
			found, err := handlers.repository.ListRunEvents(
				request.Context(),
				runID,
				afterSequence,
				cutoff,
				sseReplayBatch,
			)
			if err != nil {
				return
			}
			if len(found) == 0 {
				break
			}
			afterSequence, terminal, ok = writeRunEventBatch(
				response,
				flusher,
				found,
				afterSequence,
			)
			if !ok || terminal {
				return
			}
			resetTimer(heartbeat, handlers.heartbeat)
			if len(found) < sseReplayBatch {
				break
			}
		}
	}
}

func parseEventCursor(
	response http.ResponseWriter,
	request *http.Request,
) (string, bool) {
	values := request.URL.Query()
	for name, entries := range values {
		if name != "after" {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"Unknown query parameter.",
				nil,
			)
			return "", false
		}
		if len(entries) != 1 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The after cursor must appear once.",
				nil,
			)
			return "", false
		}
	}
	headerValues := request.Header.Values("Last-Event-ID")
	if len(headerValues) > 1 {
		httpapi.WriteError(
			response,
			request,
			http.StatusBadRequest,
			"INVALID_REQUEST",
			"Last-Event-ID must appear once.",
			nil,
		)
		return "", false
	}
	lastEventID := ""
	if len(headerValues) == 1 {
		lastEventID = strings.TrimSpace(headerValues[0])
	}
	after := strings.TrimSpace(values.Get("after"))
	if lastEventID != "" && after != "" {
		httpapi.WriteError(
			response,
			request,
			http.StatusBadRequest,
			"INVALID_REQUEST",
			"Provide either the Last-Event-ID header or the after cursor, not both.",
			nil,
		)
		return "", false
	}
	cursor := lastEventID
	if cursor == "" {
		cursor = after
	}
	if len(cursor) > maxCursorBytes {
		httpapi.WriteError(
			response,
			request,
			http.StatusBadRequest,
			"INVALID_REQUEST",
			"The event cursor is malformed.",
			nil,
		)
		return "", false
	}
	return cursor, true
}

func writeRunEventBatch(
	response http.ResponseWriter,
	flusher http.Flusher,
	events []runrepo.Event,
	afterSequence int64,
) (int64, bool, bool) {
	for _, event := range events {
		if event.RunID == nil || event.Sequence == nil {
			return afterSequence, false, false
		}
		if *event.Sequence <= afterSequence {
			continue
		}
		envelope := eventEnvelope{
			ID:         event.ID,
			Type:       event.Type,
			OccurredAt: event.OccurredAt.UTC().Format(time.RFC3339Nano),
			BoardID:    event.BoardID,
			IssueID:    event.IssueID,
			RunID:      *event.RunID,
			Sequence:   *event.Sequence,
			Payload:    event.Payload,
		}
		data, err := json.Marshal(envelope)
		if err != nil {
			return afterSequence, false, false
		}
		if _, err := fmt.Fprintf(
			response,
			"id: %s\nevent: %s\ndata: %s\n\n",
			event.ID.String(),
			event.Type,
			data,
		); err != nil {
			return afterSequence, false, false
		}
		flusher.Flush()
		afterSequence = *event.Sequence
		if terminalEventType(event.Type) {
			return afterSequence, true, true
		}
	}
	return afterSequence, false, true
}

func terminalRunStatus(status runrepo.Status) bool {
	return status == runrepo.StatusSucceeded ||
		status == runrepo.StatusFailed ||
		status == runrepo.StatusCancelled
}

func terminalEventType(eventType string) bool {
	return eventType == "run.completed" ||
		eventType == "run.failed" ||
		eventType == "run.cancelled"
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

func writeCursorExpired(
	response http.ResponseWriter,
	request *http.Request,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusConflict,
		"CURSOR_EXPIRED",
		"The event cursor is older than the retention window; reconnect without a cursor and reconcile from the run resource.",
		nil,
	)
}
