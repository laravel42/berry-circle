// Package automationruns exports the authenticated /api/v1/workflow-runs
// mount: the run ledger, its cancellation, and the same SSE shape the issue
// run ledger has.
package automationruns

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

const (
	minimumRetention = 24 * time.Hour
	defaultHeartbeat = 10 * time.Second
	defaultPoll      = 500 * time.Millisecond
	replayBatch      = 200
	maxCursorBytes   = 512
)

// Authorizer is the narrow workspace/run boundary.
type Authorizer interface {
	AuthorizeWorkspace(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Role, error)
	AuthorizeAutomationRun(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Scope, error)
}

// Store is the run ledger these routes read.
type Store interface {
	ListRuns(context.Context, automationrepo.RunListFilter, *automationrepo.RunCursor, int) ([]automationrepo.Run, error)
	GetRun(context.Context, uuid.UUID) (automationrepo.Run, error)
	GetRunWithSteps(context.Context, uuid.UUID) (automationrepo.Run, []automationrepo.StepRun, error)
	Cancel(context.Context, uuid.UUID, *uuid.UUID, time.Time, func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error)
	ResolveRunCursor(context.Context, uuid.UUID, uuid.UUID, time.Time) (int64, error)
	ListRunEvents(context.Context, uuid.UUID, int64, time.Time, int) ([]automationrepo.RunEvent, error)
}

// Options are explicit process dependencies.
type Options struct {
	Pool          *pgxpool.Pool
	Store         Store
	Sessions      auth.SessionResolver
	Authorization Authorizer
	Clock         func() time.Time
	NewID         func() uuid.UUID
	Broadcaster   realtime.Broadcaster
	// Canceller tells the executor a run was cancelled, so an orchestration
	// parked on a wait stops waiting. Nil when the executor needs no such
	// call (the in-process runner refuses a terminal run on its next step).
	Canceller    automationrun.Canceller
	Logger       *slog.Logger
	Retention    time.Duration
	Heartbeat    time.Duration
	PollInterval time.Duration
}

type handler struct {
	options Options
}

// NewMount validates dependencies and builds the workflow-runs subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	switch {
	case options.Sessions == nil:
		return httpapi.Mount{}, errors.New("workflow run handler session resolver is nil")
	case options.Authorization == nil:
		return httpapi.Mount{}, errors.New("workflow run handler authorizer is nil")
	case options.Clock == nil:
		return httpapi.Mount{}, errors.New("workflow run handler clock is nil")
	case options.NewID == nil:
		return httpapi.Mount{}, errors.New("workflow run handler ID generator is nil")
	}
	if options.Store == nil {
		if options.Pool == nil {
			return httpapi.Mount{}, errors.New("workflow run handler pool is nil")
		}
		store, err := automationrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Store = store
	}
	if options.Retention == 0 {
		options.Retention = minimumRetention
	}
	if options.Heartbeat == 0 {
		options.Heartbeat = defaultHeartbeat
	}
	if options.PollInterval == 0 {
		options.PollInterval = defaultPoll
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.Retention < minimumRetention {
		return httpapi.Mount{}, errors.New("workflow run event retention must be at least 24 hours")
	}
	if options.Heartbeat <= 0 || options.Heartbeat > 15*time.Second {
		return httpapi.Mount{}, errors.New("workflow run event heartbeat must be within 15 seconds")
	}
	if options.PollInterval <= 0 || options.PollInterval > options.Heartbeat {
		return httpapi.Mount{}, errors.New("workflow run event poll interval is invalid")
	}
	target := &handler{options: options}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", target.list)
	router.Get("/{runId}", target.get)
	router.Post("/{runId}/cancel", target.cancel)
	router.Get("/{runId}/events", target.stream)
	return httpapi.Mount{Prefix: "/api/v1/workflow-runs", Handler: router}, nil
}

// ValidStatus reports whether a run status filter is one the ledger stores.
func ValidStatus(status string) bool {
	switch automationrepo.RunStatus(status) {
	case automationrepo.RunPending, automationrepo.RunRunning, automationrepo.RunWaiting,
		automationrepo.RunSucceeded, automationrepo.RunFailed, automationrepo.RunCancelled:
		return true
	}
	return false
}

// FailureResource is a stable code and client-safe message.
type FailureResource struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// UsageResource is summed inline model usage.
type UsageResource struct {
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
	CostMicros   *int64 `json:"costMicros"`
}

// StepResource is one step attempt.
type StepResource struct {
	ID          uuid.UUID        `json:"id"`
	StepID      string           `json:"stepId"`
	StepType    string           `json:"stepType"`
	Attempt     int              `json:"attempt"`
	Status      string           `json:"status"`
	Input       json.RawMessage  `json:"input"`
	Output      json.RawMessage  `json:"output"`
	Failure     *FailureResource `json:"failure"`
	RunID       *uuid.UUID       `json:"runId"`
	IssueID     *uuid.UUID       `json:"issueId"`
	ApprovalID  *uuid.UUID       `json:"approvalId"`
	Usage       json.RawMessage  `json:"usage"`
	StartedAt   *string          `json:"startedAt"`
	CompletedAt *string          `json:"completedAt"`
}

