// Package runadmission coordinates durable admission and exactly-once dispatch.
package runadmission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"

	"github.com/laravel42/berry-circle/server/internal/artifacts"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

const (
	defaultWorkers   = 4
	defaultQueueSize = 128
	publicChunkBytes = 16 * 1024
	maxSummaryBytes  = 5000
	// maxPromptBytes is the upstream message limit; anything longer is a 413.
	maxPromptBytes = 64 * 1024
	// commentBodyBytes bounds the result a run posts on its issue. The row
	// allows char_length(body) <= 100000 (comments_body_length_ck in
	// migrations/001_berry_core.up.sql); a byte bound of the same size is
	// never looser than the character bound, so what fits here fits the row.
	commentBodyBytes = 100000
	// truncationNote ends a result that was cut to fit, so nobody mistakes a
	// cut-off report for a complete one.
	truncationNote = "\n\n[Truncated by Berry: the full text is in the run's output events.]"
)

// Store is the complete durable seam used by the coordinator.
type Store interface {
	Admit(context.Context, runs.AdmitParams) (runs.Run, error)
	Get(context.Context, uuid.UUID) (runs.Run, error)
	ClaimDispatch(context.Context, uuid.UUID, time.Time) (runs.Dispatch, error)
	MarkRunning(context.Context, uuid.UUID, uuid.UUID, string, time.Time) (runs.Run, runs.Event, error)
	AppendOutput(context.Context, uuid.UUID, uuid.UUID, string, string, time.Time) (runs.Event, error)
	AppendToolStarted(context.Context, uuid.UUID, uuid.UUID, string, string, time.Time) (runs.Event, error)
	AppendToolCompleted(context.Context, uuid.UUID, uuid.UUID, string, bool, time.Time) (runs.Event, error)
	RecordProviderEvent(context.Context, uuid.UUID, uuid.UUID, string, map[string]string, time.Time) error
	CompleteSuccess(context.Context, runs.SuccessParams) (runs.Run, []runs.Event, error)
	Fail(context.Context, runs.FailParams) (runs.Run, runs.Event, error)
	RequestCancellation(context.Context, runs.CancelParams) (runs.CancellationClaim, error)
	MarkCancelled(context.Context, uuid.UUID, uuid.UUID, string, time.Time) (runs.Run, runs.Event, error)
	MarkCancellationUnconfirmed(context.Context, uuid.UUID, time.Time) error
}

// Dispatcher hands an admitted run to whatever will execute it.
//
// Two implementations exist and they differ in durability, which is the whole
// point of the seam: the in-process pool loses queued work when the process
// stops, while the durable one survives it. Both drive the same projection
// code, so they cannot interpret an upstream stream differently.
type Dispatcher interface {
	Dispatch(ctx context.Context, runID uuid.UUID) error
}

// CommentStore is the one write a run makes outside its own ledger: the
// agent's final message, posted on the issue as a comment by the agent.
type CommentStore interface {
	CreateComment(
		context.Context,
		core.CreateCommentParams,
		uuid.UUID,
	) (core.Comment, core.CommentMutationEvent, error)
}

// ArtifactSink publishes bytes the stream carried for a file the agent wrote.
// The post-run sweep only sees what reached the runtime's disk; this is the
// path for content that never did.
type ArtifactSink interface {
	PromoteContent(context.Context, artifacts.RunContext, string, []byte) error
}

// AgentEventStore records the agent.* facts a run produces: started once the
// runtime accepted the dispatch, completed when the stream ended after the
// runtime's terminal phase, failed otherwise. Workflows subscribe to them.
type AgentEventStore interface {
	RecordAgentEvent(context.Context, runs.AgentEventParams) (runs.Event, error)
}

// Options owns worker lifecycle and every external dependency explicitly.
type Options struct {
	Store       Store
	OpenFang    openfang.Runtime
	Broadcaster realtime.Broadcaster
	Clock       func() time.Time
	NewID       func() uuid.UUID
	// Dispatcher routes admitted runs. Nil selects the in-process worker pool,
	// which is the supported configuration when Temporal is disabled.
	Dispatcher    Dispatcher
	WorkerContext context.Context
	Workers       int
	QueueSize     int
	// Code renders repository context into a run's prompt. Optional.
	Code CodeContext
	// Comments posts a run's final message on its issue. Optional: without it
	// the result is still recorded on the run, just not surfaced as a comment.
	Comments CommentStore
	// Logger reports side effects a run does not fail on, such as a result
	// comment that could not be written. Nil selects slog.Default().
	Logger *slog.Logger
	// Artifacts attaches files the agent wrote through file_write under
	// output/, straight from the stream. Optional: without it those files
	// reach the issue only if the post-run sweep finds them on disk.
	Artifacts ArtifactSink
	// AgentEvents writes agent.started/completed/failed beside the run
	// facts. Optional: without it workflows cannot trigger on agent.*.
	AgentEvents AgentEventStore
}

