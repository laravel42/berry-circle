package planner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/identity"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/modelgateway"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	"github.com/laravel42/berry-circle/server/internal/planner/validate"
	"github.com/laravel42/berry-circle/server/internal/repository/plans"
)

// Every recorded fixture replays through the real gateway, parser,
// validator, repair loop and critic against the fake chat route, and the
// final plan carries the properties the fixture asserts (validator-only
// expectations: nothing about the model's wording).
func TestFixturesReplayThroughThePipeline(t *testing.T) {
	for _, name := range fixtureNames(t) {
		t.Run(name, func(t *testing.T) {
			loaded := loadFixture(t, name)
			chat := newChatServer(t, replies(loaded))
			h := newHarness(t, loaded, chat)
			header := h.generate(t, loaded)
			final := h.wait(t, header.ID)
			_, versions, events, outbox := h.store.snapshot(header.ID)
			want := loaded.Expected

			if final.GenerationStatus != want.GenerationStatus {
				t.Fatalf("generation = %s (%v), want %s; stages %v", final.GenerationStatus, deref(final.GenerationError), want.GenerationStatus, stages(events))
			}
			if want.GenerationError != "" && (final.GenerationError == nil || !strings.Contains(*final.GenerationError, want.GenerationError)) {
				t.Fatalf("generation error = %v, want %s", deref(final.GenerationError), want.GenerationError)
			}
			if final.ValidationStatus != want.ValidationStatus {
				t.Fatalf("validation = %s, want %s", final.ValidationStatus, want.ValidationStatus)
			}
			if want.Versions != nil && len(versions) != *want.Versions {
				t.Fatalf("versions = %d, want %d", len(versions), *want.Versions)
			}
			if len(final.IR) == 0 {
				if want.IssueCount != nil || want.WorkflowCount != nil {
					t.Fatal("no IR stored")
				}
				return
			}
			plan, err := ir.Parse(final.IR)
			if err != nil {
				t.Fatalf("stored IR: %v", err)
			}
			if want.IssueCount != nil && (len(plan.Issues) < want.IssueCount.Min || len(plan.Issues) > want.IssueCount.Max) {
				t.Fatalf("issues = %d, want %d..%d", len(plan.Issues), want.IssueCount.Min, want.IssueCount.Max)
			}
			if want.WorkflowCount != nil && len(plan.Workflows) != *want.WorkflowCount {
				t.Fatalf("workflows = %d, want %d", len(plan.Workflows), *want.WorkflowCount)
			}
			if want.ApprovalCount != nil && len(plan.Approvals) != *want.ApprovalCount {
				t.Fatalf("approvals = %d, want %d", len(plan.Approvals), *want.ApprovalCount)
			}
			var stored struct {
				Errors              []ir.Finding                  `json:"errors"`
				Warnings            []ir.Finding                  `json:"warnings"`
				RequiredConnections []validate.RequiredConnection `json:"requiredConnections"`
			}
			if err := json.Unmarshal(versions[len(versions)-1].Validation, &stored); err != nil {
				t.Fatalf("stored validation: %v", err)
			}
			if want.ValidationErrors != nil {
				if got := ir.Codes(stored.Errors); len(got) != len(want.ValidationErrors) || hasAll(got, want.ValidationErrors) != nil {
					t.Fatalf("validation errors = %v, want %v", got, want.ValidationErrors)
				}
			}
			if want.ValidationWarnings != nil {
				if got := ir.Codes(stored.Warnings); len(got) != len(want.ValidationWarnings) || hasAll(got, want.ValidationWarnings) != nil {
					t.Fatalf("validation warnings = %v, want %v", got, want.ValidationWarnings)
				}
			}
			if want.RequiredConnections != nil {
				var providers []string
				for _, connection := range stored.RequiredConnections {
					providers = append(providers, connection.Provider)
					if connection.Connected != containsString(loaded.Context.Connections, connection.Provider) {
						t.Fatalf("connection %s connected = %v, fixture connections %v", connection.Provider, connection.Connected, loaded.Context.Connections)
					}
				}
				for index, connection := range plan.RequiredConnections {
					if connection.Connected != stored.RequiredConnections[index].Connected {
						t.Fatalf("IR connected flag not filled for %s", connection.Provider)
					}
				}
				if len(providers) != len(want.RequiredConnections) || hasAll(providers, want.RequiredConnections) != nil {
					t.Fatalf("required connections = %v, want %v", providers, want.RequiredConnections)
				}
			}
			if want.Blocking != nil && (*want.Blocking != (final.ValidationStatus == plans.ValidationBlocked)) {
				t.Fatalf("blocking = %v", final.ValidationStatus)
			}
			for tempID, kind := range want.Classification {
				found := ""
				for _, issue := range plan.Issues {
					if issue.TempID == tempID {
						found = "issue"
					}
				}
				for _, workflow := range plan.Workflows {
					if workflow.TempID == tempID {
						found = "workflow"
					}
				}
				if found != kind {
					t.Fatalf("%s classified as %q, want %s", tempID, found, kind)
				}
			}
			for _, protect := range want.ApprovalsProtect {
				protected := false
				for _, issue := range plan.Issues {
					if !strings.Contains(strings.ToLower(issue.Title), protect) {
						continue
					}
					if issue.RequiresApproval {
						protected = true
					}
					for _, approval := range plan.Approvals {
						if approval.Target.Kind == "issue" && approval.Target.TempID == issue.TempID {
							protected = true
						}
					}
				}
				if !protected {
					t.Fatalf("no approval protects %q", protect)
				}
			}
			if want.ReusesExisting != nil {
				reuses := false
				for _, assumption := range plan.Assumptions {
					for _, existing := range loaded.Context.ExistingIssues {
						if strings.Contains(assumption.Description, existing.Identifier) {
							reuses = true
						}
					}
				}
				if reuses != *want.ReusesExisting {
					t.Fatalf("reusesExisting = %v", reuses)
				}
			}
			if want.RepairedWithin != nil {
				repairs := 0
				for _, event := range events {
					if event.Stage == plans.StageRepair {
						repairs++
					}
				}
				if repairs > *want.RepairedWithin {
					t.Fatalf("repairs = %d, want at most %d; stages %v", repairs, *want.RepairedWithin, stages(events))
				}
				if chat.count(modelgateway.RoleRepair) != repairs {
					t.Fatalf("repair calls = %d, events %d", chat.count(modelgateway.RoleRepair), repairs)
				}
			}
			agents := map[uuid.UUID][]string{}
			for _, agent := range loaded.Context.Agents {
				agents[agent.ID] = agent.Skills
			}
			for tempID, skill := range want.AgentsBySkill {
				var suggested *uuid.UUID
				for _, issue := range plan.Issues {
					if issue.TempID == tempID {
						suggested = issue.SuggestedAgentID
					}
				}
				if suggested == nil || !containsString(agents[*suggested], skill) {
					t.Fatalf("%s is not assigned to an agent with skill %s", tempID, skill)
				}
			}
			if want.ConfidenceMax != nil && (final.Confidence == nil || *final.Confidence > *want.ConfidenceMax+1e-9) {
				t.Fatalf("confidence = %v, want at most %v", final.Confidence, *want.ConfidenceMax)
			}
			// Privacy: no stage record carries the prompt or a reply.
			for _, event := range events {
				detail := string(event.Detail)
				if strings.Contains(detail, loaded.UserPrompt) || strings.Contains(detail, "berry-plan/1") || strings.Contains(detail, "\"goal\":\"") {
					t.Fatalf("planner event %s leaks content: %s", event.Stage, detail)
				}
				if event.Role != nil && (event.InputTokens == nil || event.PromptVersion == nil || event.ModelName == nil) {
					t.Fatalf("role event %s lacks usage: %+v", event.Stage, event)
				}
			}
			if err := hasAll(topics(outbox), []string{TopicPlanUpdated}); err != nil {
				t.Fatalf("outbox %v: %v", topics(outbox), err)
			}
			if want.GenerationStatus == plans.GenerationSucceeded && final.ValidationStatus == plans.ValidationValid {
				if err := hasAll(topics(outbox), []string{TopicPlanGenerated}); err != nil {
					t.Fatalf("outbox %v: %v", topics(outbox), err)
				}
				if final.PlannerVersion == nil || *final.PlannerVersion != "planner-v1" {
					t.Fatalf("planner version = %v", final.PlannerVersion)
				}
			}
		})
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// An unparsable planner reply is a repair round: the repair role receives
// the schema errors and the parsed repair lands as version 1.
func TestInvalidJSONIsRepairedIntoAValidPlan(t *testing.T) {
	loaded := loadFixture(t, "simple-issue")
	scripted := replies(loaded)
	valid := scripted[modelgateway.RolePlanner][0]
	scripted[modelgateway.RolePlanner] = []string{"I would plan two issues but here is prose instead of JSON."}
	scripted[modelgateway.RoleRepair] = []string{valid}
	chat := newChatServer(t, scripted)
	h := newHarness(t, loaded, chat)
	header := h.generate(t, loaded)
	final := h.wait(t, header.ID)
	_, versions, events, _ := h.store.snapshot(header.ID)
	if final.GenerationStatus != plans.GenerationSucceeded || final.ValidationStatus != plans.ValidationValid {
		t.Fatalf("final = %s/%s %v; stages %v", final.GenerationStatus, final.ValidationStatus, deref(final.GenerationError), stages(events))
	}
	if len(versions) != 1 || versions[0].Origin != plans.OriginRepaired {
		t.Fatalf("versions = %+v", versions)
	}
	want := []string{"intent:ok", "context:ok", "generate:invalid", "validate:invalid", "repair:ok", "validate:ok", "critic:ok"}
	if got := stages(events); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("stages = %v, want %v", got, want)
	}
	repairTask := chat.request(modelgateway.RoleRepair, 0)
	if !strings.Contains(repairTask, ir.CodePlanJSONInvalid) || !strings.Contains(repairTask, "no schema-conforming plan") {
		t.Fatalf("repair task lacks the parse error: %s", repairTask)
	}
	if final.Confidence == nil || *final.Confidence > 0.7+1e-9 {
		t.Fatalf("confidence = %v, want 0.8 minus one repair", final.Confidence)
	}
}

// Repairs are bounded: after PLANNER_MAX_REPAIRS rounds the plan is kept
// for editing, validation reads invalid and generation failed PLAN_INVALID.
func TestExhaustedRepairsFailWithPlanInvalid(t *testing.T) {
	loaded := loadFixture(t, "repair-unknown-tool")
	scripted := replies(loaded)
	broken := scripted[modelgateway.RolePlanner][0]
	scripted[modelgateway.RoleRepair] = []string{broken, broken, broken, broken}
	chat := newChatServer(t, scripted)
	h := newHarness(t, loaded, chat, func(options *Options) { options.MaxRepairs = 2 })
	header := h.generate(t, loaded)
	final := h.wait(t, header.ID)
	_, versions, events, outbox := h.store.snapshot(header.ID)
	if final.GenerationStatus != plans.GenerationFailed || final.GenerationError == nil || *final.GenerationError != ErrorPlanInvalid {
		t.Fatalf("final = %s %v", final.GenerationStatus, deref(final.GenerationError))
	}
	if final.ValidationStatus != plans.ValidationInvalid || len(final.IR) == 0 {
		t.Fatalf("validation = %s ir %d bytes", final.ValidationStatus, len(final.IR))
	}
	if chat.count(modelgateway.RoleRepair) != 2 || chat.count(modelgateway.RoleCritic) != 0 {
		t.Fatalf("repair calls = %d critic calls = %d", chat.count(modelgateway.RoleRepair), chat.count(modelgateway.RoleCritic))
	}
	if len(versions) != 3 {
		t.Fatalf("versions = %d, want the generated plan and two repairs", len(versions))
	}
	last := outbox[len(outbox)-1]
	if last.Type != TopicPlanUpdated || !strings.Contains(string(last.Payload), `"error":"PLAN_INVALID"`) || !strings.Contains(string(last.Payload), "TOOL_UNKNOWN") {
		t.Fatalf("last fact = %s %s", last.Type, last.Payload)
	}
	for _, event := range events {
		if event.Stage == plans.StageRepair && !strings.Contains(string(event.Detail), `"remainingCodes":["TOOL_UNKNOWN"`) {
			t.Fatalf("repair detail = %s", event.Detail)
		}
	}
}

// The critic runs at most PLANNER_MAX_CRITIC_ROUNDS times; a revise verdict
// goes through the repair role once and the revision is stored only when it
// validates.
func TestCriticRoundIsBoundedAndNeverBreaksAValidPlan(t *testing.T) {
	loaded := loadFixture(t, "simple-issue")
	valid := loaded.ModelReplies.Planner[0]
	revised := strings.Replace(valid, `"title":"Fix the login failure on Safari"`, `"title":"Fix the Safari login failure"`, 1)
	broken := strings.Replace(valid, `"dependsOn":["i_reproduce"]`, `"dependsOn":["i_missing"]`, 1)
	revise := `{"verdict":"revise","problems":[{"code":"TITLE_VAGUE","path":"/goal/title","message":"Name the browser first.","severity":"error"}]}`

	t.Run("one round applies one revision", func(t *testing.T) {
		scripted := replies(loaded)
		scripted[modelgateway.RoleCritic] = []string{revise, revise, revise}
		scripted[modelgateway.RoleRepair] = []string{revised, revised}
		chat := newChatServer(t, scripted)
		h := newHarness(t, loaded, chat)
		header := h.generate(t, loaded)
		final := h.wait(t, header.ID)
		_, versions, _, _ := h.store.snapshot(header.ID)
		if final.GenerationStatus != plans.GenerationSucceeded || final.ValidationStatus != plans.ValidationValid {
			t.Fatalf("final = %s/%s %v", final.GenerationStatus, final.ValidationStatus, deref(final.GenerationError))
		}
		if chat.count(modelgateway.RoleCritic) != 1 || chat.count(modelgateway.RoleRepair) != 1 {
			t.Fatalf("critic calls = %d repair calls = %d, want 1 and 1", chat.count(modelgateway.RoleCritic), chat.count(modelgateway.RoleRepair))
		}
		if len(versions) != 2 || versions[1].Origin != plans.OriginCriticRevised || len(versions[1].Critic) == 0 {
			t.Fatalf("versions = %+v", versions)
		}
		if plan, _ := ir.Parse(final.IR); plan.Goal.Title != "Fix the Safari login failure" {
			t.Fatalf("revision not applied: %q", plan.Goal.Title)
		}
		if final.Confidence == nil || *final.Confidence < 0.79 {
			t.Fatalf("confidence = %v; a critic revision is not a repair", final.Confidence)
		}
	})
	t.Run("two rounds stop at two", func(t *testing.T) {
		scripted := replies(loaded)
		scripted[modelgateway.RoleCritic] = []string{revise, revise, revise}
		scripted[modelgateway.RoleRepair] = []string{revised, revised, revised}
		chat := newChatServer(t, scripted)
		h := newHarness(t, loaded, chat, func(options *Options) { options.MaxCriticRounds = 2 })
		header := h.generate(t, loaded)
		h.wait(t, header.ID)
		if chat.count(modelgateway.RoleCritic) != 2 || chat.count(modelgateway.RoleRepair) != 2 {
			t.Fatalf("critic calls = %d repair calls = %d, want 2 and 2", chat.count(modelgateway.RoleCritic), chat.count(modelgateway.RoleRepair))
		}
	})
	t.Run("an invalid revision is dropped", func(t *testing.T) {
		scripted := replies(loaded)
		scripted[modelgateway.RoleCritic] = []string{revise}
		scripted[modelgateway.RoleRepair] = []string{broken}
		chat := newChatServer(t, scripted)
		h := newHarness(t, loaded, chat)
		header := h.generate(t, loaded)
		final := h.wait(t, header.ID)
		_, versions, _, _ := h.store.snapshot(header.ID)
		if final.GenerationStatus != plans.GenerationSucceeded || final.ValidationStatus != plans.ValidationValid || len(versions) != 1 {
			t.Fatalf("final = %s/%s versions %d", final.GenerationStatus, final.ValidationStatus, len(versions))
		}
	})
	t.Run("zero rounds skip the critic", func(t *testing.T) {
		chat := newChatServer(t, replies(loaded))
		h := newHarness(t, loaded, chat, func(options *Options) { options.MaxCriticRounds = 0 })
		header := h.generate(t, loaded)
		h.wait(t, header.ID)
		if chat.count(modelgateway.RoleCritic) != 0 {
			t.Fatalf("critic called %d times with zero rounds", chat.count(modelgateway.RoleCritic))
		}
	})
}

// A blocking question stops before a plan exists: the goal-only skeleton
// carries the question as a blocking assumption, validation reads blocked,
// no planner call is made and plan.blocked names the question.
func TestBlockingAmbiguityStopsBeforePlanning(t *testing.T) {
	loaded := loadFixture(t, "simple-issue")
	scripted := replies(loaded)
	scripted[modelgateway.RoleClassifier] = []string{`{"goal":"Pay the vendor","requirements":[{"id":"r1","description":"Send money to the vendor","nature":"finite_work","entities":["vendor"],"explicitConstraints":[]}],"ambiguities":[{"id":"q1","description":"No recipient named","blocking":true,"question":"Which vendor and which account should be paid?"},{"id":"q2","description":"Assume EUR","blocking":false,"question":"Which currency?"}]}`}
	chat := newChatServer(t, scripted)
	h := newHarness(t, loaded, chat)
	header := h.generate(t, loaded)
	final := h.wait(t, header.ID)
	_, versions, events, outbox := h.store.snapshot(header.ID)
	if final.GenerationStatus != plans.GenerationSucceeded || final.ValidationStatus != plans.ValidationBlocked {
		t.Fatalf("final = %s/%s", final.GenerationStatus, final.ValidationStatus)
	}
	if chat.count(modelgateway.RolePlanner) != 0 || len(versions) != 1 {
		t.Fatalf("planner calls = %d versions = %d", chat.count(modelgateway.RolePlanner), len(versions))
	}
	plan, err := ir.Parse(final.IR)
	if err != nil || plan.Goal.Title != "Pay the vendor" || len(plan.Assumptions) != 2 || !plan.Assumptions[0].Blocking || plan.Assumptions[1].Blocking ||
		plan.Assumptions[0].ID != "a_q1" || len(plan.Issues) != 0 {
		t.Fatalf("skeleton = %+v (%v)", plan, err)
	}
	if got := stages(events); strings.Join(got, ",") != "intent:ok" || !strings.Contains(string(events[0].Detail), `"blocking":true`) {
		t.Fatalf("events = %v %s", got, events[0].Detail)
	}
	last := outbox[len(outbox)-1]
	if last.Type != TopicPlanBlocked || !strings.Contains(string(last.Payload), "Which vendor") {
		t.Fatalf("last fact = %s %s", last.Type, last.Payload)
	}
}

// A viewer is refused before anything is created; an unknown member reads
// as not found; a missing role agent is unavailable.
func TestGenerateAuthorizesAndChecksReadiness(t *testing.T) {
	loaded := loadFixture(t, "simple-issue")
	chat := newChatServer(t, replies(loaded))
	h := newHarness(t, loaded, chat)
	if _, _, err := h.service.Generate(context.Background(), GenerateInput{ActorID: h.viewer, WorkspaceID: h.ws, Prompt: "x"}); !errors.Is(err, identity.ErrForbidden) {
		t.Fatalf("viewer error = %v, want ErrForbidden", err)
	}
	if _, _, err := h.service.Generate(context.Background(), GenerateInput{ActorID: uuid.New(), WorkspaceID: h.ws, Prompt: "x"}); !errors.Is(err, identity.ErrNotFound) {
		t.Fatalf("stranger error = %v, want ErrNotFound", err)
	}
	if _, _, err := h.service.Generate(context.Background(), GenerateInput{ActorID: h.actor, WorkspaceID: h.ws, Prompt: "x", Hint: "sprint"}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("bad hint error = %v, want ErrInvalidInput", err)
	}
	if _, _, err := h.service.Generate(context.Background(), GenerateInput{ActorID: h.actor, WorkspaceID: h.ws, Prompt: strings.Repeat("x", MaxPromptLength+1)}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("long prompt error = %v, want ErrInvalidInput", err)
	}
	if len(h.store.headers) != 0 {
		t.Fatalf("refused requests created plans: %d", len(h.store.headers))
	}
	// A second plan for the same goal is refused while the first is open.
	goalID := uuid.New()
	if _, _, err := h.service.Generate(context.Background(), GenerateInput{ActorID: h.actor, WorkspaceID: h.ws, GoalID: &goalID, Prompt: loaded.UserPrompt}); err != nil {
		t.Fatalf("first goal plan: %v", err)
	}
	if _, _, err := h.service.Generate(context.Background(), GenerateInput{ActorID: h.actor, WorkspaceID: h.ws, GoalID: &goalID, Prompt: loaded.UserPrompt}); !errors.Is(err, plans.ErrPlanOpen) {
		t.Fatalf("second goal plan error = %v, want ErrPlanOpen", err)
	}

	missing := memoryRoles{rows: map[modelgateway.Role]modelgateway.RoleAgent{}}
	gateway, _ := modelgateway.NewOpenFang(&noChat{}, missing, nil)
	service, err := New(Options{Gateway: gateway, Store: newMemoryStore(), Authorization: fakeAuthorizer{roles: map[uuid.UUID]identity.Role{h.actor: identity.RoleMember}}, WorkerContext: context.Background()})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, _, err := service.Generate(context.Background(), GenerateInput{ActorID: h.actor, WorkspaceID: h.ws, Prompt: "x"}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unprovisioned error = %v, want ErrUnavailable", err)
	}
	disabled, _ := New(Options{Store: newMemoryStore(), Authorization: fakeAuthorizer{roles: map[uuid.UUID]identity.Role{h.actor: identity.RoleMember}}, WorkerContext: context.Background()})
	if _, _, err := disabled.Generate(context.Background(), GenerateInput{ActorID: h.actor, WorkspaceID: h.ws, Prompt: "x"}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("disabled error = %v, want ErrUnavailable", err)
	}
}

type noChat struct{}

func (noChat) ListModels(context.Context) ([]openfangModel, error) { return nil, nil }
func (noChat) CreateChatCompletion(context.Context, openfangRequest) (openfangResult, error) {
	return openfangResult{}, errors.New("unreachable")
}

// A stage that outlives PLANNER_TIMEOUT fails the generation with the stage
// named, records the timeout outcome and leaves nothing running; a shutdown
// while a stage is in flight fails it with "shutdown"; an upstream 429 is
// ROLE_RATE_LIMITED after exactly one request.
func TestTimeoutsShutdownAndRateLimitsEndTheGeneration(t *testing.T) {
	loaded := loadFixture(t, "simple-issue")
	t.Run("timeout", func(t *testing.T) {
		chat := newChatServer(t, replies(loaded))
		chat.delays[modelgateway.RolePlanner] = 2 * time.Second
		h := newHarness(t, loaded, chat, func(options *Options) { options.Timeout = 400 * time.Millisecond })
		header := h.generate(t, loaded)
		final := h.wait(t, header.ID)
		_, _, events, _ := h.store.snapshot(header.ID)
		if final.GenerationStatus != plans.GenerationFailed || final.GenerationError == nil || *final.GenerationError != "timeout at generate" {
			t.Fatalf("final = %s %v; stages %v", final.GenerationStatus, deref(final.GenerationError), stages(events))
		}
		if last := events[len(events)-1]; last.Stage != plans.StageGenerate || last.Outcome != plans.OutcomeTimeout {
			t.Fatalf("last event = %s:%s", last.Stage, last.Outcome)
		}
		if h.service.Running(header.ID) {
			t.Fatal("plan still tracked after failure")
		}
	})
	t.Run("shutdown", func(t *testing.T) {
		chat := newChatServer(t, replies(loaded))
		gate := make(chan struct{})
		chat.gates[modelgateway.RolePlanner] = gate
		h := newHarness(t, loaded, chat)
		header := h.generate(t, loaded)
		deadline := time.Now().Add(5 * time.Second)
		for chat.count(modelgateway.RolePlanner) == 0 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		closeCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		if err := h.service.Close(closeCtx); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Close() = %v, want the deadline to cancel the pipeline", err)
		}
		close(gate)
		final := h.wait(t, header.ID)
		if final.GenerationStatus != plans.GenerationFailed || final.GenerationError == nil || *final.GenerationError != ErrorShutdown {
			t.Fatalf("final = %s %v", final.GenerationStatus, deref(final.GenerationError))
		}
		if _, _, err := h.service.Generate(context.Background(), GenerateInput{ActorID: h.actor, WorkspaceID: h.ws, Prompt: "again"}); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("Generate() after Close = %v, want ErrUnavailable", err)
		}
	})
	t.Run("rate limited", func(t *testing.T) {
		chat := newChatServer(t, replies(loaded))
		chat.statuses[modelgateway.RolePlanner] = http.StatusTooManyRequests
		h := newHarness(t, loaded, chat)
		header := h.generate(t, loaded)
		final := h.wait(t, header.ID)
		if final.GenerationStatus != plans.GenerationFailed || final.GenerationError == nil || *final.GenerationError != ErrorRoleRateLimited+" at generate" {
			t.Fatalf("final = %s %v", final.GenerationStatus, deref(final.GenerationError))
		}
		if chat.count(modelgateway.RolePlanner) != 1 {
			t.Fatalf("planner requests = %d, want exactly one (never retry a paid call)", chat.count(modelgateway.RolePlanner))
		}
	})
}

