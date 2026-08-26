package plans

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
	"github.com/laravel42/berry-circle/server/internal/modelgateway"
	"github.com/laravel42/berry-circle/server/internal/planner"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
	planrepo "github.com/laravel42/berry-circle/server/internal/repository/plans"
)

type fakePlanner struct {
	inputs []planner.GenerateInput
	err    error
	store  *fakeStore
}

func (fake *fakePlanner) Generate(_ context.Context, input planner.GenerateInput) (planrepo.PlanHeader, []ledger.Event, error) {
	fake.inputs = append(fake.inputs, input)
	if fake.err != nil {
		return planrepo.PlanHeader{}, nil, fake.err
	}
	prompt := input.Prompt
	header := planrepo.PlanHeader{
		ID: uuid.New(), WorkspaceID: input.WorkspaceID, Status: planrepo.StatusDraft, Source: planrepo.SourceAI, SourcePrompt: &prompt,
		GenerationStatus: planrepo.GenerationRunning, ValidationStatus: planrepo.ValidationUnknown, CompileStatus: planrepo.CompileNotStarted,
		BoardID: input.BoardID, GoalID: input.GoalID,
	}
	fake.store.header = header
	return header, []ledger.Event{{ID: uuid.New(), Type: "goal.created", WorkspaceID: input.WorkspaceID}}, nil
}

func (fake *fakePlanner) Ready(context.Context) error { return nil }

type fakeRoles struct{ rows []modelgateway.RoleAgent }

func (fake fakeRoles) List(context.Context) ([]modelgateway.RoleAgent, error) { return fake.rows, nil }

// POST /generate validates the body, refuses viewers with PLAN_FORBIDDEN,
// answers 412 without a planner, maps the planner's refusals, and on
// success answers 202 with the running plan and its Location.
func TestGenerateRouteValidatesAndAnswers202(t *testing.T) {
	store := &fakeStore{}
	fake := &fakePlanner{store: store}
	member := newTestMount(t, store, identity.RoleMember, func(options *Options) { options.Planner = fake })
	workspaceID := uuid.New()
	body := `{"workspaceId":"` + workspaceID.String() + `","prompt":"Create a donation landing page with Stripe. Ask me before deploying.","hint":"auto"}`

	response := do(member, http.MethodPost, "/generate", body)
	if response.Code != http.StatusAccepted || response.Header().Get("Location") == "" {
		t.Fatalf("generate = %d %s", response.Code, response.Body.String())
	}
	var decoded map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &decoded)
	generation, _ := decoded["generation"].(map[string]any)
	if generation["status"] != "running" || generation["stage"] != "intent" || decoded["plan"] != nil || decoded["status"] != "draft" {
		t.Fatalf("resource = %s", response.Body.String())
	}
	if len(fake.inputs) != 1 || fake.inputs[0].WorkspaceID != workspaceID || fake.inputs[0].Hint != planner.HintAuto || fake.inputs[0].Prompt == "" {
		t.Fatalf("planner input = %+v", fake.inputs)
	}

	for name, tc := range map[string]struct {
		body string
		code int
		want string
	}{
		"bad workspace": {body: `{"workspaceId":"nope","prompt":"x"}`, code: http.StatusUnprocessableEntity, want: "/workspaceId"},
		"empty prompt":  {body: `{"workspaceId":"` + workspaceID.String() + `","prompt":"   "}`, code: http.StatusUnprocessableEntity, want: "/prompt"},
		"bad hint":      {body: `{"workspaceId":"` + workspaceID.String() + `","prompt":"x","hint":"sprint"}`, code: http.StatusUnprocessableEntity, want: "/hint"},
		"bad goal":      {body: `{"workspaceId":"` + workspaceID.String() + `","prompt":"x","goalId":"g"}`, code: http.StatusUnprocessableEntity, want: "/goalId"},
		"long prompt":   {body: `{"workspaceId":"` + workspaceID.String() + `","prompt":"` + strings.Repeat("x", 20001) + `"}`, code: http.StatusUnprocessableEntity, want: "/prompt"},
	} {
		t.Run(name, func(t *testing.T) {
			response := do(member, http.MethodPost, "/generate", tc.body)
			if response.Code != tc.code || !strings.Contains(response.Body.String(), tc.want) {
				t.Fatalf("%s = %d %s", name, response.Code, response.Body.String())
			}
		})
	}
	if len(fake.inputs) != 1 {
		t.Fatalf("invalid bodies reached the planner: %d", len(fake.inputs))
	}

	for name, tc := range map[string]struct {
		err  error
		code int
		want string
	}{
		"viewer":       {err: identity.ErrForbidden, code: http.StatusForbidden, want: "PLAN_FORBIDDEN"},
		"stranger":     {err: identity.ErrNotFound, code: http.StatusNotFound, want: "NOT_FOUND"},
		"unavailable":  {err: planner.ErrUnavailable, code: http.StatusPreconditionFailed, want: "PLANNER_UNAVAILABLE"},
		"open plan":    {err: planrepo.ErrPlanOpen, code: http.StatusConflict, want: "PLAN_OPEN_EXISTS"},
		"no board":     {err: planner.ErrNoBoard, code: http.StatusConflict, want: "BOARD_REQUIRED"},
		"missing goal": {err: planrepo.ErrNotFound, code: http.StatusNotFound, want: "NOT_FOUND"},
	} {
		t.Run(name, func(t *testing.T) {
			fake.err = tc.err
			response := do(member, http.MethodPost, "/generate", body)
			if response.Code != tc.code || !strings.Contains(response.Body.String(), tc.want) {
				t.Fatalf("%s = %d %s", name, response.Code, response.Body.String())
			}
		})
	}
	fake.err = nil
	viewer := newTestMount(t, store, identity.RoleViewer, func(options *Options) { options.Planner = &fakePlanner{store: store, err: identity.ErrForbidden} })
	if response := do(viewer, http.MethodPost, "/generate", body); response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "PLAN_FORBIDDEN") {
		t.Fatalf("viewer generate = %d %s", response.Code, response.Body.String())
	}
	none := newTestMount(t, store, identity.RoleMember)
	if response := do(none, http.MethodPost, "/generate", body); response.Code != http.StatusPreconditionFailed || !strings.Contains(response.Body.String(), "PLANNER_UNAVAILABLE") {
		t.Fatalf("no planner = %d %s", response.Code, response.Body.String())
	}
}