// RunResource is the workflow run as the API returns it.
type RunResource struct {
	ID              uuid.UUID        `json:"id"`
	WorkspaceID     uuid.UUID        `json:"workspaceId"`
	WorkflowID      uuid.UUID        `json:"workflowId"`
	WorkflowVersion int              `json:"workflowVersion"`
	GoalID          *uuid.UUID       `json:"goalId"`
	Status          string           `json:"status"`
	TriggerType     string           `json:"triggerType"`
	TriggerPayload  json.RawMessage  `json:"triggerPayload"`
	CurrentStepID   *string          `json:"currentStepId"`
	WaitingOn       *string          `json:"waitingOn"`
	Failure         *FailureResource `json:"failure"`
	Usage           UsageResource    `json:"usage"`
	CreatedAt       string           `json:"createdAt"`
	StartedAt       *string          `json:"startedAt"`
	CompletedAt     *string          `json:"completedAt"`
	// Steps is present on the detail resource only; a list row omits it.
	Steps *[]StepResource `json:"steps,omitempty"`
}

// SerializeRun builds the run resource; steps are included when given.
func SerializeRun(run automationrepo.Run, steps []automationrepo.StepRun) RunResource {
	out := RunResource{
		ID: run.ID, WorkspaceID: run.WorkspaceID, WorkflowID: run.AutomationID, WorkflowVersion: run.AutomationVersion, GoalID: run.GoalID,
		Status: string(run.Status), TriggerType: string(run.TriggerType), TriggerPayload: nonEmpty(run.TriggerPayload),
		CurrentStepID: run.CurrentStepID, WaitingOn: run.WaitingOn,
		Usage:     UsageResource{InputTokens: run.Usage.InputTokens, OutputTokens: run.Usage.OutputTokens, CostMicros: run.Usage.CostMicros},
		CreatedAt: run.CreatedAt.UTC().Format(time.RFC3339Nano), StartedAt: formatTime(run.StartedAt), CompletedAt: formatTime(run.CompletedAt),
	}
	if run.Failure != nil {
		out.Failure = &FailureResource{Code: run.Failure.Code, Message: run.Failure.Message}
	}
	if steps != nil {
		items := make([]StepResource, 0, len(steps))
		out.Steps = &items
		for _, step := range steps {
			item := StepResource{
				ID: step.ID, StepID: step.StepID, StepType: string(step.StepType), Attempt: step.Attempt, Status: string(step.Status),
				Input: nullable(step.Input), Output: nullable(step.Output), RunID: step.IssueRunID, IssueID: step.IssueID, ApprovalID: step.ApprovalID,
				Usage: nullable(step.Usage), StartedAt: formatTime(step.StartedAt), CompletedAt: formatTime(step.CompletedAt),
			}
			if step.Failure != nil {
				item.Failure = &FailureResource{Code: step.Failure.Code, Message: step.Failure.Message}
			}
			items = append(items, item)
		}
		out.Steps = &items
	}
	return out
}

func nonEmpty(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}

func nullable(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`null`)
	}
	return raw
}

func (handler *handler) list(response http.ResponseWriter, request *http.Request) {
	page, ok := workmanagement.ParsePage(response, request, "workspaceId", "status", "workflowId")
	if !ok {
		return
	}
	query := request.URL.Query()
	workspaceID, ok := workmanagement.ParseCanonicalUUID(query.Get("workspaceId"))
	if !ok {
		workmanagement.WriteInvalidQuery(response, request, "/query/workspaceId", "workspaceId must be a canonical UUID.")
		return
	}
	filter := automationrepo.RunListFilter{WorkspaceID: workspaceID}
	if status := query.Get("status"); status != "" {
		if !ValidStatus(status) {
			workmanagement.WriteInvalidQuery(response, request, "/query/status", "status is not a run status.")
			return
		}
		filter.Status = automationrepo.RunStatus(status)
	}
	if raw := query.Get("workflowId"); raw != "" {
		parsed, ok := workmanagement.ParseCanonicalUUID(raw)
		if !ok {
			workmanagement.WriteInvalidQuery(response, request, "/query/workflowId", "workflowId must be a canonical UUID.")
			return
		}
		filter.AutomationID = &parsed
	}
	user := auth.MustUser(request.Context())
	if _, err := handler.options.Authorization.AuthorizeWorkspace(request.Context(), user.ID, workspaceID, identity.PermissionRead); !workmanagement.WriteAuthorization(response, request, err, "Workspace") {
		return
	}
	scope := workmanagement.CursorScope("workflow-runs.list", workspaceID.String(), string(filter.Status), query.Get("workflowId"))
	var after *automationrepo.RunCursor
	if page.After != "" {
		var cursor automationrepo.RunCursor
		if httpapi.DecodeCursor(page.After, scope, &cursor) != nil || cursor.ID == uuid.Nil || cursor.CreatedAt.IsZero() {
			workmanagement.WriteInvalidCursor(response, request)
			return
		}
		after = &cursor
	}
	runs, err := handler.options.Store.ListRuns(request.Context(), filter, after, page.First+1)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	hasNext := len(runs) > page.First
	if hasNext {
		runs = runs[:page.First]
	}
	nodes := make([]RunResource, 0, len(runs))
	for _, run := range runs {
		nodes = append(nodes, SerializeRun(run, nil))
	}
	var endCursor *string
	if len(runs) > 0 {
		last := runs[len(runs)-1]
		encoded, err := httpapi.EncodeCursor(scope, automationrepo.RunCursor{CreatedAt: last.CreatedAt, ID: last.ID})
		if err != nil {
			workmanagement.WriteInternal(response, request)
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes, "pageInfo": workmanagement.PageInfo{HasNextPage: hasNext, EndCursor: endCursor}})
}

