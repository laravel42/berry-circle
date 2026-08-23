package runadmission

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

func TestServiceProjectsSuccessfulStream(t *testing.T) {
	previousPropagator := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	defer otel.SetTextMapPropagator(previousPropagator)
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	store.dispatch.TraceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: "finished work"},
			{Type: openfang.EventToolUse, Tool: "tests"},
			{Type: openfang.EventToolResult, Tool: "tests"},
			{
				Type: openfang.EventDone,
				Usage: openfang.Usage{
					InputTokens:  12,
					OutputTokens: 5,
				},
			},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case success := <-store.successes:
		if success.Usage.InputTokens != 12 ||
			success.Usage.OutputTokens != 5 ||
			success.Usage.TotalTokens != 17 {
			t.Fatalf("usage = %#v", success.Usage)
		}
		if success.Summary == nil || *success.Summary != "finished work" {
			t.Fatalf("summary = %#v", success.Summary)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
	if runtime.dispatches.Load() != 1 {
		t.Fatalf("dispatches = %d, want 1", runtime.dispatches.Load())
	}
	if got := runtime.dispatchTrace(); !got.IsValid() ||
		got.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Fatalf("dispatch trace = %s", got.TraceID())
	}
	if store.outputCount.Load() != 1 ||
		store.toolStarted.Load() != 1 ||
		store.toolCompleted.Load() != 1 {
		t.Fatalf(
			"projection counts output=%d started=%d completed=%d",
			store.outputCount.Load(),
			store.toolStarted.Load(),
			store.toolCompleted.Load(),
		)
	}
}

func TestServiceMapsEOFBeforeDoneToInterruptedWithoutRedispatch(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	runtime := &fakeRuntime{
		stream: &fakeStream{
			events: []openfang.StreamEvent{{
				Type:    openfang.EventChunk,
				Content: "partial",
			}},
			finalErr: &openfang.StreamError{Kind: openfang.StreamInterrupted},
		},
	}
	service, cancel, hub := newTestService(t, store, runtime, now)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case failure := <-store.failures:
		if failure.Failure.Code != "STREAM_INTERRUPTED" || !failure.Reconcile {
			t.Fatalf("failure = %#v", failure)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for interrupted failure")
	}
	if runtime.dispatches.Load() != 1 {
		t.Fatalf("dispatches = %d, want 1", runtime.dispatches.Load())
	}
}

func TestServiceCancellationCallsStopOnce(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	store.cancelClaim = runs.CancellationClaim{
		Run: runs.Run{
			ID:              store.dispatch.RunID,
			BoardID:         store.dispatch.BoardID,
			IssueID:         store.dispatch.IssueID,
			Status:          runs.StatusRunning,
			DispatchState:   runs.DispatchStreaming,
			UpstreamAgentID: store.dispatch.UpstreamAgentID,
		},
		UpstreamAgentID: store.dispatch.UpstreamAgentID,
		ShouldStop:      true,
	}
	runtime := &fakeRuntime{
		stopResponse: openfang.StopResponse{
			Status:    "ok",
			Message:   "Run cancelled",
			RequestID: "upstream-stop",
		},
	}
	service, cancel, hub := newTestService(t, store, runtime, now)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	userID := uuid.New()
	first, err := service.Cancel(context.Background(), store.dispatch.RunID, userID)
	if err != nil {
		t.Fatalf("first Cancel() error = %v", err)
	}
	if first.Status != runs.StatusCancelled {
		t.Fatalf("first status = %s", first.Status)
	}
	second, err := service.Cancel(context.Background(), store.dispatch.RunID, userID)
	if err != nil {
		t.Fatalf("second Cancel() error = %v", err)
	}
	if second.Status != runs.StatusCancelled {
		t.Fatalf("second status = %s", second.Status)
	}
	if runtime.stops.Load() != 1 {
		t.Fatalf("stop calls = %d, want 1", runtime.stops.Load())
	}
}

