package triggerdispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

const githubTriggered = `{"version":"1","trigger":{"id":"gh","type":"integration","provider":"github","operation":"issues.opened"},
  "entry":["note"],"steps":[{"id":"note","type":"create_issue","title":"GH {{ trigger.payload.issue.title }}"}]}`

const berryIntegrationTriggered = `{"version":"1","trigger":{"id":"done","type":"integration","provider":"berry","operation":"issue_completed"},
  "entry":["note"],"steps":[{"id":"note","type":"create_issue","title":"Done {{ trigger.issue.identifier }}"}]}`

// A provider delivery ingested as integration.webhook.received starts the
// workflows whose integration trigger names its provider and event, with
// the delivery as trigger.payload; a delivery for another event matches
// nothing; Berry's own provider matches integration triggers on its
// topics the way berry_event triggers do.
func TestDispatcherMatchesIntegrationTriggers(t *testing.T) {
	ctx := context.Background()
	seeded := seed(t, ctx)
	github := seeded.activeAutomation(t, ctx, githubTriggered, nil)
	berry := seeded.activeAutomation(t, ctx, berryIntegrationTriggered, nil)
	seeded.tick(t, ctx) // consume the seed facts

	// Delivery ids are unique per provider across the whole ledger, so
	// they carry the fixture's workspace to stay apart from other runs.
	deliveryID := func(suffix string) string { return seeded.workspaceID.String() + ":" + suffix }
	ingest := func(t *testing.T, suffix, event, payload string) automationrepo.Event {
		t.Helper()
		seeded.clock.Advance(1)
		fact, created, err := seeded.automations.IngestWebhook(ctx, automationrepo.IngestParams{
			Provider: "github", DeliveryID: deliveryID(suffix), WorkspaceID: seeded.workspaceID, Event: event,
			Payload: json.RawMessage(payload), ReceivedAt: seeded.clock.Now(),
		})
		if err != nil || !created {
			t.Fatalf("IngestWebhook(%s) = %v, %v", suffix, created, err)
		}
		return fact
	}
	opened := ingest(t, "d-1", "issues.opened", `{"action":"opened","issue":{"title":"Crash"}}`)
	if _, created, err := seeded.automations.IngestWebhook(ctx, automationrepo.IngestParams{
		Provider: "github", DeliveryID: deliveryID("d-1"), WorkspaceID: seeded.workspaceID, Event: "issues.opened",
		Payload: json.RawMessage(`{}`), ReceivedAt: seeded.clock.Now(),
	}); err != nil || created {
		t.Fatalf("redelivery = %v, %v", created, err)
	}
	result := seeded.tick(t, ctx)
	if result.Started != 1 {
		t.Fatalf("result = %+v, want one started run", result)
	}
	runs := seeded.runsOf(t, ctx, github.ID)
	if len(runs) != 1 || runs[0].Status != automationrepo.RunSucceeded || runs[0].TriggerType != automation.TriggerIntegration ||
		runs[0].SourceEventKey == nil || *runs[0].SourceEventKey != opened.ID.String() {
		t.Fatalf("runs = %+v", runs)
	}
	var trigger map[string]any
	_ = json.Unmarshal(runs[0].TriggerPayload, &trigger)
	payload, _ := trigger["payload"].(map[string]any)
	issue, _ := payload["issue"].(map[string]any)
	if trigger["provider"] != "github" || trigger["event"] != "issues.opened" || trigger["deliveryId"] != deliveryID("d-1") || issue["title"] != "Crash" {
		t.Fatalf("trigger payload = %v", trigger)
	}
	receipt, err := seeded.automations.GetReceipt(ctx, opened.ID)
	if err != nil || receipt.Outcome != automationrepo.ReceiptMatched || receipt.MatchedCount != 1 {
		t.Fatalf("receipt = %+v, %v", receipt, err)
	}
	if len(seeded.runsOf(t, ctx, berry.ID)) != 0 {
		t.Fatal("a github delivery started the Berry-triggered workflow")
	}

	closed := ingest(t, "d-2", "issues.closed", `{"action":"closed"}`)
	if result := seeded.tick(t, ctx); result.Started != 0 {
		t.Fatalf("other event: result = %+v", result)
	}
	if receipt, err := seeded.automations.GetReceipt(ctx, closed.ID); err != nil || receipt.Outcome != automationrepo.ReceiptUnmatched {
		t.Fatalf("other event receipt = %+v, %v", receipt, err)
	}

	done := seeded.createIssue(t, ctx, "Ship", "todo")
	seeded.move(t, ctx, done.ID, "in_progress", "in_review", "done")
	if result := seeded.tick(t, ctx); result.Started != 1 {
		t.Fatalf("berry trigger: result = %+v", result)
	}
	runs = seeded.runsOf(t, ctx, berry.ID)
	if len(runs) != 1 || runs[0].Status != automationrepo.RunSucceeded || runs[0].TriggerType != automation.TriggerIntegration {
		t.Fatalf("berry runs = %+v", runs)
	}
	if len(seeded.runsOf(t, ctx, github.ID)) != 1 {
		t.Fatal("an issue completion started the github-triggered workflow")
	}
}

