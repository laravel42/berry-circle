package automationrun

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

type recordingStarter struct {
	mu      sync.Mutex
	started []uuid.UUID
}

func (starter *recordingStarter) Start(_ context.Context, runID uuid.UUID) error {
	starter.mu.Lock()
	defer starter.mu.Unlock()
	starter.started = append(starter.started, runID)
	return nil
}

func (starter *recordingStarter) Resume(context.Context, uuid.UUID, ResumeSignal) error { return nil }

type settableClock struct {
	mu  sync.Mutex
	now time.Time
}

func (clock *settableClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *settableClock) Set(at time.Time) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = at
}

const scheduleDefinition = `{"version":"1","trigger":{"id":"tick","type":"schedule","config":{"cron":"0 9 * * 1","timezone":"Europe/Rome"}},
  "entry":["shape"],"steps":[{"id":"shape","type":"transform","output":{"at":{"ref":"trigger.scheduledAt"}}}]}`

// "Every Monday 09:00 Europe/Rome" fires at the right instants across the
// March DST change, exactly once per instant, with the instant as the
// idempotent source key; a late tick inside the catch-up window still
// fires the missed instant, one past the window skips it, and a paused
// schedule fires nothing.
func TestSchedulerFiresMondayNineRomeAcrossDST(t *testing.T) {
	ctx := context.Background()
	seeded := seedDB(t, ctx)
	definition, findings := automation.ParseDefinition([]byte(scheduleDefinition))
	if len(findings) > 0 {
		t.Fatalf("definition: %+v", findings)
	}
	created, _, err := seeded.automations.Create(ctx, automationrepo.CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Name: "Monday digest", Definition: definition,
		CreatedBy: seeded.userID, CreatedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	clock := &settableClock{now: time.Date(2026, time.March, 20, 12, 0, 0, 0, time.UTC)} // Friday
	schedules := InProcessSchedules{Store: seeded.automations, Clock: clock.Now}
	if err := schedules.Ensure(ctx, created.ID, ScheduleSpec{Cron: "0 9 * * 1", Timezone: "Europe/Rome"}); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if _, _, err := seeded.automations.SetStatus(ctx, created.ID, automationrepo.StatusActive, seeded.userID, clock.Now(), nil); err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}
	item, err := seeded.automations.Get(ctx, created.ID)
	if err != nil || item.ScheduleNextAt == nil || !item.ScheduleNextAt.Equal(time.Date(2026, time.March, 23, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("next fire after Ensure = %v, %v; want 2026-03-23T08:00:00Z (09:00 CET)", item.ScheduleNextAt, err)
	}
	starter := &recordingStarter{}
	workspaceID := seeded.workspaceID
	scheduler, err := NewScheduler(SchedulerOptions{Store: seeded.automations, Starter: starter, Clock: clock.Now, NewID: uuid.New, WorkspaceID: &workspaceID})
	if err != nil {
		t.Fatalf("NewScheduler() error = %v", err)
	}
	tick := func(t *testing.T, at time.Time, want int) {
		t.Helper()
		clock.Set(at)
		started, err := scheduler.Tick(ctx, 50)
		if err != nil {
			t.Fatalf("Tick(%s) error = %v", at.Format(time.RFC3339), err)
		}
		if started != want {
			t.Fatalf("Tick(%s) started %d runs, want %d", at.Format(time.RFC3339), started, want)
		}
	}
	nextAt := func(t *testing.T) time.Time {
		t.Helper()
		item, err := seeded.automations.Get(ctx, created.ID)
		if err != nil || item.ScheduleNextAt == nil {
			t.Fatalf("next fire = %v, %v", item.ScheduleNextAt, err)
		}
		return item.ScheduleNextAt.UTC()
	}

	tick(t, time.Date(2026, time.March, 23, 7, 59, 0, 0, time.UTC), 0)
	tick(t, time.Date(2026, time.March, 23, 8, 0, 0, 0, time.UTC), 1) // Monday 09:00 CET
	tick(t, time.Date(2026, time.March, 23, 8, 0, 0, 0, time.UTC), 0) // same instant: nothing new
	tick(t, time.Date(2026, time.March, 23, 8, 30, 0, 0, time.UTC), 0)
	if next := nextAt(t); !next.Equal(time.Date(2026, time.March, 30, 7, 0, 0, 0, time.UTC)) {
		t.Fatalf("next after the first fire = %s, want 2026-03-30T07:00:00Z (09:00 CEST)", next)
	}
	tick(t, time.Date(2026, time.March, 30, 7, 0, 0, 0, time.UTC), 1) // first Monday after the change: 09:00 CEST
	tick(t, time.Date(2026, time.April, 6, 7, 30, 0, 0, time.UTC), 1) // 30 minutes late: inside the catch-up window
	tick(t, time.Date(2026, time.May, 4, 12, 0, 0, 0, time.UTC), 0)   // five hours late: skipped, schedule advanced
	if next := nextAt(t); !next.Equal(time.Date(2026, time.May, 11, 7, 0, 0, 0, time.UTC)) {
		t.Fatalf("next after the skipped instant = %s, want 2026-05-11T07:00:00Z", next)
	}
	// Two schedulers racing over the same instant create one run.
	clock.Set(time.Date(2026, time.May, 11, 7, 0, 0, 0, time.UTC))
	var wait sync.WaitGroup
	results := make([]int, 2)
	for index := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index], _ = scheduler.Tick(ctx, 50)
		}(index)
	}
	wait.Wait()
	if results[0]+results[1] != 1 {
		t.Fatalf("concurrent ticks started %v runs, want one in total", results)
	}
	if err := schedules.Pause(ctx, created.ID); err != nil {
		t.Fatalf("Pause() error = %v", err)
	}
	tick(t, time.Date(2026, time.June, 1, 12, 0, 0, 0, time.UTC), 0)

	runs, err := seeded.automations.ListRuns(ctx, automationrepo.RunListFilter{WorkspaceID: seeded.workspaceID, AutomationID: &created.ID}, nil, 20)
	if err != nil {
		t.Fatalf("ListRuns() error = %v", err)
	}
	var keys []string
	for _, run := range runs {
		if run.TriggerType != automation.TriggerSchedule || run.Status != automationrepo.RunPending || run.SourceEventKey == nil {
			t.Fatalf("run = %+v", run)
		}
		var payload struct {
			ScheduledAt string `json:"scheduledAt"`
			Cron        string `json:"cron"`
			Timezone    string `json:"timezone"`
		}
		if err := json.Unmarshal(run.TriggerPayload, &payload); err != nil || payload.Cron != "0 9 * * 1" || payload.Timezone != "Europe/Rome" ||
			*run.SourceEventKey != automationrepo.ScheduleKey(created.ID, mustParseTime(t, payload.ScheduledAt)) {
			t.Fatalf("payload = %s key = %s", run.TriggerPayload, *run.SourceEventKey)
		}
		keys = append(keys, *run.SourceEventKey)
	}
	sort.Strings(keys)
	want := []string{
		automationrepo.ScheduleKey(created.ID, time.Date(2026, time.March, 23, 8, 0, 0, 0, time.UTC)),
		automationrepo.ScheduleKey(created.ID, time.Date(2026, time.March, 30, 7, 0, 0, 0, time.UTC)),
		automationrepo.ScheduleKey(created.ID, time.Date(2026, time.April, 6, 7, 0, 0, 0, time.UTC)),
		automationrepo.ScheduleKey(created.ID, time.Date(2026, time.May, 11, 7, 0, 0, 0, time.UTC)),
	}
	sort.Strings(want)
	if len(keys) != len(want) {
		t.Fatalf("runs = %v, want %v", keys, want)
	}
	for index := range want {
		if keys[index] != want[index] {
			t.Fatalf("runs = %v, want %v", keys, want)
		}
	}
	if len(starter.started) != 4 {
		t.Fatalf("started = %v", starter.started)
	}
}

func mustParseTime(t *testing.T, text string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		t.Fatalf("parse %q: %v", text, err)
	}
	return parsed
}
