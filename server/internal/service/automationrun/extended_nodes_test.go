package automationrun

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

// A foreach over three items produces three body rows, walked in order,
// each with the item in scope; the step after the loop reads the
// aggregated results.
func TestRunnerFansAForeachOutIntoOneRowPerItem(t *testing.T) {
	t.Parallel()
	fake := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"each","type":"foreach","items":{"ref":"trigger.rows"},"steps":["note"],"maxItems":5}`,
		`{"id":"note","type":"create_issue","title":"Row {{ item.name }}"}`,
		`{"id":"after","type":"transform","output":{"count":{"ref":"steps.each.output.count"},"results":{"ref":"steps.each.output.results"}},"dependsOn":["each"]}`,
	), map[string]any{"rows": []any{
		map[string]any{"name": "one"}, map[string]any{"name": "two"}, map[string]any{"name": "three"},
	}})
	fake.execute()
	run := fake.run(t)
	if run.Status != automationrepo.RunSucceeded {
		t.Fatalf("run = %+v", run)
	}
	loop := fake.step(t, "each")
	if loop.Status != automationrepo.StepSucceeded || output(t, loop)["count"] != float64(3) {
		t.Fatalf("loop = %+v", loop)
	}
	rows := fake.store.stepsOf(fake.runID)
	if _, raw := rows["note"]; raw {
		t.Fatalf("the body step got an unindexed row: %+v", rows)
	}
	for index, name := range []string{"one", "two", "three"} {
		row, ok := rows[automation.IndexedStepID("note", index)]
		if !ok || row.Status != automationrepo.StepSucceeded || row.StepType != automation.StepCreateIssue {
			t.Fatalf("note[%d] = %+v (rows %v)", index, row, rows)
		}
		if title := output(t, row)["title"]; title != "Row "+name {
			t.Fatalf("note[%d] title = %v", index, title)
		}
	}
	if len(fake.issues.created) != 3 || fake.issues.created[0].Title != "Row one" || fake.issues.created[2].Title != "Row three" {
		t.Fatalf("issues = %+v", fake.issues.created)
	}
	after := output(t, fake.step(t, "after"))
	results, _ := after["results"].([]any)
	if after["count"] != float64(3) || len(results) != 3 {
		t.Fatalf("after = %+v", after)
	}
	first, _ := results[0].(map[string]any)
	if note, _ := first["note"].(map[string]any); note["title"] != "Row one" {
		t.Fatalf("results[0] = %+v", results[0])
	}
}

// A body step may wait: each iteration parks the run and resumes on its own
// fact, and the next iteration starts only after the previous one settled.
func TestRunnerWaitsInsideAForeachBody(t *testing.T) {
	t.Parallel()
	fake := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"each","type":"foreach","items":{"ref":"trigger.rows"},"steps":["gate","note"]}`,
		`{"id":"gate","type":"approval","title":"Ship {{ item }}?","approver":{"type":"role","role":"admin"}}`,
		`{"id":"note","type":"create_issue","title":"Shipped {{ item }}","dependsOn":["gate"]}`,
	), map[string]any{"rows": []any{"a", "b"}})
	fake.execute()
	for index, item := range []string{"a", "b"} {
		run := fake.run(t)
		gate := fake.step(t, automation.IndexedStepID("gate", index))
		if run.Status != automationrepo.RunWaiting || gate.Status != automationrepo.StepWaiting || run.WaitingOn == nil || *run.WaitingOn != "approval:"+gate.ApprovalID.String() {
			t.Fatalf("iteration %d: run = %+v gate = %+v", index, run, gate)
		}
		if len(fake.approvals.created) != index+1 || fake.approvals.created[index].Title != "Ship "+item+"?" {
			t.Fatalf("approvals = %+v", fake.approvals.created)
		}
		if _, early := fake.store.stepsOf(fake.runID)[automation.IndexedStepID("gate", index+1)]; early {
			t.Fatalf("iteration %d started before %d settled", index+1, index)
		}
		fake.runner.Resume(context.Background(), fake.runID, ResumeSignal{Kind: SignalApproval, ID: *gate.ApprovalID, Outcome: "approved"})
	}
	if run := fake.run(t); run.Status != automationrepo.RunSucceeded {
		t.Fatalf("run = %+v", run)
	}
	if len(fake.issues.created) != 2 || fake.issues.created[1].Title != "Shipped b" {
		t.Fatalf("issues = %+v", fake.issues.created)
	}
}