// Service owns a bounded worker queue tied to a caller-owned context.
type Service struct {
	store       Store
	openfang    openfang.Runtime
	broadcaster realtime.Broadcaster
	clock       func() time.Time
	newID       func() uuid.UUID
	// ctx is the pool's lifetime; every projection and cleanup runs under it.
	ctx        context.Context
	pool       *Pool
	dispatcher Dispatcher
	// code renders repository context for issues whose project names one.
	// Optional: without it runs dispatch exactly as they did before.
	code CodeContext
	// comments is where a run's result goes to be read. Optional.
	comments    CommentStore
	artifacts   ArtifactSink
	agentEvents AgentEventStore
	logger      *slog.Logger
}

// New starts a bounded worker pool. Close or cancellation of WorkerContext
// terminates every worker and closes active upstream streams through context.
func New(options Options) (*Service, error) {
	if options.Store == nil {
		return nil, errors.New("run admission store is nil")
	}
	if options.OpenFang == nil {
		return nil, errors.New("run admission runtime client is nil")
	}
	if options.Broadcaster == nil {
		return nil, errors.New("run admission broadcaster is nil")
	}
	if options.Clock == nil {
		return nil, errors.New("run admission clock is nil")
	}
	if options.NewID == nil {
		return nil, errors.New("run admission ID generator is nil")
	}
	if options.WorkerContext == nil {
		return nil, errors.New("run admission worker context is nil")
	}
	if options.Workers == 0 {
		options.Workers = defaultWorkers
	}
	if options.QueueSize == 0 {
		options.QueueSize = defaultQueueSize
	}
	if options.Workers < 1 || options.Workers > maxPoolWorkers {
		return nil, errors.New("run admission worker count is invalid")
	}
	if options.QueueSize < 1 || options.QueueSize > maxPoolQueueSize {
		return nil, errors.New("run admission queue size is invalid")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	service := &Service{
		store:       options.Store,
		openfang:    options.OpenFang,
		broadcaster: options.Broadcaster,
		clock:       options.Clock,
		newID:       options.NewID,
		dispatcher:  options.Dispatcher,
		code:        options.Code,
		comments:    options.Comments,
		artifacts:   options.Artifacts,
		agentEvents: options.AgentEvents,
		logger:      logger,
	}
	pool, err := NewPool(options.WorkerContext, options.Workers, options.QueueSize, service.execute)
	if err != nil {
		return nil, err
	}
	service.pool = pool
	service.ctx = pool.Context()
	return service, nil
}

// Admit persists the complete durable acceptance unit without dispatching.
func (service *Service) Admit(
	ctx context.Context,
	params runs.AdmitParams,
) (runs.Run, error) {
	return service.store.Admit(ctx, params)
}

// Queue transfers a durably admitted run to the bounded process-owned workers.
func (service *Service) Queue(runID uuid.UUID) error {
	if service.dispatcher != nil {
		// The run is already durably admitted, so a dispatch failure leaves it
		// queued rather than losing it. Reconciliation is what recovers it; the
		// caller only needs to know the handoff did not happen.
		return service.dispatcher.Dispatch(service.ctx, runID)
	}
	return service.pool.Queue(runID)
}

// Get returns the latest durable snapshot.
func (service *Service) Get(ctx context.Context, runID uuid.UUID) (runs.Run, error) {
	return service.store.Get(ctx, runID)
}

// Cancel records intent before the one allowed upstream stop call.
func (service *Service) Cancel(
	ctx context.Context,
	runID, requestedBy uuid.UUID,
) (runs.Run, error) {
	now := service.clock().UTC()
	claim, err := service.store.RequestCancellation(ctx, runs.CancelParams{
		RunID:       runID,
		RequestedBy: requestedBy,
		RequestedAt: now,
	})
	if err != nil {
		return runs.Run{}, err
	}
	if claim.Run.Status == runs.StatusCancelled {
		return claim.Run, nil
	}
	if claim.CancelLocally {
		run, event, err := service.store.MarkCancelled(
			ctx,
			runID,
			service.newID(),
			"",
			service.clock().UTC(),
		)
		if err == nil {
			service.publish(event)
		}
		return run, err
	}
	if !claim.ShouldStop {
		if claim.Run.DispatchState == runs.DispatchReconciliationRequired {
			return claim.Run, runs.ErrCancellationUnconfirmed
		}
		return claim.Run, nil
	}

	stopped, err := service.openfang.StopAgent(ctx, claim.UpstreamAgentID)
	if err != nil {
		cleanup, cancel := service.cleanupContext()
		_ = service.store.MarkCancellationUnconfirmed(cleanup, runID, service.clock().UTC())
		cancel()
		return claim.Run, err
	}
	if !stopped.Confirmed() {
		cleanup, cancel := service.cleanupContext()
		markErr := service.store.MarkCancellationUnconfirmed(
			cleanup,
			runID,
			service.clock().UTC(),
		)
		cancel()
		if markErr != nil {
			return claim.Run, markErr
		}
		return claim.Run, runs.ErrCancellationUnconfirmed
	}
	run, event, err := service.store.MarkCancelled(
		ctx,
		runID,
		service.newID(),
		stopped.RequestID,
		service.clock().UTC(),
	)
	if err != nil {
		cleanup, cancel := service.cleanupContext()
		_ = service.store.MarkCancellationUnconfirmed(
			cleanup,
			runID,
			service.clock().UTC(),
		)
		cancel()
		return claim.Run, runs.ErrCancellationUnconfirmed
	}
	service.publish(event)
	return run, nil
}

// Close cancels workers and waits until all active streams release.
func (service *Service) Close(ctx context.Context) error {
	if service == nil {
		return nil
	}
	return service.pool.Close(ctx)
}

// Execute runs one admitted run to a terminal ledger state, synchronously,
// under a caller-supplied context.
//
// This is the seam the Temporal dispatch activity calls. It shares every line
// of projection logic with the in-process worker pool, so the two dispatchers
// cannot drift in how they interpret an upstream stream.
//
// It returns no error: every failure path inside already commits a terminal
// or reconcilable ledger state, and the ledger — not the caller — is
// authoritative. A caller that retried on error would re-POST the dispatch,
// which the pinned OpenFang contract forbids.
func (service *Service) Execute(ctx context.Context, runID uuid.UUID) {
	if service == nil || ctx == nil || runID == uuid.Nil {
		return
	}
	service.execute(ctx, runID)
}

func (service *Service) execute(ctx context.Context, runID uuid.UUID) {
	dispatch, err := service.store.ClaimDispatch(
		ctx,
		runID,
		service.clock().UTC(),
	)
	if err != nil {
		return
	}
	// Fetched here rather than in the claim query: it costs upstream calls, and
	// a claim that never reaches dispatch should not pay for them. Best effort
	// throughout — a run whose context could not be built still happens, with a
	// worse-informed agent rather than no agent.
	if service.code != nil && dispatch.Repository != "" {
		description := ""
		if dispatch.IssueDescription != nil {
			description = *dispatch.IssueDescription
		}
		dispatch.CodeContext = service.code.Build(
			ctx, dispatch.WorkspaceID, dispatch.Repository, dispatch.IssueTitle, description)
	}

	message := buildMessage(dispatch)
	senderID := "berry-run:" + runID.String()
	senderName := "Berry Gateway"
	dispatchContext := ctx
	if dispatch.TraceParent != "" {
		dispatchContext = otel.GetTextMapPropagator().Extract(
			dispatchContext,
			propagation.MapCarrier{"traceparent": dispatch.TraceParent},
		)
	}
	stream, err := service.openfang.DispatchMessage(
		dispatchContext,
		dispatch.UpstreamAgentID,
		openfang.MessageRequest{
			Message:    message,
			SenderID:   &senderID,
			SenderName: &senderName,
			RequestID:  dispatch.RequestID,
		},
	)
	if err != nil {
		service.failDispatch(runID, err)
		return
	}
	defer stream.Close()

	_, started, err := service.store.MarkRunning(
		ctx,
		runID,
		service.newID(),
		stream.RequestID(),
		service.clock().UTC(),
	)
	if err != nil {
		service.failProjection(runID, err)
		return
	}
	service.publish(started)
	service.recordAgentEvent(runID, "agent.started", nil)

	// The pinned upstream emits done at the end of every model turn and keeps
	// the connection open for the next one whenever the agent called a tool.
	// Treating the first done as the end recorded runs as finished seconds in,
	// with "I'll look into this" as their result, while the agent worked on
	// for minutes into a socket nobody was reading. So done closes a turn, the
	// end of the body closes the run, and usage is summed over the turns.
	var (
		result      = resultText{turn: boundedText{max: commentBodyBytes}}
		turns       int
		usage       runs.Usage
		toolCounter int
		openTools   = make(map[string][]string)
		// completed is the runtime's own word that the loop finished: the
		// terminal phase event it emits right before closing the body. A loop
		// that failed mid-way (a provider refusal, a truncated tool call it
		// gave up on) closes the body without it, and that run must not be
		// recorded as succeeded with whatever partial text it had.
		completed    bool
		runtimeError bool
	)
	for {
		event, err := stream.Next()
		if errors.Is(err, io.EOF) && turns > 0 {
			// Text after the last done never got its boundary. It is still the
			// most recent thing the agent said, so it counts as a turn.
			result.EndTurn()
			if !completed || runtimeError {
				service.failIncomplete(dispatch, usage, turns)
				return
			}
			text, cut := result.Final()
			service.complete(ctx, dispatch, usage, text, cut)
			return
		}
		if err != nil {
			service.failStream(runID, err)
			return
		}
		switch event.Type {
		case openfang.EventChunk:
			result.Append(event.Content)
			for _, chunk := range splitUTF8(event.Content, publicChunkBytes) {
				persisted, appendErr := service.store.AppendOutput(
					ctx,
					runID,
					service.newID(),
					"progress",
					chunk,
					service.clock().UTC(),
				)
				if appendErr != nil {
					service.failProjection(runID, appendErr)
					return
				}
				service.publish(persisted)
			}
		case openfang.EventToolUse:
			toolCounter++
			callID := fmt.Sprintf("tool_%06d", toolCounter)
			openTools[event.Tool] = append(openTools[event.Tool], callID)
			persisted, appendErr := service.store.AppendToolStarted(
				ctx,
				runID,
				service.newID(),
				callID,
				safeLabel(event.Tool, 200),
				service.clock().UTC(),
			)
			if appendErr != nil {
				service.failProjection(runID, appendErr)
				return
			}
			service.publish(persisted)
		case openfang.EventToolResult:
			callID := popTool(openTools, event.Tool)
			if callID == "" {
				toolCounter++
				callID = fmt.Sprintf("tool_%06d", toolCounter)
			}
			persisted, appendErr := service.store.AppendToolCompleted(
				ctx,
				runID,
				service.newID(),
				callID,
				true,
				service.clock().UTC(),
			)
			if appendErr != nil {
				service.failProjection(runID, appendErr)
				return
			}
			service.publish(persisted)
			service.captureFile(ctx, dispatch, event)
		case openfang.EventPhase:
			if event.Phase == terminalPhase {
				completed = true
			}
			_ = service.store.RecordProviderEvent(
				ctx,
				runID,
				service.newID(),
				"phase",
				map[string]string{"phase": safeLabel(event.Phase, 200)},
				service.clock().UTC(),
			)
		case openfang.EventUnknown:
			if event.EventName == "error" {
				runtimeError = true
			}
			_ = service.store.RecordProviderEvent(
				ctx,
				runID,
				service.newID(),
				"unknown",
				map[string]string{"event": safeLabel(event.EventName, 100)},
				service.clock().UTC(),
			)
		case openfang.EventDone:
			turns++
			usage.InputTokens += event.Usage.InputTokens
			usage.OutputTokens += event.Usage.OutputTokens
			usage.TotalTokens = usage.InputTokens + usage.OutputTokens
			result.EndTurn()
			// The ledger shows where one turn ended and what it cost, which is
			// what an operator reading a long run needs to see its shape.
			_ = service.store.RecordProviderEvent(
				ctx,
				runID,
				service.newID(),
				"turn",
				map[string]string{
					"turn":         strconv.Itoa(turns),
					"inputTokens":  strconv.FormatInt(event.Usage.InputTokens, 10),
					"outputTokens": strconv.FormatInt(event.Usage.OutputTokens, 10),
				},
				service.clock().UTC(),
			)
		}
	}
}

// complete commits success and then surfaces the result where people look.
func (service *Service) complete(
	ctx context.Context,
	dispatch runs.Dispatch,
	usage runs.Usage,
	text string,
	cut bool,
) {
	var summary *string
	if text != "" {
		value := truncateUTF8(text, maxSummaryBytes)
		summary = &value
	}
	_, persisted, err := service.store.CompleteSuccess(
		ctx,
		runs.SuccessParams{
			RunID:            dispatch.RunID,
			UsageEventID:     service.newID(),
			CompletedEventID: service.newID(),
			IssueEventID:     service.newID(),
			Usage:            usage,
			Summary:          summary,
			CompletedAt:      service.clock().UTC(),
		},
	)
	if err != nil {
		service.failProjection(dispatch.RunID, err)
		return
	}
	for _, item := range persisted {
		service.publish(item)
	}
	service.recordAgentEvent(dispatch.RunID, "agent.completed", nil)
	if text != "" {
		service.postResult(dispatch, text, cut)
	}
}

// recordAgentEvent writes one agent.* fact after the run transition it
// describes committed. Best effort like the result comment: the run's own
// ledger is authoritative and an agent event that could not be written is a
// missing notification, logged rather than turned into a failed run.
func (service *Service) recordAgentEvent(runID uuid.UUID, topic string, failure *runs.Failure) {
	if service.agentEvents == nil {
		return
	}
	ctx, cancel := service.cleanupContext()
	defer cancel()
	event, err := service.agentEvents.RecordAgentEvent(ctx, runs.AgentEventParams{
		RunID:      runID,
		EventID:    service.newID(),
		Topic:      topic,
		Failure:    failure,
		OccurredAt: service.clock().UTC(),
	})
	if err != nil {
		service.logger.Warn("agent event not recorded", "runId", runID, "topic", topic, "error", err)
		return
	}
	service.publish(event)
}

// SetArtifacts installs the artifact sink after construction. The worker only
// knows whether promotion is configured once its storage is up, which happens
// after the dispatcher exists and before any run is claimed.
func (service *Service) SetArtifacts(sink ArtifactSink) {
	if service != nil {
		service.artifacts = sink
	}
}

// postResult puts the agent's final message on the issue as the agent's own
// comment, which is where whoever assigned the work will look for it.
//
// Best effort by design: the run is already recorded as succeeded and the
// model call already paid for, so a comment that cannot be written is a
// missing notification, not a failed run. It is logged and the run stands.
func (service *Service) postResult(
	dispatch runs.Dispatch,
	text string,
	cut bool,
) {
	if service.comments == nil {
		return
	}
	ctx, cancel := service.cleanupContext()
	defer cancel()
	_, event, err := service.comments.CreateComment(
		ctx,
		core.CreateCommentParams{
			ID:         service.newID(),
			IssueID:    dispatch.IssueID,
			AuthorType: "agent",
			AuthorID:   dispatch.AgentID,
			Body:       commentBody(text, cut),
			CreatedAt:  service.clock().UTC(),
		},
		service.newID(),
	)
	if err != nil {
		service.logger.Warn(
			"run result comment failed",
			"runId", dispatch.RunID,
			"issueId", dispatch.IssueID,
			"error", err,
		)
		return
	}
	service.publishComment(event)
}

func (service *Service) failDispatch(runID uuid.UUID, cause error) {
	failure, reconcile := mapDispatchFailure(cause)
	ctx, cancel := service.cleanupContext()
	defer cancel()
	_, event, err := service.store.Fail(
		ctx,
		runs.FailParams{
			RunID:     runID,
			EventID:   service.newID(),
			Failure:   failure,
			FailedAt:  service.clock().UTC(),
			Reconcile: reconcile,
		},
	)
	if err == nil {
		service.publish(event)
		service.recordAgentEvent(runID, "agent.failed", &failure)
	}
}

// terminalPhase is the phase the runtime reports when its agent loop has
// genuinely finished; it precedes the end of the body on every clean run.
const terminalPhase = "done"

// outputPrefix is where the run prompt tells the agent to put deliverables,
// and the only place a file_write is captured from: anything else the agent
// writes is scratch.
const outputPrefix = "output/"

// failIncomplete records a run whose body ended after real work but without
// the runtime saying the loop completed. The usage is kept as a provider event
// so the tokens are not lost from the ledger even though the run failed.
func (service *Service) failIncomplete(dispatch runs.Dispatch, usage runs.Usage, turns int) {
	ctx, cancel := service.cleanupContext()
	defer cancel()
	_ = service.store.RecordProviderEvent(
		ctx,
		dispatch.RunID,
		service.newID(),
		"usage",
		map[string]string{
			"turns":        strconv.Itoa(turns),
			"inputTokens":  strconv.FormatInt(usage.InputTokens, 10),
			"outputTokens": strconv.FormatInt(usage.OutputTokens, 10),
		},
		service.clock().UTC(),
	)
	failure := runs.Failure{
		Code:      "RUN_INCOMPLETE",
		Message:   "The runtime ended the run before the agent finished.",
		Retryable: false,
	}
	_, event, err := service.store.Fail(
		ctx,
		runs.FailParams{
			RunID:     dispatch.RunID,
			EventID:   service.newID(),
			Failure:   failure,
			FailedAt:  service.clock().UTC(),
			Reconcile: true,
		},
	)
	if err == nil {
		service.publish(event)
		service.recordAgentEvent(dispatch.RunID, "agent.failed", &failure)
	}
}

// captureFile attaches the content of a file_write under output/ as a run
// artifact. Best effort: a file that cannot be attached is logged, and the run
// goes on — the post-run sweep may still find it on disk.
func (service *Service) captureFile(
	ctx context.Context,
	dispatch runs.Dispatch,
	event openfang.StreamEvent,
) {
	if service.artifacts == nil || event.Tool != "file_write" {
		return
	}
	if event.InputDropped || len(event.Input) == 0 {
		service.logger.Info("file write too large to capture from the stream",
			"runId", dispatch.RunID)
		return
	}
	var input struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(event.Input, &input); err != nil || input.Path == "" {
		return
	}
	cleaned := path.Clean(strings.TrimSpace(input.Path))
	if !strings.HasPrefix(cleaned, outputPrefix) || input.Content == "" {
		return
	}
	name := strings.TrimPrefix(cleaned, outputPrefix)
	now := service.clock().UTC()
	err := service.artifacts.PromoteContent(
		ctx,
		artifacts.RunContext{RunID: dispatch.RunID, StartedAt: now, CompletedAt: now},
		name,
		[]byte(input.Content),
	)
	if err != nil {
		service.logger.Warn("could not attach a file the agent wrote",
			"runId", dispatch.RunID, "file", name, "error", err)
		return
	}
	service.logger.Info("attached a file the agent wrote",
		"runId", dispatch.RunID, "file", name, "bytes", len(input.Content))
}

func (service *Service) failStream(runID uuid.UUID, cause error) {
	failure := runs.Failure{
		Code:      "STREAM_INTERRUPTED",
		Message:   "The runtime stream ended before completion.",
		Retryable: false,
	}
	var streamError *openfang.StreamError
	if errors.As(cause, &streamError) {
		switch streamError.Kind {
		case openfang.StreamMalformed:
			failure.Code = "STREAM_MALFORMED"
			failure.Message = "The runtime stream contained an invalid event."
		case openfang.StreamLimit:
			failure.Code = "STREAM_LIMIT_EXCEEDED"
			failure.Message = "The runtime stream exceeded a safe processing limit."
		case openfang.StreamTimeout:
			failure.Code = "STREAM_TIMEOUT"
			failure.Message = "The runtime stream exceeded its time limit."
		}
	}
	ctx, cancel := service.cleanupContext()
	defer cancel()
	_, event, err := service.store.Fail(
		ctx,
		runs.FailParams{
			RunID:     runID,
			EventID:   service.newID(),
			Failure:   failure,
			FailedAt:  service.clock().UTC(),
			Reconcile: true,
		},
	)
	if err == nil {
		service.publish(event)
		service.recordAgentEvent(runID, "agent.failed", &failure)
	}
}

func (service *Service) failProjection(runID uuid.UUID, cause error) {
	// A terminal run already has its outcome, and a run whose cancellation is
	// in progress is about to get one from Cancel. Neither is a projection
	// failure, and marking either failed would fight the outcome it has.
	if errors.Is(cause, runs.ErrRunTerminal) || errors.Is(cause, runs.ErrRunCancelling) {
		return
	}
	ctx, cancel := service.cleanupContext()
	defer cancel()
	_, event, err := service.store.Fail(ctx, runs.FailParams{
		RunID:   runID,
		EventID: service.newID(),
		Failure: runs.Failure{
			Code:      "PROJECTION_FAILED",
			Message:   "The runtime result could not be durably projected.",
			Retryable: false,
		},
		FailedAt:  service.clock().UTC(),
		Reconcile: true,
	})
	if err == nil {
		service.publish(event)
	}
}

func (service *Service) publish(event runs.Event) {
	if event.ID == uuid.Nil {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"eventId": event.ID,
		"runId":   event.RunID,
	})
	if err != nil {
		return
	}
	ctx, cancel := service.cleanupContext()
	defer cancel()
	// The workspace is the scope of record and the board a second delivery
	// key: the run and board streams subscribe on the board id, so it has to
	// travel with the event for them to wake up.
	_ = service.broadcaster.Publish(ctx, realtime.Event{
		ID:          event.ID.String(),
		WorkspaceID: event.WorkspaceID.String(),
		BoardID:     event.BoardID.String(),
		Type:        event.Type,
		Payload:     payload,
		OccurredAt:  event.OccurredAt,
	})
}

