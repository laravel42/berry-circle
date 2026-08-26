package plans

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/approvals"
)

// A generated plan is always goal-scoped: asking for one without a goal
// creates the draft goal in the same transaction, and a goal holds at most
// one open plan.
func TestGeneratedPlanIsGoalScopedAndOnePerGoal(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo, _ := New(pool)
	ws, board, _, user := fixture(t, pool)
	now := time.Date(2026, time.August, 25, 17, 0, 0, 0, time.UTC)

	header, events, err := repo.CreateGenerated(ctx, CreateGeneratedParams{
		ID: uuid.New(), WorkspaceID: ws, BoardID: &board, Prompt: "Launch a donation site\nwith Stripe", ActorID: user, CreatedAt: now,
	})
	if err != nil {
		t.Fatalf("CreateGenerated() error = %v", err)
	}
	if header.GoalID == nil || header.Status != StatusDraft || header.Source != SourceAI || header.GenerationStatus != GenerationRunning ||
		header.ProjectID != nil || header.CurrentVersion != 0 {
		t.Fatalf("header = %+v", header)
	}
	if len(events) != 1 || events[0].Type != "goal.created" {
		t.Fatalf("events = %+v, want the goal.created fact", events)
	}
	var title, status string
	if err := pool.QueryRow(ctx, `SELECT title, status FROM goals WHERE id = $1`, *header.GoalID).Scan(&title, &status); err != nil ||
		title != "Launch a donation site" || status != "draft" {
		t.Fatalf("goal = %q %q (err %v)", title, status, err)
	}
	if _, _, err := repo.CreateGenerated(ctx, CreateGeneratedParams{
		ID: uuid.New(), WorkspaceID: ws, GoalID: header.GoalID, Prompt: "again", ActorID: user, CreatedAt: now,
	}); !errors.Is(err, ErrPlanOpen) {
		t.Fatalf("second open plan = %v, want ErrPlanOpen", err)
	}
	if superseded, err := repo.Supersede(ctx, *header.GoalID, now.Add(time.Minute)); err != nil || superseded != 1 {
		t.Fatalf("Supersede() = %d, %v", superseded, err)
	}
	if _, _, err := repo.CreateGenerated(ctx, CreateGeneratedParams{
		ID: uuid.New(), WorkspaceID: ws, GoalID: header.GoalID, Prompt: "again", ActorID: user, CreatedAt: now.Add(time.Minute),
	}); err != nil {
		t.Fatalf("regenerate after supersede: %v", err)
	}
}

// Versions append under an optimistic check, stage records sequence per plan,
// and asking a higher role to start the plan opens exactly one plan approval.
func TestVersionsEventsAndPlanApprovalRequest(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo, _ := New(pool)
	ws, _, _, user := fixture(t, pool)
	now := time.Date(2026, time.August, 25, 17, 30, 0, 0, time.UTC)
	header, _, err := repo.CreateGenerated(ctx, CreateGeneratedParams{
		ID: uuid.New(), WorkspaceID: ws, Prompt: "Do the thing", ActorID: user, CreatedAt: now,
	})
	if err != nil {
		t.Fatalf("CreateGenerated() error = %v", err)
	}
	ir := json.RawMessage(`{"$schema":"berry-plan/1","version":"1","goal":{"tempId":"g_1","title":"Do"}}`)
	confidence := 0.8
	version, err := repo.SaveVersion(ctx, SaveVersionParams{
		PlanID: header.ID, ExpectedVersion: 0, Origin: OriginGenerated, IR: ir, ValidationStatus: ValidationValid,
		Confidence: &confidence, CreatedAt: now.Add(time.Second),
	})
	if err != nil || version.Version != 1 {
		t.Fatalf("SaveVersion() = %+v, %v", version, err)
	}
	if _, err := repo.SaveVersion(ctx, SaveVersionParams{
		PlanID: header.ID, ExpectedVersion: 0, Origin: OriginRepaired, IR: ir, CreatedAt: now.Add(2 * time.Second),
	}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale SaveVersion() = %v, want ErrVersionConflict", err)
	}
	reloaded, err := repo.GetHeader(ctx, header.ID)
	if err != nil || reloaded.CurrentVersion != 1 || reloaded.ValidationStatus != ValidationValid || reloaded.Confidence == nil || string(reloaded.IR) == "" {
		t.Fatalf("GetHeader() = %+v, %v", reloaded, err)
	}
	for _, stage := range []string{"intent", "generate"} {
		if _, err := repo.RecordEvent(ctx, RecordEventParams{PlanID: header.ID, Stage: stage, Outcome: "ok", OccurredAt: now}); err != nil {
			t.Fatalf("RecordEvent(%s) error = %v", stage, err)
		}
	}
	recorded, err := repo.ListEvents(ctx, header.ID)
	if err != nil || len(recorded) != 2 || recorded[0].Sequence != 1 || recorded[1].Sequence != 2 || recorded[1].Stage != "generate" {
		t.Fatalf("ListEvents() = %+v, %v", recorded, err)
	}
	pending, approval, event, err := repo.RequestPlanApproval(ctx, RequestPlanApprovalParams{
		PlanID: header.ID, ActorID: user, Risk: approvals.RiskHigh, RequestedFromRole: "admin", Now: now.Add(time.Minute),
	})
	if err != nil || pending.Status != StatusPendingApproval || approval.Kind != approvals.KindPlan || approval.PlanID == nil ||
		*approval.PlanID != header.ID || event.Type != "approval.requested" {
		t.Fatalf("RequestPlanApproval() = %+v, %+v, %+v, %v", pending, approval, event, err)
	}
	if _, _, _, err := repo.RequestPlanApproval(ctx, RequestPlanApprovalParams{
		PlanID: header.ID, ActorID: user, RequestedFromRole: "admin", Now: now.Add(2 * time.Minute),
	}); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("second RequestPlanApproval() = %v, want ErrNotOpen", err)
	}
	if err := repo.RejectGenerated(ctx, header.ID, "not now", now.Add(3*time.Minute)); err != nil {
		t.Fatalf("RejectGenerated() error = %v", err)
	}
	if err := repo.RejectGenerated(ctx, header.ID, "again", now.Add(4*time.Minute)); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("second RejectGenerated() = %v, want ErrNotOpen", err)
	}
}
