package approvals

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/realtime"
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
)

type fakeExpiryStore struct {
	calls  []time.Time
	limits []int
	err    error
	events []approvalrepo.Event
}

func (store *fakeExpiryStore) ExpireDue(_ context.Context, now time.Time, limit int, _ func() uuid.UUID) ([]approvalrepo.Approval, []approvalrepo.Event, error) {
	store.calls = append(store.calls, now)
	store.limits = append(store.limits, limit)
	if store.err != nil {
		return nil, nil, store.err
	}
	expired := make([]approvalrepo.Approval, len(store.events))
	return expired, store.events, nil
}

func TestSweeperExpiresAndPublishes(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	workspaceID := uuid.New()
	hub, err := realtime.NewHub(8)
	if err != nil {
		t.Fatalf("NewHub() error = %v", err)
	}
	defer hub.Close()
	subscription, err := hub.Subscribe(context.Background(), workspaceID.String())
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer subscription.Close()
	store := &fakeExpiryStore{events: []approvalrepo.Event{{ID: uuid.New(), Type: "approval.expired", WorkspaceID: workspaceID, OccurredAt: now}}}
	sweeper, err := NewSweeper(SweeperOptions{Store: store, Clock: func() time.Time { return now }, NewID: uuid.New, Broadcaster: hub, Limit: 50})
	if err != nil {
		t.Fatalf("NewSweeper() error = %v", err)
	}
	count, err := sweeper.RunOnce(context.Background())
	if err != nil || count != 1 {
		t.Fatalf("RunOnce() = %d, %v", count, err)
	}
	if len(store.calls) != 1 || !store.calls[0].Equal(now) || store.limits[0] != 50 {
		t.Fatalf("store calls = %v limits = %v", store.calls, store.limits)
	}
	select {
	case event := <-subscription.Events():
		if event.Type != "approval.expired" || event.WorkspaceID != workspaceID.String() {
			t.Fatalf("event = %+v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("approval.expired was not published")
	}
}

func TestSweeperSurfacesStoreErrors(t *testing.T) {
	t.Parallel()
	store := &fakeExpiryStore{err: errors.New("database away")}
	sweeper, err := NewSweeper(SweeperOptions{Store: store, Clock: time.Now, NewID: uuid.New})
	if err != nil {
		t.Fatalf("NewSweeper() error = %v", err)
	}
	if _, err := sweeper.RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce() swallowed the store error")
	}
	if _, err := NewSweeper(SweeperOptions{Clock: time.Now, NewID: uuid.New}); err == nil {
		t.Fatal("NewSweeper() accepted a nil store")
	}
}