// An empty array runs the loop with no body rows; too many items fail the
// loop with a stable code; a non-array is not iterable.
func TestRunnerBoundsAForeach(t *testing.T) {
	t.Parallel()
	definition := definitionJSON(berryTrigger,
		`{"id":"each","type":"foreach","items":{"ref":"trigger.rows"},"steps":["note"],"maxItems":2}`,
		`{"id":"note","type":"create_issue","title":"Row {{ item }}"}`,
		`{"id":"after","type":"create_issue","title":"Done","dependsOn":["each"]}`,
	)
	empty := newFixture(t, definition, map[string]any{"rows": []any{}})
	empty.execute()
	if run := empty.run(t); run.Status != automationrepo.RunSucceeded || len(empty.issues.created) != 1 || empty.issues.created[0].Title != "Done" {
		t.Fatalf("empty loop: run = %+v issues = %+v", run, empty.issues.created)
	}
	if rows := empty.store.stepsOf(empty.runID); len(rows) != 2 {
		t.Fatalf("empty loop rows = %v", rows)
	}
	over := newFixture(t, definition, map[string]any{"rows": []any{1, 2, 3}})
	over.execute()
	if run := over.run(t); run.Status != automationrepo.RunFailed || run.Failure.Code != "FOREACH_LIMIT_EXCEEDED" {
		t.Fatalf("over the limit: run = %+v", run)
	}
	scalar := newFixture(t, definition, map[string]any{"rows": "not a list"})
	scalar.execute()
	if run := scalar.run(t); run.Status != automationrepo.RunFailed || run.Failure.Code != "FOREACH_NOT_ITERABLE" {
		t.Fatalf("scalar: run = %+v", run)
	}
	// A failed loop with onError skip prunes its body and continues.
	skipping := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"each","type":"foreach","items":{"ref":"trigger.rows"},"steps":["note"],"onError":"skip"}`,
		`{"id":"note","type":"create_issue","title":"Row {{ item }}"}`,
		`{"id":"after","type":"create_issue","title":"Done","dependsOn":["each"]}`,
	), map[string]any{"rows": "nope"})
	skipping.execute()
	if run := skipping.run(t); run.Status != automationrepo.RunSucceeded || skipping.step(t, "note").Status != automationrepo.StepSkipped || len(skipping.issues.created) != 1 {
		t.Fatalf("skipped loop: run = %+v note = %+v", run, skipping.step(t, "note"))
	}
}

// A switch takes the first matching case, else the default, and prunes the
// branches it did not take.
func TestRunnerSwitchesOnAValue(t *testing.T) {
	t.Parallel()
	definition := definitionJSON(berryTrigger,
		`{"id":"route","type":"switch","value":{"ref":"trigger.kind"},"cases":[{"equals":"bug","steps":["fix"]},{"equals":"bug","steps":["dup"]},{"equals":{"ref":"trigger.other"},"steps":["other"]}],"defaultSteps":["fallback"]}`,
		`{"id":"fix","type":"create_issue","title":"Fix"}`,
		`{"id":"dup","type":"create_issue","title":"Duplicate"}`,
		`{"id":"other","type":"create_issue","title":"Other"}`,
		`{"id":"fallback","type":"create_issue","title":"Fallback"}`,
	)
	cases := map[string]struct {
		trigger map[string]any
		want    string
		matched any
	}{
		"first matching case":   {map[string]any{"kind": "bug", "other": "x"}, "Fix", float64(0)},
		"case from a reference": {map[string]any{"kind": "feat", "other": "feat"}, "Other", float64(2)},
		"default":               {map[string]any{"kind": "chore", "other": "x"}, "Fallback", nil},
	}
	for name, scenario := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			fake := newFixture(t, definition, scenario.trigger)
			fake.execute()
			if run := fake.run(t); run.Status != automationrepo.RunSucceeded {
				t.Fatalf("run = %+v", run)
			}
			if len(fake.issues.created) != 1 || fake.issues.created[0].Title != scenario.want {
				t.Fatalf("issues = %+v", fake.issues.created)
			}
			route := output(t, fake.step(t, "route"))
			if route["case"] != scenario.matched {
				t.Fatalf("route = %+v", route)
			}
			rows := fake.store.stepsOf(fake.runID)
			skipped := 0
			for _, row := range rows {
				if row.Status == automationrepo.StepSkipped {
					skipped++
				}
			}
			if skipped != 3 {
				t.Fatalf("skipped %d of %v", skipped, rows)
			}
		})
	}
	// No match and no default: every branch is pruned and the run ends.
	fake := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"route","type":"switch","value":{"ref":"trigger.kind"},"cases":[{"equals":"bug","steps":["fix"]}]}`,
		`{"id":"fix","type":"create_issue","title":"Fix"}`,
	), map[string]any{"kind": "chore"})
	fake.execute()
	if run := fake.run(t); run.Status != automationrepo.RunSucceeded || len(fake.issues.created) != 0 || fake.step(t, "fix").Status != automationrepo.StepSkipped {
		t.Fatalf("no match: run = %+v issues = %+v", run, fake.issues.created)
	}
	// A switch that failed with onError skip chose nothing: its branches are pruned.
	failed := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"route","type":"switch","value":{"ref":"trigger.missing"},"cases":[{"equals":"bug","steps":["fix"]}],"onError":"skip"}`,
		`{"id":"fix","type":"create_issue","title":"Fix"}`,
		`{"id":"tail","type":"create_issue","title":"Tail","dependsOn":["route"]}`,
	), map[string]any{"kind": "bug"})
	failed.execute()
	if run := failed.run(t); run.Status != automationrepo.RunSucceeded || failed.step(t, "fix").Status != automationrepo.StepSkipped || failed.step(t, "tail").Status != automationrepo.StepSucceeded {
		t.Fatalf("failed switch: run = %+v fix = %+v tail = %+v", run, failed.step(t, "fix"), failed.step(t, "tail"))
	}
}

// A transform evaluates references and templates into its output and
// nothing else happens.
func TestRunnerTransformsValues(t *testing.T) {
	t.Parallel()
	fake := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"shape","type":"transform","output":{"label":"Donation of {{ trigger.amount }} by {{ trigger.donor.name }}","amount":{"ref":"trigger.amount"},"tags":["a",{"ref":"trigger.donor.name"}],"fixed":true}}`,
		`{"id":"note","type":"create_issue","title":"{{ steps.shape.output.label }}","dependsOn":["shape"]}`,
	), map[string]any{"amount": 120, "donor": map[string]any{"name": "Ada"}})
	fake.execute()
	if run := fake.run(t); run.Status != automationrepo.RunSucceeded {
		t.Fatalf("run = %+v", run)
	}
	shape := output(t, fake.step(t, "shape"))
	tags, _ := shape["tags"].([]any)
	if shape["label"] != "Donation of 120 by Ada" || shape["amount"] != float64(120) || shape["fixed"] != true || len(tags) != 2 || tags[1] != "Ada" {
		t.Fatalf("shape = %+v", shape)
	}
	if len(fake.issues.created) != 1 || fake.issues.created[0].Title != "Donation of 120 by Ada" {
		t.Fatalf("issues = %+v", fake.issues.created)
	}
}