func newTestService(
	t *testing.T,
	store *serviceStore,
	runtime *fakeRuntime,
	now time.Time,
) (*Service, context.CancelFunc, *realtime.Hub) {
	t.Helper()
	hub, err := realtime.NewHub(8)
	if err != nil {
		t.Fatalf("NewHub() error = %v", err)
	}
	workerContext, cancel := context.WithCancel(context.Background())
	service, err := New(Options{
		Store:         store,
		OpenFang:      runtime,
		Broadcaster:   hub,
		Clock:         func() time.Time { return now },
		NewID:         uuid.New,
		WorkerContext: workerContext,
		Workers:       1,
		QueueSize:     4,
	})
	if err != nil {
		cancel()
		_ = hub.Close()
		t.Fatalf("New() error = %v", err)
	}
	return service, cancel, hub
}

func closeService(t *testing.T, service *Service) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := service.Close(ctx); err != nil {
		t.Errorf("Close() error = %v", err)
	}
}

type fakeRuntime struct {
	stream       openfang.EventStream
	dispatchErr  error
	stopResponse openfang.StopResponse
	stopErr      error
	dispatches   atomic.Int32
	stops        atomic.Int32
	traceMu      sync.Mutex
	traceContext trace.SpanContext
}

func (runtime *fakeRuntime) ListAgents(context.Context) ([]openfang.AgentSummary, error) {
	return nil, nil
}

func (runtime *fakeRuntime) GetAgent(
	context.Context,
	uuid.UUID,
) (openfang.AgentDetail, error) {
	return openfang.AgentDetail{}, nil
}

func (runtime *fakeRuntime) DispatchMessage(
	ctx context.Context,
	_ uuid.UUID,
	_ openfang.MessageRequest,
) (openfang.EventStream, error) {
	runtime.dispatches.Add(1)
	runtime.traceMu.Lock()
	runtime.traceContext = trace.SpanContextFromContext(ctx)
	runtime.traceMu.Unlock()
	return runtime.stream, runtime.dispatchErr
}

func (runtime *fakeRuntime) dispatchTrace() trace.SpanContext {
	runtime.traceMu.Lock()
	defer runtime.traceMu.Unlock()
	return runtime.traceContext
}

func (runtime *fakeRuntime) StopAgent(
	context.Context,
	uuid.UUID,
) (openfang.StopResponse, error) {
	runtime.stops.Add(1)
	return runtime.stopResponse, runtime.stopErr
}

type fakeStream struct {
	mu       sync.Mutex
	events   []openfang.StreamEvent
	index    int
	finalErr error
}

func (stream *fakeStream) Next() (openfang.StreamEvent, error) {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.index < len(stream.events) {
		event := stream.events[stream.index]
		stream.index++
		return event, nil
	}
	if stream.finalErr != nil {
		return openfang.StreamEvent{}, stream.finalErr
	}
	return openfang.StreamEvent{}, io.EOF
}

func (*fakeStream) RequestID() string { return "upstream-dispatch" }
func (*fakeStream) Close() error      { return nil }

type serviceStore struct {
	dispatch      runs.Dispatch
	failures      chan runs.FailParams
	successes     chan runs.SuccessParams
	cancelClaim   runs.CancellationClaim
	cancelled     bool
	mu            sync.Mutex
	outputCount   atomic.Int32
	toolStarted   atomic.Int32
	toolCompleted atomic.Int32
}

func newServiceStore() *serviceStore {
	return &serviceStore{
		dispatch: runs.Dispatch{
			RunID:           uuid.New(),
			IssueID:         uuid.New(),
			BoardID:         uuid.New(),
			AgentID:         uuid.New(),
			UpstreamAgentID: uuid.New(),
			IssueIdentifier: "BERRY-1",
			IssueTitle:      "Finish work",
			RequestID:       "req_dispatch_test",
		},
		failures:  make(chan runs.FailParams, 4),
		successes: make(chan runs.SuccessParams, 4),
	}
}

func (*serviceStore) Admit(
	context.Context,
	runs.AdmitParams,
) (runs.Run, error) {
	return runs.Run{}, errors.New("unexpected Admit call")
}

func (*serviceStore) Get(context.Context, uuid.UUID) (runs.Run, error) {
	return runs.Run{}, errors.New("unexpected Get call")
}

func (store *serviceStore) ClaimDispatch(
	context.Context,
	uuid.UUID,
	time.Time,
) (runs.Dispatch, error) {
	return store.dispatch, nil
}