// While a plan generates its reads carry the stage in progress and Start
// Plan answers PLAN_BUSY; a blocked plan and a plan failing the validator
// answer PLAN_INVALID on approve and compile.
func TestReadsShowTheStageAndGatesRefuseInvalidPlans(t *testing.T) {
	planID := uuid.New()
	stage, outcome := planrepo.StageValidate, planrepo.OutcomeInvalid
	store := &fakeStore{header: planrepo.PlanHeader{
		ID: planID, WorkspaceID: uuid.New(), Status: planrepo.StatusDraft, Source: planrepo.SourceAI, GenerationStatus: planrepo.GenerationRunning,
		ValidationStatus: planrepo.ValidationUnknown, CompileStatus: planrepo.CompileNotStarted, LastStage: &stage, LastOutcome: &outcome,
	}}
	admin := newTestMount(t, store, identity.RoleAdmin)
	response := do(admin, http.MethodGet, "/"+planID.String(), "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"generation":{"status":"running","error":null,"stage":"repair"}`) {
		t.Fatalf("running read = %d %s", response.Code, response.Body.String())
	}
	for _, path := range []string{"/approve", "/compile"} {
		if response := do(admin, http.MethodPost, "/"+planID.String()+path, `{}`); response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "PLAN_BUSY") {
			t.Fatalf("%s while running = %d %s", path, response.Code, response.Body.String())
		}
	}

	store.header.GenerationStatus = planrepo.GenerationSucceeded
	store.header.ValidationStatus = planrepo.ValidationBlocked
	store.header.IR = json.RawMessage(`{"$schema":"berry-plan/1","version":"1","goal":{"tempId":"g_pending","title":"Pay the vendor"},"assumptions":[{"id":"a_q1","description":"Which vendor?","confidence":"low","userEditable":true,"blocking":true}],"confidence":0}`)
	response = do(admin, http.MethodGet, "/"+planID.String(), "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ambiguities":[{"id":"a_q1","question":"Which vendor?","blocking":true}]`) ||
		!strings.Contains(response.Body.String(), `"stage":null`) || !strings.Contains(response.Body.String(), "AMBIGUITY_BLOCKING") {
		t.Fatalf("blocked read = %d %s", response.Code, response.Body.String())
	}
	if response := do(admin, http.MethodPost, "/"+planID.String()+"/approve", `{}`); response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "PLAN_INVALID") {
		t.Fatalf("approve blocked = %d %s", response.Code, response.Body.String())
	}

	store.header.ValidationStatus = planrepo.ValidationValid
	store.header.IR = json.RawMessage(`{"$schema":"berry-plan/1","version":"1","goal":{"tempId":"g_1","title":"Ship"},"issues":[{"tempId":"i_1","title":"Deploy to production","type":"issue"}],"confidence":0.7}`)
	response = do(admin, http.MethodPost, "/"+planID.String()+"/approve", `{}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "PLAN_INVALID") || !strings.Contains(response.Body.String(), "DESTRUCTIVE_WITHOUT_APPROVAL") || store.compiled != 0 {
		t.Fatalf("approve invalid = %d %s (compiled %d)", response.Code, response.Body.String(), store.compiled)
	}
	if response := do(admin, http.MethodPost, "/"+planID.String()+"/validate", `{}`); response.Code != http.StatusOK || store.header.ValidationStatus != planrepo.ValidationInvalid {
		t.Fatalf("validate = %d %s status %s", response.Code, response.Body.String(), store.header.ValidationStatus)
	}
}