// publishComment mirrors what the comment routes do after their commit.
func (service *Service) publishComment(event core.CommentMutationEvent) {
	if event.ID == uuid.Nil {
		return
	}
	ctx, cancel := service.cleanupContext()
	defer cancel()
	boardID := ""
	if event.BoardID != uuid.Nil {
		boardID = event.BoardID.String()
	}
	_ = service.broadcaster.Publish(ctx, realtime.Event{
		ID:          event.ID.String(),
		WorkspaceID: event.WorkspaceID.String(),
		BoardID:     boardID,
		Type:        event.Type,
		Payload:     json.RawMessage(event.Payload),
		OccurredAt:  event.OccurredAt,
	})
}

func (service *Service) cleanupContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(service.ctx), 5*time.Second)
}

func mapDispatchFailure(err error) (runs.Failure, bool) {
	var upstream *openfang.UpstreamError
	if !errors.As(err, &upstream) {
		return runs.Failure{
			Code:      "DISPATCH_AMBIGUOUS",
			Message:   "The runtime dispatch result is unknown.",
			Retryable: false,
		}, true
	}
	switch upstream.Kind {
	case openfang.ErrorNotFound:
		return runs.Failure{
			Code:      "AGENT_UNAVAILABLE",
			Message:   "The assigned runtime agent is unavailable.",
			Retryable: true,
		}, false
	case openfang.ErrorBadRequest:
		return runs.Failure{
			Code:      "DISPATCH_REJECTED",
			Message:   "The runtime rejected the dispatch.",
			Retryable: false,
		}, false
	case openfang.ErrorAuth:
		return runs.Failure{
			Code:      "DEPENDENCY_AUTHENTICATION",
			Message:   "The runtime integration is not authorized.",
			Retryable: false,
		}, false
	case openfang.ErrorBadResponse:
		reconcile := upstream.StatusCode == 502
		return runs.Failure{
			Code:      "DEPENDENCY_BAD_RESPONSE",
			Message:   "The runtime returned an unusable response.",
			Retryable: false,
		}, reconcile
	default:
		reconcile := upstream.StatusCode == 0
		code := "DEPENDENCY_UNAVAILABLE"
		message := "The runtime dependency is unavailable."
		if reconcile {
			code = "DISPATCH_AMBIGUOUS"
			message = "The runtime dispatch result is unknown."
		}
		return runs.Failure{Code: code, Message: message, Retryable: !reconcile}, reconcile
	}
}