type recordingSubruns struct {
	mu      sync.Mutex
	started []uuid.UUID
}

func (starter *recordingSubruns) Start(_ context.Context, runID uuid.UUID) error {
	starter.mu.Lock()
	defer starter.mu.Unlock()
	starter.started = append(starter.started, runID)
	return nil
}

const childDefinition = `{"version":"1","trigger":{"id":"t","type":"manual"},"entry":["one"],
  "steps":[{"id":"one","type":"transform","output":{"echo":{"ref":"trigger.input.text"}}}]}`

// A subworkflow step creates a child run of the named active workflow with
// the step input as its trigger input and the parent recorded, parks on
// it, and resumes with the child's step outputs when the child ends.
func TestRunnerStartsAndWaitsOnASubworkflow(t *testing.T) {
	t.Parallel()
	childID := uuid.New()
	fake := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"call","type":"subworkflow","workflowId":"`+childID.String()+`","input":{"text":"hello {{ trigger.who }}"}}`,
		`{"id":"after","type":"create_issue","title":"Got {{ steps.call.output.steps.one.echo }}","dependsOn":["call"]}`,
	), map[string]any{"who": "world"})
	child := automationrepo.Automation{ID: childID, WorkspaceID: fake.store.automation.WorkspaceID, Status: automationrepo.StatusActive, Version: 1, Name: "Child"}
	fake.store.addAutomation(child, json.RawMessage(childDefinition))
	starter := &recordingSubruns{}
	fake.runner.SetSubrunStarter(starter)

	fake.execute()
	run := fake.run(t)
	if len(fake.store.created) != 1 || len(starter.started) != 1 {
		t.Fatalf("child runs = %+v started = %v", fake.store.created, starter.started)
	}
	created := fake.store.created[0]
	childRunID := created.ID
	if created.AutomationID != childID || created.TriggerType != automation.TriggerManual || created.Depth != 1 ||
		created.ParentRunID == nil || *created.ParentRunID != fake.runID || created.ParentStepRunID == nil || *created.SourceEventKey != "subworkflow:"+created.ParentStepRunID.String() {
		t.Fatalf("child run params = %+v", created)
	}
	var payload struct {
		Input  map[string]any `json:"input"`
		Parent map[string]any `json:"parent"`
	}
	if err := json.Unmarshal(created.Payload, &payload); err != nil || payload.Input["text"] != "hello world" || payload.Parent["runId"] != fake.runID.String() || payload.Parent["stepId"] != "call" {
		t.Fatalf("child payload = %s (%v)", created.Payload, err)
	}
	if run.Status != automationrepo.RunWaiting || run.WaitingOn == nil || *run.WaitingOn != "run:"+childRunID.String() {
		t.Fatalf("parent = %+v", run)
	}
	// Re-executing the parent finds the child it already created.
	fake.runner.Execute(context.Background(), fake.runID)
	if len(fake.store.created) != 1 {
		t.Fatalf("a second child was created: %+v", fake.store.created)
	}

	// The child runs on the same runner and finishes; the dispatcher then
	// resumes the parent with the child's outcome.
	fake.runner.Execute(context.Background(), childRunID)
	childRun, err := fake.store.GetRun(context.Background(), childRunID)
	if err != nil || childRun.Status != automationrepo.RunSucceeded {
		t.Fatalf("child = %+v, %v", childRun, err)
	}
	for _, signal := range WaitKeys("workflow.run.succeeded", childRunID, nil, fake.now) {
		if signal.Kind == SignalRun {
			fake.runner.Resume(context.Background(), fake.runID, signal)
		}
	}
	run = fake.run(t)
	if run.Status != automationrepo.RunSucceeded {
		t.Fatalf("parent after child = %+v", run)
	}
	call := output(t, fake.step(t, "call"))
	if call["childRunId"] != childRunID.String() || call["status"] != "succeeded" {
		t.Fatalf("call = %+v", call)
	}
	if len(fake.issues.created) != 1 || fake.issues.created[0].Title != "Got hello world" {
		t.Fatalf("issues = %+v", fake.issues.created)
	}
}

// A failed child fails the step with the child's code; the remaining
// refusals are decided before any run is created.
func TestRunnerRefusesBadSubworkflowCalls(t *testing.T) {
	t.Parallel()
	childID := uuid.New()
	build := func(t *testing.T, workflowID string, childStatus automationrepo.Status, withStarter bool, depth int) *fixture {
		t.Helper()
		fake := newFixture(t, definitionJSON(berryTrigger,
			`{"id":"call","type":"subworkflow","workflowId":"`+workflowID+`"}`,
		), map[string]any{})
		fake.store.addAutomation(automationrepo.Automation{ID: childID, WorkspaceID: fake.store.automation.WorkspaceID, Status: childStatus, Version: 1}, json.RawMessage(childDefinition))
		if withStarter {
			fake.runner.SetSubrunStarter(&recordingSubruns{})
		}
		fake.store.runs[fake.runID].Depth = depth
		if depth > 0 {
			parent := uuid.New()
			fake.store.runs[fake.runID].ParentRunID = &parent
		}
		return fake
	}
	fake := build(t, childID.String(), automationrepo.StatusActive, true, 0)
	fake.execute()
	childRunID := fake.store.created[0].ID
	failure := automationrepo.Failure{Code: "STEP_FAILED", Message: "boom"}
	if _, _, err := fake.store.Fail(context.Background(), childRunID, failure, fake.now, uuid.New); err != nil {
		t.Fatal(err)
	}
	fake.runner.Resume(context.Background(), fake.runID, ResumeSignal{Kind: SignalRun, ID: childRunID, Outcome: "failed"})
	if run := fake.run(t); run.Status != automationrepo.RunFailed || run.Failure.Code != "SUBWORKFLOW_FAILED" || run.Failure.Message != "The subworkflow run failed (STEP_FAILED)." {
		t.Fatalf("failed child: run = %+v", run)
	}
	for name, scenario := range map[string]struct {
		fake *fixture
		code string
	}{
		"inactive child": {build(t, childID.String(), automationrepo.StatusPaused, true, 0), "SUBWORKFLOW_NOT_ACTIVE"},
		"unknown child":  {build(t, uuid.NewString(), automationrepo.StatusActive, true, 0), "SUBWORKFLOW_NOT_FOUND"},
		"no starter":     {build(t, childID.String(), automationrepo.StatusActive, false, 0), "EXECUTOR_UNAVAILABLE"},
		"depth exceeded": {build(t, childID.String(), automationrepo.StatusActive, true, automation.MaxSubworkflowDepth), "SUBWORKFLOW_DEPTH_EXCEEDED"},
		"calling itself": {nil, "SUBWORKFLOW_CYCLE"},
	} {
		if scenario.fake == nil {
			self := newFixture(t, "", map[string]any{})
			self.setDefinition(t, definitionJSON(berryTrigger, `{"id":"call","type":"subworkflow","workflowId":"`+self.store.automation.ID.String()+`"}`))
			self.runner.SetSubrunStarter(&recordingSubruns{})
			scenario.fake = self
		}
		scenario.fake.execute()
		run := scenario.fake.run(t)
		if run.Status != automationrepo.RunFailed || run.Failure == nil || run.Failure.Code != scenario.code {
			t.Fatalf("%s: run = %+v", name, run)
		}
		if len(scenario.fake.store.created) != 0 {
			t.Fatalf("%s: a child run was created: %+v", name, scenario.fake.store.created)
		}
	}
}