// GET /roles needs settings.read and lists the provisioned roles without
// their upstream ids.
func TestRolesRouteIsForAdmins(t *testing.T) {
	store := &fakeStore{}
	maxTokens, hourly := int64(16384), int64(4_000_000)
	synced := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	roles := fakeRoles{rows: []modelgateway.RoleAgent{{
		Role: modelgateway.RolePlanner, OpenFangAgentID: uuid.New(), UpstreamName: "berry-planner-abc", Provider: "openrouter", Model: "minimax/minimax-m2.7:free",
		PromptVersion: "planner-v1", Status: modelgateway.StatusAvailable, MaxTokens: &maxTokens, MaxLLMTokensPerHour: &hourly, LastSyncedAt: &synced,
	}}}
	member := newTestMount(t, store, identity.RoleMember, func(options *Options) { options.Roles = roles; options.Planner = &fakePlanner{store: store} })
	if response := do(member, http.MethodGet, "/roles", ""); response.Code != http.StatusForbidden {
		t.Fatalf("member roles = %d %s", response.Code, response.Body.String())
	}
	admin := newTestMount(t, store, identity.RoleAdmin, func(options *Options) { options.Roles = roles; options.Planner = &fakePlanner{store: store} })
	response := do(admin, http.MethodGet, "/roles", "")
	if response.Code != http.StatusOK {
		t.Fatalf("admin roles = %d %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, want := range []string{`"enabled":true`, `"role":"planner"`, `"model":"minimax/minimax-m2.7:free"`, `"promptVersion":"planner-v1"`, `"status":"available"`, `"maxTokens":16384`, `"maxLLMTokensPerHour":4000000`, `"lastSyncedAt":"2026-08-25T12:00:00Z"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("roles body lacks %s: %s", want, body)
		}
	}
	if strings.Contains(body, "berry-planner-abc") {
		t.Fatalf("roles body leaks the upstream name: %s", body)
	}
	disabled := newTestMount(t, store, identity.RoleAdmin)
	if response := do(disabled, http.MethodGet, "/roles", ""); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"enabled":false`) || !strings.Contains(response.Body.String(), `"roles":[]`) {
		t.Fatalf("disabled roles = %d %s", response.Code, response.Body.String())
	}
	if !errors.Is(planner.ErrUnavailable, planner.ErrUnavailable) {
		t.Fatal("unreachable")
	}
}