// CodeContext renders the repository an issue belongs to, for the prompt.
//
// The workspace is a parameter rather than fixed at construction: one service
// dispatches for every workspace, and a credential opened for the wrong one
// would read a repository this issue has no claim to.
type CodeContext interface {
	Build(ctx context.Context, workspaceID uuid.UUID, repository, title, description string) string
}

func buildMessage(dispatch runs.Dispatch) string {
	var builder strings.Builder
	builder.WriteString("Berry issue ")
	builder.WriteString(dispatch.IssueIdentifier)
	builder.WriteString("\n\nTitle: ")
	builder.WriteString(dispatch.IssueTitle)
	if dispatch.IssueDescription != nil && *dispatch.IssueDescription != "" {
		builder.WriteString("\n\nDescription:\n")
		builder.WriteString(*dispatch.IssueDescription)
	}
	if dispatch.Instructions != nil && *dispatch.Instructions != "" {
		builder.WriteString("\n\nRun instructions:\n")
		builder.WriteString(*dispatch.Instructions)
	}
	if dispatch.CodeContext != "" {
		builder.WriteString(dispatch.CodeContext)
	}
	// The contracts go last so the agent reads them with the task fresh, but
	// the cap cuts from the tail, so a long description or code context would
	// silently drop them first. They get their room reserved; the description
	// gives way instead.
	contracts := reportingContract()
	if dispatch.Repository != "" {
		contracts += deliveryContract(dispatch.Repository)
	}
	return truncateUTF8(builder.String(), maxPromptBytes-len(contracts)) + contracts
}