func (handler *handler) authorize(response http.ResponseWriter, request *http.Request, permission identity.Permission) (uuid.UUID, identity.Scope, bool) {
	runID, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, "runId"))
	if !ok {
		workmanagement.WriteNotFound(response, request, "Workflow run")
		return uuid.Nil, identity.Scope{}, false
	}
	user := auth.MustUser(request.Context())
	scope, err := handler.options.Authorization.AuthorizeAutomationRun(request.Context(), user.ID, runID, permission)
	if !workmanagement.WriteAuthorization(response, request, err, "Workflow run") {
		return uuid.Nil, identity.Scope{}, false
	}
	return runID, scope, true
}

func (handler *handler) get(response http.ResponseWriter, request *http.Request) {
	runID, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	run, steps, err := handler.options.Store.GetRunWithSteps(request.Context(), runID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, SerializeRun(run, steps))
}

func (handler *handler) cancel(response http.ResponseWriter, request *http.Request) {
	runID, _, ok := handler.authorize(response, request, identity.PermissionRunsDispatch)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	run, event, err := handler.options.Store.Cancel(request.Context(), runID, &user.ID, handler.options.Clock().UTC(), handler.options.NewID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	shared.PublishLedger(request.Context(), handler.options.Broadcaster, []automationrepo.Event{event})
	// The row is what was cancelled; the executor only learns to stop
	// waiting. A signal that does not land leaves an orchestration that
	// ends at its own timeout, never a run that comes back to life.
	if handler.options.Canceller != nil {
		if err := handler.options.Canceller.Cancel(context.WithoutCancel(request.Context()), runID); err != nil {
			handler.options.Logger.Warn("workflow run cancellation not signalled", "runId", runID, "error", err)
		}
	}
	httpapi.WriteJSON(response, http.StatusOK, SerializeRun(run, nil))
}

func (handler *handler) writeError(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, automationrepo.ErrNotFound):
		workmanagement.WriteNotFound(response, request, "Workflow run")
	case errors.Is(err, automationrepo.ErrRunTerminal):
		httpapi.WriteError(response, request, http.StatusConflict, "RUN_TERMINAL", "The run already finished.", nil)
	default:
		workmanagement.WriteInternal(response, request)
	}
}

// envelope is the workflow run stream frame.
type envelope struct {
	ID            uuid.UUID       `json:"id"`
	Type          string          `json:"type"`
	OccurredAt    string          `json:"occurredAt"`
	WorkspaceID   uuid.UUID       `json:"workspaceId"`
	WorkflowID    uuid.UUID       `json:"workflowId"`
	WorkflowRunID uuid.UUID       `json:"workflowRunId"`
	StepID        *string         `json:"stepId,omitempty"`
	Sequence      int64           `json:"sequence"`
	Payload       json.RawMessage `json:"payload"`
}

