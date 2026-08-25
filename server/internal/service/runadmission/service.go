// Package runadmission coordinates durable admission and exactly-once dispatch.
package runadmission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"

	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

const (
	defaultWorkers   = 4
	defaultQueueSize = 128
	publicChunkBytes = 16 * 1024
	maxSummaryBytes  = 5000
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
}

// Service owns a bounded worker queue tied to a caller-owned context.
type Service struct {
	store       Store
	openfang    openfang.Runtime
	broadcaster realtime.Broadcaster
	clock       func() time.Time
	newID       func() uuid.UUID
	ctx         context.Context
	cancel      context.CancelFunc
	dispatcher  Dispatcher
	// code renders repository context for issues whose project names one.
	// Optional: without it runs dispatch exactly as they did before.
	code      CodeContext
	jobs      chan uuid.UUID
	wg        sync.WaitGroup
	done      chan struct{}
	closeOnce sync.Once
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
	if options.Workers < 1 || options.Workers > 128 {
		return nil, errors.New("run admission worker count is invalid")
	}
	if options.QueueSize < 1 || options.QueueSize > 100000 {
		return nil, errors.New("run admission queue size is invalid")
	}
	ctx, cancel := context.WithCancel(options.WorkerContext)
	service := &Service{
		store:       options.Store,
		openfang:    options.OpenFang,
		broadcaster: options.Broadcaster,
		clock:       options.Clock,
		newID:       options.NewID,
		dispatcher:  options.Dispatcher,
		code:        options.Code,
		ctx:         ctx,
		cancel:      cancel,
		jobs:        make(chan uuid.UUID, options.QueueSize),
		done:        make(chan struct{}),
	}
	for range options.Workers {
		service.wg.Add(1)
		go service.worker()
	}
	go func() {
		service.wg.Wait()
		close(service.done)
	}()
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
	select {
	case service.jobs <- runID:
		return nil
	case <-service.ctx.Done():
		return errors.New("run workers are shutting down")
	}
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
	service.closeOnce.Do(service.cancel)
	select {
	case <-service.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
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

func (service *Service) worker() {
	defer service.wg.Done()
	for {
		select {
		case <-service.ctx.Done():
			return
		case runID := <-service.jobs:
			service.execute(service.ctx, runID)
		}
	}
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

	var (
		summary     strings.Builder
		toolCounter int
		openTools   = make(map[string][]string)
	)
	for {
		event, err := stream.Next()
		if err != nil {
			service.failStream(runID, err)
			return
		}
		switch event.Type {
		case openfang.EventChunk:
			appendSummary(&summary, event.Content)
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
		case openfang.EventPhase:
			_ = service.store.RecordProviderEvent(
				ctx,
				runID,
				service.newID(),
				"phase",
				map[string]string{"phase": safeLabel(event.Phase, 200)},
				service.clock().UTC(),
			)
		case openfang.EventUnknown:
			_ = service.store.RecordProviderEvent(
				ctx,
				runID,
				service.newID(),
				"unknown",
				map[string]string{"event": safeLabel(event.EventName, 100)},
				service.clock().UTC(),
			)
		case openfang.EventDone:
			text := strings.TrimSpace(summary.String())
			var finalSummary *string
			if text != "" {
				finalSummary = &text
			}
			usage := runs.Usage{
				InputTokens:  event.Usage.InputTokens,
				OutputTokens: event.Usage.OutputTokens,
				TotalTokens:  event.Usage.InputTokens + event.Usage.OutputTokens,
			}
			_, persisted, completeErr := service.store.CompleteSuccess(
				ctx,
				runs.SuccessParams{
					RunID:            runID,
					UsageEventID:     service.newID(),
					CompletedEventID: service.newID(),
					IssueEventID:     service.newID(),
					Usage:            usage,
					Summary:          finalSummary,
					CompletedAt:      service.clock().UTC(),
				},
			)
			if completeErr != nil {
				service.failProjection(runID, completeErr)
				return
			}
			for _, item := range persisted {
				service.publish(item)
			}
			return
		}
	}
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
	}
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
	}
}

func (service *Service) failProjection(runID uuid.UUID, cause error) {
	if errors.Is(cause, runs.ErrRunTerminal) {
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
	_ = service.broadcaster.Publish(ctx, realtime.Event{
		ID:          event.ID.String(),
		WorkspaceID: event.BoardID.String(),
		Type:        event.Type,
		Payload:     payload,
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
	return truncateUTF8(builder.String(), 64*1024)
}

func appendSummary(builder *strings.Builder, value string) {
	remaining := maxSummaryBytes - builder.Len()
	if remaining <= 0 {
		return
	}
	builder.WriteString(truncateUTF8(value, remaining))
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