// reportingContract tells the agent what becomes of its last message.
//
// In the prompt because the agent cannot see it otherwise: to the model, a
// turn that ends with "I'll research this" is a plan it is about to carry out,
// but Berry records the final message as the run's result and posts it on the
// issue. A promise in that position is an empty report, and the real findings
// end up only in a workspace nobody opens.
//
// The report itself goes in the message, not in a file: on a repository run
// everything under output/ is delivered as the pull request, and a stray
// report.md would land in the repository root.
func reportingContract() string {
	return "\n\nReporting your result\n" +
		"Your final message is recorded as the result of this run and posted on " +
		"the issue as your comment. End with a complete, self-contained answer: " +
		"what you found, what you did, and anything the reader needs to know. " +
		"Do not end on a plan or a promise to do work, and do not rely on " +
		"anything you said earlier being read. The final message is the report; " +
		"do not point the reader to a file for it.\n" +
		"Files you produce beyond it (data, generated documents, code) belong " +
		"under the output/ directory of your workspace, where Berry can collect " +
		"them after the run.\n"
}

// deliveryContract tells the agent how to hand code back.
//
// Spelled out in the prompt because the runtime gives it no way to discover
// this: there is no git binary, no credential and no network path to the
// repository, so an agent left to work it out describes the change it would
// make instead of writing it. What it writes into output/ is what Berry
// commits, and nothing else it does reaches the repository.
func deliveryContract(repository string) string {
	return "\n\nDelivering your work\n" +
		"Write every file you want committed into the output/ directory of your " +
		"workspace, at the path it should have in the repository: a change to " +
		"src/api/handler.go goes to output/src/api/handler.go.\n" +
		"Write each file's complete new contents. Berry commits the file as you " +
		"wrote it rather than applying a patch, so a partial file replaces the " +
		"whole one. Files you leave alone are untouched.\n" +
		"When you finish, Berry collects those files and opens a pull request " +
		"against " + repository + " for a human to review. You have no git and no " +
		"access to the repository yourself, so do not attempt git commands, and do " +
		"not describe a diff in place of writing the file. Anything written " +
		"outside output/ is not delivered, and everything inside it is: keep " +
		"files that do not belong in the repository, such as notes or scratch " +
		"data, out of output/ and put what they say in your final message.\n"
}