const echoChild = `{"version":"1","trigger":{"id":"t","type":"manual"},"entry":["one"],
  "steps":[{"id":"one","type":"transform","output":{"echo":{"ref":"trigger.input.text"}}}]}`

const callingParent = `{"version":"1","trigger":{"id":"on_done","type":"berry_event","event":"issue.completed"},"entry":["call"],"steps":[
  {"id":"call","type":"subworkflow","workflowId":"%s","input":{"text":"hello {{ trigger.issue.identifier }}"}},
  {"id":"after","type":"create_issue","title":"Got {{ steps.call.output.steps.one.echo }}","dependsOn":["call"]}
]}`

// A subworkflow step starts the child through the starter and parks on
// it; the child's workflow.run.succeeded fact, claimed by the next tick,
// resumes the parent with the child's outputs — on the in-process path
// and through the Temporal orchestration alike.
func TestDispatcherResumesAParentOnItsSubworkflowOutcome(t *testing.T) {
	for name, newFixture := range map[string]seeder{"in-process": seed, "temporal": seedTemporal} {
		t.Run(name, func(t *testing.T) {
			subworkflowScenario(t, context.Background(), newFixture)
		})
	}
}

func subworkflowScenario(t *testing.T, ctx context.Context, newFixture seeder) {
	seeded := newFixture(t, ctx)
	child := seeded.activeAutomation(t, ctx, echoChild, nil)
	parent := seeded.activeAutomation(t, ctx, fmt.Sprintf(callingParent, child.ID), nil)
	seeded.tick(t, ctx)

	issue := seeded.createIssue(t, ctx, "Ship", "todo")
	seeded.move(t, ctx, issue.ID, "in_progress", "in_review", "done")
	if result := seeded.tick(t, ctx); result.Started != 1 {
		t.Fatalf("result = %+v, want the parent started", result)
	}
	parentRuns := seeded.runsOf(t, ctx, parent.ID)
	childRuns := seeded.runsOf(t, ctx, child.ID)
	if len(parentRuns) != 1 || len(childRuns) != 1 {
		t.Fatalf("parent runs = %+v child runs = %+v", parentRuns, childRuns)
	}
	if childRuns[0].Status != automationrepo.RunSucceeded || childRuns[0].Depth != 1 || childRuns[0].ParentRunID == nil || *childRuns[0].ParentRunID != parentRuns[0].ID ||
		childRuns[0].TriggerType != automation.TriggerManual {
		t.Fatalf("child = %+v", childRuns[0])
	}
	if parentRuns[0].Status != automationrepo.RunWaiting || parentRuns[0].WaitingOn == nil || *parentRuns[0].WaitingOn != "run:"+childRuns[0].ID.String() {
		t.Fatalf("parent before resume = %+v", parentRuns[0])
	}
	if result := seeded.tick(t, ctx); result.Resumed != 1 {
		t.Fatalf("resume tick = %+v", result)
	}
	parentRun, steps, err := seeded.automations.GetRunWithSteps(ctx, parentRuns[0].ID)
	if err != nil || parentRun.Status != automationrepo.RunSucceeded {
		t.Fatalf("parent after resume = %+v, %v", parentRun, err)
	}
	created := ""
	for _, step := range steps {
		if step.StepID == "after" && step.Status == automationrepo.StepSucceeded {
			var output map[string]any
			_ = json.Unmarshal(step.Output, &output)
			created, _ = output["title"].(string)
		}
	}
	if created != "Got hello "+issue.Identifier() {
		t.Fatalf("after step = %q steps = %+v", created, steps)
	}
	if receipt := seeded.receiptFor(t, ctx, "workflow.run.succeeded", childRuns[0].ID); receipt.Outcome != automationrepo.ReceiptMatched {
		t.Fatalf("child outcome receipt = %+v", receipt)
	}
	if _, _, err := seeded.automations.GetRunWithSteps(ctx, uuid.Nil); err == nil {
		t.Fatal("nil run id resolved")
	}
}