func (handler *handler) stream(response http.ResponseWriter, request *http.Request) {
	runID, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	cursor, ok := parseEventCursor(response, request)
	if !ok {
		return
	}
	run, err := handler.options.Store.GetRun(request.Context(), runID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	cutoff := handler.options.Clock().UTC().Add(-handler.options.Retention)
	afterSequence := int64(-1)
	if cursor != "" {
		eventID, err := uuid.Parse(cursor)
		if err != nil || eventID == uuid.Nil || eventID.String() != cursor {
			writeCursorExpired(response, request)
			return
		}
		afterSequence, err = handler.options.Store.ResolveRunCursor(request.Context(), runID, eventID, cutoff)
		if errors.Is(err, automationrepo.ErrCursorExpired) {
			writeCursorExpired(response, request)
			return
		}
		if err != nil {
			workmanagement.WriteInternal(response, request)
			return
		}
	}
	flusher, ok := response.(http.Flusher)
	if !ok {
		httpapi.WriteError(response, request, http.StatusInternalServerError, "STREAMING_UNAVAILABLE", "Event streaming is unavailable.", nil)
		return
	}
	var subscription *realtime.Subscription
	if handler.options.Broadcaster != nil {
		subscription, _ = handler.options.Broadcaster.Subscribe(request.Context(), run.WorkspaceID.String())
		if subscription != nil {
			defer subscription.Close()
		}
	}
	backlog, err := handler.options.Store.ListRunEvents(request.Context(), runID, afterSequence, cutoff, replayBatch)
	if err != nil {
		workmanagement.WriteInternal(response, request)
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

	afterSequence, terminal, ok := writeBatch(response, flusher, backlog, afterSequence)
	if !ok || terminal {
		return
	}
	for len(backlog) == replayBatch {
		backlog, err = handler.options.Store.ListRunEvents(request.Context(), runID, afterSequence, cutoff, replayBatch)
		if err != nil {
			return
		}
		afterSequence, terminal, ok = writeBatch(response, flusher, backlog, afterSequence)
		if !ok || terminal {
			return
		}
	}
	if run.Status.Terminal() {
		return
	}
	poll := time.NewTicker(handler.options.PollInterval)
	defer poll.Stop()
	heartbeat := time.NewTimer(handler.options.Heartbeat)
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
			heartbeat.Reset(handler.options.Heartbeat)
			continue
		}
		for {
			found, err := handler.options.Store.ListRunEvents(request.Context(), runID, afterSequence, cutoff, replayBatch)
			if err != nil {
				return
			}
			if len(found) == 0 {
				break
			}
			afterSequence, terminal, ok = writeBatch(response, flusher, found, afterSequence)
			if !ok || terminal {
				return
			}
			resetTimer(heartbeat, handler.options.Heartbeat)
			if len(found) < replayBatch {
				break
			}
		}
	}
}

func parseEventCursor(response http.ResponseWriter, request *http.Request) (string, bool) {
	values := request.URL.Query()
	for name, entries := range values {
		if name != "after" || len(entries) != 1 {
			httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "Unknown or repeated query parameter.", nil)
			return "", false
		}
	}
	headerValues := request.Header.Values("Last-Event-ID")
	if len(headerValues) > 1 {
		httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "Last-Event-ID must appear once.", nil)
		return "", false
	}
	lastEventID := ""
	if len(headerValues) == 1 {
		lastEventID = strings.TrimSpace(headerValues[0])
	}
	after := strings.TrimSpace(values.Get("after"))
	if lastEventID != "" && after != "" {
		httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "Provide either the Last-Event-ID header or the after cursor, not both.", nil)
		return "", false
	}
	cursor := lastEventID
	if cursor == "" {
		cursor = after
	}
	if len(cursor) > maxCursorBytes {
		httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_REQUEST", "The event cursor is malformed.", nil)
		return "", false
	}
	return cursor, true
}

func writeBatch(response http.ResponseWriter, flusher http.Flusher, events []automationrepo.RunEvent, afterSequence int64) (int64, bool, bool) {
	for _, event := range events {
		if event.Sequence <= afterSequence {
			continue
		}
		data, err := json.Marshal(envelope{
			ID: event.ID, Type: event.Type, OccurredAt: event.OccurredAt.UTC().Format(time.RFC3339Nano), WorkspaceID: event.WorkspaceID,
			WorkflowID: event.AutomationID, WorkflowRunID: event.RunID, StepID: event.StepID, Sequence: event.Sequence, Payload: event.Payload,
		})
		if err != nil {
			return afterSequence, false, false
		}
		if _, err := fmt.Fprintf(response, "id: %s\nevent: %s\ndata: %s\n\n", event.ID.String(), event.Type, data); err != nil {
			return afterSequence, false, false
		}
		flusher.Flush()
		afterSequence = event.Sequence
		if terminalEventType(event.Type) {
			return afterSequence, true, true
		}
	}
	return afterSequence, false, true
}

func terminalEventType(eventType string) bool {
	return eventType == "workflow.run.succeeded" || eventType == "workflow.run.failed" || eventType == "workflow.run.cancelled"
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

func writeCursorExpired(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusConflict, "CURSOR_EXPIRED",
		"The event cursor is older than the retention window; reconnect without a cursor and reconcile from the run resource.", nil)
}

func formatTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

// Mounts follows the shared registry convention and fails fast on invalid wiring.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic("construct workflow run handlers: " + err.Error())
	}
	return []httpapi.Mount{mount}
}