// resultText tracks the agent's final message across turns.
//
// Each turn's text is kept apart because the final message is what the agent
// reports with: earlier turns ("I'll look into this") are progress. A turn
// that says nothing, such as a bare tool call, leaves the result as it was.
type resultText struct {
	turn boundedText
	// last is the most recent turn that said anything; substantive the most
	// recent that said enough to be a report. The agent's closing line after a
	// long answer is usually a sign-off ("I'll write that to a file"), and
	// recording it as the result lost the answer it followed.
	last, substantive string
	lastCut, subCut   bool
}

// substantiveResultBytes separates an answer from a remark. A report is
// hundreds of bytes at the least; a sign-off or a "looking into it" is not.
const substantiveResultBytes = 400

func (text *resultText) Append(value string) {
	text.turn.Append(value)
}

// EndTurn closes the turn in progress, remembering its text when it had any.
func (text *resultText) EndTurn() {
	if value, cut := text.turn.Text(); value != "" {
		text.last, text.lastCut = value, cut
		if len(value) >= substantiveResultBytes {
			text.substantive, text.subCut = value, cut
		}
	}
	text.turn.Reset()
}

// Final is the result and whether it was cut to fit: the last substantive
// turn, or the last turn that said anything when nothing was substantive.
func (text *resultText) Final() (string, bool) {
	if text.substantive != "" {
		return text.substantive, text.subCut
	}
	return text.last, text.lastCut
}

