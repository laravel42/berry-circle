package runadmission

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

type fakeAgentEvents struct {
	mu       sync.Mutex
	recorded []runs.AgentEventParams
}

func (store *fakeAgentEvents) RecordAgentEvent(_ context.Context, params runs.AgentEventParams) (runs.Event, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.recorded = append(store.recorded, params)
	return runs.Event{ID: params.EventID, Type: params.Topic, OccurredAt: params.OccurredAt}, nil
}

func (store *fakeAgentEvents) topics() []string {
	store.mu.Lock()
	defer store.mu.Unlock()
	var topics []string
	for _, event := range store.recorded {
		topics = append(topics, event.Topic)
	}
	return topics
}

// agent.started follows the accepted dispatch, agent.completed the stream
// ending after the terminal phase, and agent.failed a body that ends without
// it: the per-turn done never produces one.
func TestServiceRecordsAgentEventsAtRunBoundaries(t *testing.T) {
	cases := []struct {
		name   string
		events []openfang.StreamEvent
		want   string
		code   string
	}{
		{
			name: "completed after the terminal phase",
			events: []openfang.StreamEvent{
				{Type: openfang.EventChunk, Content: "one"},
				{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
				{Type: openfang.EventChunk, Content: "two"},
				{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
				{Type: openfang.EventPhase, Phase: "done"},
			},
			want: "agent.started,agent.completed",
		},
		{
			name: "incomplete without the terminal phase",
			events: []openfang.StreamEvent{
				{Type: openfang.EventChunk, Content: "one"},
				{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
				{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
			},
			want: "agent.started,agent.failed",
			code: "RUN_INCOMPLETE",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
			store := newServiceStore()
			agentEvents := &fakeAgentEvents{}
			hub, err := realtime.NewHub(8)
			if err != nil {
				t.Fatalf("NewHub() error = %v", err)
			}
			defer hub.Close()
			workerContext, cancel := context.WithCancel(context.Background())
			defer cancel()
			service, err := New(Options{
				Store: store, OpenFang: &fakeRuntime{stream: &fakeStream{events: test.events}}, Broadcaster: hub,
				Clock: func() time.Time { return now }, NewID: uuid.New, WorkerContext: workerContext, Workers: 1, QueueSize: 2,
				AgentEvents: agentEvents, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			})
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			defer closeService(t, service)
			if err := service.Queue(store.dispatch.RunID); err != nil {
				t.Fatalf("Queue() error = %v", err)
			}
			select {
			case <-store.successes:
			case <-store.failures:
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for the run to end")
			}
			closeService(t, service)
			if got := strings.Join(agentEvents.topics(), ","); got != test.want {
				t.Fatalf("agent events = %q, want %q", got, test.want)
			}
			for _, event := range agentEvents.recorded {
				if event.RunID != store.dispatch.RunID || event.EventID == uuid.Nil || event.OccurredAt.IsZero() {
					t.Fatalf("agent event = %+v", event)
				}
			}
			if test.code != "" {
				last := agentEvents.recorded[len(agentEvents.recorded)-1]
				if last.Failure == nil || last.Failure.Code != test.code {
					t.Fatalf("agent.failed carries %+v, want %s", last.Failure, test.code)
				}
			}
		})
	}
}

// The exported pool keeps the worker contract the service always had.
func TestPoolQueuesUntilClosed(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	var seen []uuid.UUID
	done := make(chan struct{}, 4)
	pool, err := NewPool(ctx, 2, 4, func(_ context.Context, id uuid.UUID) {
		mu.Lock()
		seen = append(seen, id)
		mu.Unlock()
		done <- struct{}{}
	})
	if err != nil {
		t.Fatalf("NewPool() error = %v", err)
	}
	first, second := uuid.New(), uuid.New()
	if err := pool.Queue(first); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	if err := pool.Queue(second); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	for range 2 {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for the pool")
		}
	}
	closeCtx, cancelClose := context.WithTimeout(context.Background(), time.Second)
	defer cancelClose()
	if err := pool.Close(closeCtx); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := pool.Queue(uuid.New()); err == nil {
		t.Fatal("Queue() accepted work after Close()")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 {
		t.Fatalf("seen = %v", seen)
	}
	if _, err := NewPool(ctx, 0, 0, nil); err == nil {
		t.Fatal("NewPool() accepted a nil function")
	}
}