func (store *serviceStore) MarkRunning(
	_ context.Context,
	runID, eventID uuid.UUID,
	_ string,
	now time.Time,
) (runs.Run, runs.Event, error) {
	return store.runningRun(runID, now), store.event(eventID, runID, "run.started", 1, now), nil
}

func (store *serviceStore) AppendOutput(
	_ context.Context,
	runID, eventID uuid.UUID,
	_, _ string,
	now time.Time,
) (runs.Event, error) {
	store.outputCount.Add(1)
	return store.event(eventID, runID, "run.output.delta", 2, now), nil
}

func (store *serviceStore) AppendToolStarted(
	_ context.Context,
	runID, eventID uuid.UUID,
	_, _ string,
	now time.Time,
) (runs.Event, error) {
	store.toolStarted.Add(1)
	return store.event(eventID, runID, "run.tool.started", 3, now), nil
}

func (store *serviceStore) AppendToolCompleted(
	_ context.Context,
	runID, eventID uuid.UUID,
	_ string,
	_ bool,
	now time.Time,
) (runs.Event, error) {
	store.toolCompleted.Add(1)
	return store.event(eventID, runID, "run.tool.completed", 4, now), nil
}

func (*serviceStore) RecordProviderEvent(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	string,
	map[string]string,
	time.Time,
) error {
	return nil
}

func (store *serviceStore) CompleteSuccess(
	_ context.Context,
	params runs.SuccessParams,
) (runs.Run, []runs.Event, error) {
	store.successes <- params
	run := store.runningRun(params.RunID, params.CompletedAt)
	run.Status = runs.StatusSucceeded
	return run, []runs.Event{
		store.event(params.UsageEventID, params.RunID, "run.usage.updated", 5, params.CompletedAt),
		store.event(params.CompletedEventID, params.RunID, "run.completed", 6, params.CompletedAt),
	}, nil
}

func (store *serviceStore) Fail(
	_ context.Context,
	params runs.FailParams,
) (runs.Run, runs.Event, error) {
	store.failures <- params
	run := store.runningRun(params.RunID, params.FailedAt)
	run.Status = runs.StatusFailed
	return run, store.event(params.EventID, params.RunID, "run.failed", 5, params.FailedAt), nil
}

func (store *serviceStore) RequestCancellation(
	context.Context,
	runs.CancelParams,
) (runs.CancellationClaim, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.cancelled {
		run := store.cancelClaim.Run
		run.Status = runs.StatusCancelled
		run.DispatchState = runs.DispatchCancelled
		return runs.CancellationClaim{Run: run}, nil
	}
	return store.cancelClaim, nil
}

func (store *serviceStore) MarkCancelled(
	_ context.Context,
	runID, eventID uuid.UUID,
	_ string,
	now time.Time,
) (runs.Run, runs.Event, error) {
	store.mu.Lock()
	store.cancelled = true
	store.mu.Unlock()
	run := store.cancelClaim.Run
	run.ID = runID
	run.Status = runs.StatusCancelled
	run.DispatchState = runs.DispatchCancelled
	return run, store.event(eventID, runID, "run.cancelled", 5, now), nil
}

func (*serviceStore) MarkCancellationUnconfirmed(
	context.Context,
	uuid.UUID,
	time.Time,
) error {
	return nil
}

func (store *serviceStore) runningRun(runID uuid.UUID, now time.Time) runs.Run {
	return runs.Run{
		ID:              runID,
		IssueID:         store.dispatch.IssueID,
		BoardID:         store.dispatch.BoardID,
		AgentID:         store.dispatch.AgentID,
		UpstreamAgentID: store.dispatch.UpstreamAgentID,
		Status:          runs.StatusRunning,
		DispatchState:   runs.DispatchStreaming,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
}

func (store *serviceStore) event(
	eventID, runID uuid.UUID,
	eventType string,
	sequence int64,
	now time.Time,
) runs.Event {
	run := runID
	seq := sequence
	return runs.Event{
		ID:         eventID,
		Type:       eventType,
		OccurredAt: now,
		BoardID:    store.dispatch.BoardID,
		IssueID:    store.dispatch.IssueID,
		RunID:      &run,
		Sequence:   &seq,
		Payload:    []byte(`{}`),
	}
}