// boundedText keeps the first max bytes appended to it and remembers whether
// anything was dropped, so a truncated result can say so.
type boundedText struct {
	builder strings.Builder
	max     int
	cut     bool
}

func (text *boundedText) Append(value string) {
	remaining := text.max - text.builder.Len()
	if remaining < len(value) {
		text.cut = true
	}
	if remaining <= 0 {
		return
	}
	text.builder.WriteString(truncateUTF8(value, remaining))
}

func (text *boundedText) Reset() {
	text.builder.Reset()
	text.cut = false
}

// Text returns what was kept, trimmed, and whether the rest was dropped.
func (text *boundedText) Text() (string, bool) {
	return strings.TrimSpace(text.builder.String()), text.cut
}

// commentBody fits the result to the comment row, ending it with a note when
// it was cut. The turn buffer already stops at the row limit; the note needs
// its own room, so a cut result gives up a little more to carry it.
func commentBody(text string, cut bool) string {
	if !cut && len(text) <= commentBodyBytes {
		return text
	}
	return truncateUTF8(text, commentBodyBytes-len(truncationNote)) + truncationNote
}

func truncateUTF8(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	value = value[:maxBytes]
	for !utf8.ValidString(value) && len(value) > 0 {
		value = value[:len(value)-1]
	}
	return value
}

func splitUTF8(value string, maxBytes int) []string {
	if value == "" {
		return nil
	}
	result := make([]string, 0, (len(value)/maxBytes)+1)
	for value != "" {
		part := truncateUTF8(value, maxBytes)
		if part == "" {
			_, size := utf8.DecodeRuneInString(value)
			part = value[:size]
		}
		result = append(result, part)
		value = value[len(part):]
	}
	return result
}

func safeLabel(value string, maxBytes int) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	return truncateUTF8(value, maxBytes)
}

func popTool(open map[string][]string, name string) string {
	values := open[name]
	if len(values) == 0 {
		return ""
	}
	value := values[len(values)-1]
	if len(values) == 1 {
		delete(open, name)
	} else {
		open[name] = values[:len(values)-1]
	}
	return value
}