// The task messages are one bounded text each: the planner sees the context
// JSON and the hint, the repair role sees the exact errors, and every call
// carries the JSON-object response format.
func TestMessagesCarryContextAndFit(t *testing.T) {
	loaded := loadFixture(t, "donation-golden")
	chat := newChatServer(t, replies(loaded))
	h := newHarness(t, loaded, chat)
	header := h.generate(t, loaded)
	h.wait(t, header.ID)
	task := chat.request(modelgateway.RolePlanner, 0)
	for _, want := range []string{"# Request", loaded.UserPrompt, "# Intent analysis", "# Context", `"issuePrefix":"BER"`, `"name":"stripe.payment_succeeded"`, `"name":"Designer"`, "# Instructions"} {
		if !strings.Contains(task, want) {
			t.Fatalf("planner task lacks %q", want)
		}
	}
	if strings.Contains(task, `"name":"Orchestrator"`) {
		t.Fatal("the orchestrator was offered to the planner")
	}
	intentTask := chat.request(modelgateway.RoleClassifier, 0)
	if !strings.Contains(intentTask, loaded.UserPrompt) || strings.Contains(intentTask, "# Context") {
		t.Fatalf("intent task = %s", intentTask)
	}
	// An oversized context compacts before it is refused.
	rendered := PlanContext{Repository: strings.Repeat("x", maxMessageBytes)}
	message, err := generateMessage("p", ir.IntentAnalysis{Goal: "g"}, rendered)
	if err != nil || strings.Contains(message, "xxxxxxxxxx") {
		t.Fatalf("compacted message = %d bytes, %v", len(message), err)
	}
	huge := &ir.Plan{Schema: ir.Schema, Version: ir.Version}
	huge.Goal.Description = ptr(strings.Repeat("y", maxMessageBytes))
	if _, err := repairMessage("p", ir.IntentAnalysis{}, huge, nil, PlanContext{}); !errors.Is(err, modelgateway.ErrRequestTooLarge) {
		t.Fatalf("oversized plan error = %v", err)
	}
}

func ptr(value string) *string { return &value }

// Report validates a stored plan with the workspace's agents and issues so
// a read shows what the pipeline saw.
func TestReportUsesTheWorkspaceSources(t *testing.T) {
	loaded := loadFixture(t, "donation-golden")
	chat := newChatServer(t, replies(loaded))
	h := newHarness(t, loaded, chat)
	plan, _ := ir.Parse([]byte(loaded.ModelReplies.Planner[0]))
	plan.Issues[0].SuggestedAgentID = &h.viewer
	catalog := integrationcore.NewCatalog(h.service.options.Sources.Registry, integrationcore.ConnectedSet(nil))
	report := h.service.Report(context.Background(), plans.PlanHeader{WorkspaceID: h.ws}, plan, validate.Permissions{Role: "admin", CanWrite: true, CanActivateHighRisk: true, Known: true}, catalog)
	if report.Valid() || report.Errors[0].Code != validate.CodeAgentUnknown {
		t.Fatalf("report = %+v", report.Errors)
	}
	if len(report.RequiredConnections) != 3 || report.Risk != "high" || report.NeedsAdminActivation {
		t.Fatalf("report = %+v", report)
	}
}
