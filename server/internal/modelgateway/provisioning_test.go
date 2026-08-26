package modelgateway

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

type memoryStore struct {
	rows map[Role]RoleAgent
}

func newMemoryStore() *memoryStore { return &memoryStore{rows: map[Role]RoleAgent{}} }

func (store *memoryStore) Get(_ context.Context, role Role) (RoleAgent, error) {
	row, ok := store.rows[role]
	if !ok {
		return RoleAgent{}, ErrNotFound
	}
	return row, nil
}

func (store *memoryStore) List(context.Context) ([]RoleAgent, error) {
	var out []RoleAgent
	for _, role := range Roles {
		if row, ok := store.rows[role]; ok {
			out = append(out, row)
		}
	}
	return out, nil
}

func (store *memoryStore) Upsert(_ context.Context, agent RoleAgent, now time.Time) error {
	agent.UpdatedAt = now
	store.rows[agent.Role] = agent
	return nil
}

func (store *memoryStore) SetStatus(_ context.Context, role Role, status string, _ time.Time) error {
	row, ok := store.rows[role]
	if !ok {
		return ErrNotFound
	}
	row.Status = status
	store.rows[role] = row
	return nil
}

type fakeRuntime struct {
	agents    map[uuid.UUID]openfang.AgentDetail
	probeErr  error
	spawned   []string
	patched   []openfang.PatchAgentRequest
	spawnFail error
}

func (runtime *fakeRuntime) GetAgent(_ context.Context, id uuid.UUID) (openfang.AgentDetail, error) {
	if runtime.probeErr != nil {
		return openfang.AgentDetail{}, runtime.probeErr
	}
	detail, ok := runtime.agents[id]
	if !ok {
		return openfang.AgentDetail{}, &openfang.UpstreamError{Kind: openfang.ErrorNotFound, StatusCode: 404}
	}
	return detail, nil
}

func (runtime *fakeRuntime) SpawnAgent(_ context.Context, manifest string) (openfang.SpawnResponse, error) {
	if runtime.spawnFail != nil {
		return openfang.SpawnResponse{}, runtime.spawnFail
	}
	runtime.spawned = append(runtime.spawned, manifest)
	id := uuid.New()
	name := ""
	for _, line := range strings.Split(manifest, "\n") {
		if strings.HasPrefix(line, "name = ") {
			name = strings.Trim(strings.TrimPrefix(line, "name = "), `"`)
		}
	}
	if runtime.agents == nil {
		runtime.agents = map[uuid.UUID]openfang.AgentDetail{}
	}
	runtime.agents[id] = openfang.AgentDetail{ID: id, Name: name}
	return openfang.SpawnResponse{AgentID: id, Name: name}, nil
}

func (runtime *fakeRuntime) PatchAgent(_ context.Context, _ uuid.UUID, request openfang.PatchAgentRequest) error {
	runtime.patched = append(runtime.patched, request)
	return nil
}

func testSpecs() RoleSpecs {
	pair := RoleSpec{Provider: "openrouter", Model: "minimax/minimax-m2.7:free"}
	return RoleSpecs{Classifier: pair, Planner: pair, Repair: pair, Critic: pair, MaxOutputTokens: 16384, TokensPerHour: 4_000_000}
}

func testPrompts() map[Role]Prompt {
	return map[Role]Prompt{
		RoleClassifier: {Version: "intent-v1", Text: "classify"},
		RolePlanner:    {Version: "planner-v1", Text: "plan"},
		RoleRepair:     {Version: "repair-v1", Text: "repair"},
		RoleCritic:     {Version: "critic-v1", Text: "review"},
	}
}

// First boot spawns one agent per role with the configured model, the
// output cap and the hourly budget, and records every row available. A
// second boot against the same runtime spawns nothing.
func TestEnsureRoleAgentsSpawnsOncePerRole(t *testing.T) {
	store := newMemoryStore()
	runtime := &fakeRuntime{}
	logger := slog.New(slog.DiscardHandler)
	if err := EnsureRoleAgents(context.Background(), store, runtime, runtime, testSpecs(), testPrompts(), uuid.New, logger); err != nil {
		t.Fatalf("EnsureRoleAgents() error = %v", err)
	}
	if len(runtime.spawned) != 4 {
		t.Fatalf("spawned %d agents, want 4", len(runtime.spawned))
	}
	for _, manifest := range runtime.spawned {
		for _, want := range []string{"[model]", `provider = "openrouter"`, `model = "minimax/minimax-m2.7:free"`, "max_tokens = 16384", "[resources]", "max_llm_tokens_per_hour = 4000000", "system_prompt = "} {
			if !strings.Contains(manifest, want) {
				t.Fatalf("manifest missing %q:\n%s", want, manifest)
			}
		}
		for _, forbidden := range []string{"[schedule]", "[autonomous]", "[capabilities]"} {
			if strings.Contains(manifest, forbidden) {
				t.Fatalf("manifest carries %q:\n%s", forbidden, manifest)
			}
		}
	}
	rows, _ := store.List(context.Background())
	if len(rows) != 4 {
		t.Fatalf("rows = %d", len(rows))
	}
	for _, row := range rows {
		if row.Status != StatusAvailable || row.PromptVersion == "" || !strings.HasPrefix(row.UpstreamName, "berry-"+string(row.Role)+"-") ||
			row.MaxTokens == nil || *row.MaxTokens != 16384 || row.MaxLLMTokensPerHour == nil || *row.MaxLLMTokensPerHour != 4_000_000 {
			t.Fatalf("row = %+v", row)
		}
	}
	// Second boot: every agent answers the probe; nothing is spawned or patched.
	for id, detail := range runtime.agents {
		detail.Model = openfang.AgentModel{Provider: "openrouter", Model: "minimax/minimax-m2.7:free"}
		for _, row := range rows {
			if row.OpenFangAgentID == id {
				detail.SystemPrompt = testPrompts()[row.Role].Text + "\n"
			}
		}
		runtime.agents[id] = detail
	}
	runtime.spawned = nil
	if err := EnsureRoleAgents(context.Background(), store, runtime, runtime, testSpecs(), testPrompts(), uuid.New, logger); err != nil {
		t.Fatalf("second EnsureRoleAgents() error = %v", err)
	}
	if len(runtime.spawned) != 0 || len(runtime.patched) != 0 {
		t.Fatalf("second boot spawned %d patched %d", len(runtime.spawned), len(runtime.patched))
	}
}

// Provider, model or prompt drift is corrected in place with one patch that
// carries the pair together; limit drift only warns and is read back into
// the row; a missing upstream agent is re-spawned; a transport failure
// marks the role offline and never spawns.
func TestEnsureRoleAgentsHandlesDriftMissingAndTransportFailures(t *testing.T) {
	store := newMemoryStore()
	runtime := &fakeRuntime{agents: map[uuid.UUID]openfang.AgentDetail{}}
	logger := slog.New(slog.DiscardHandler)
	planner, classifier, repair, critic := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	maxTokens, hourly := int64(4096), int64(150_000)
	runtime.agents[planner] = openfang.AgentDetail{ID: planner, Model: openfang.AgentModel{Provider: "openrouter", Model: "anthropic/claude-sonnet-4"}, SystemPrompt: "old",
		Limits: &openfang.AgentLimits{MaxTokens: &maxTokens, MaxLLMTokensPerHour: &hourly}}
	runtime.agents[classifier] = openfang.AgentDetail{ID: classifier, Model: openfang.AgentModel{Provider: "openrouter", Model: "minimax/minimax-m2.7:free"}, SystemPrompt: "classify"}
	runtime.agents[critic] = openfang.AgentDetail{ID: critic, Model: openfang.AgentModel{Provider: "openrouter", Model: "minimax/minimax-m2.7:free"}, SystemPrompt: "review"}
	for role, id := range map[Role]uuid.UUID{RolePlanner: planner, RoleClassifier: classifier, RoleRepair: repair, RoleCritic: critic} {
		store.rows[role] = RoleAgent{Role: role, OpenFangAgentID: id, UpstreamName: "berry-" + string(role) + "-old", Provider: "openrouter", Model: "x", PromptVersion: "v0", Status: StatusUnknown}
	}
	if err := EnsureRoleAgents(context.Background(), store, runtime, runtime, testSpecs(), testPrompts(), uuid.New, logger); err != nil {
		t.Fatalf("EnsureRoleAgents() error = %v", err)
	}
	if len(runtime.patched) != 1 || runtime.patched[0].Provider == nil || runtime.patched[0].Model == nil || runtime.patched[0].SystemPrompt == nil ||
		*runtime.patched[0].Model != "minimax/minimax-m2.7:free" || *runtime.patched[0].SystemPrompt != "plan" {
		t.Fatalf("patched = %+v", runtime.patched)
	}
	if len(runtime.spawned) != 1 || !strings.Contains(runtime.spawned[0], `berry-repair-`) {
		t.Fatalf("spawned = %v, want only the missing repair agent", runtime.spawned)
	}
	plannerRow := store.rows[RolePlanner]
	if plannerRow.Status != StatusAvailable || plannerRow.PromptVersion != "planner-v1" || plannerRow.Model != "minimax/minimax-m2.7:free" ||
		plannerRow.MaxTokens == nil || *plannerRow.MaxTokens != 4096 || plannerRow.MaxLLMTokensPerHour == nil || *plannerRow.MaxLLMTokensPerHour != 150_000 ||
		plannerRow.OpenFangAgentID != planner {
		t.Fatalf("planner row = %+v", plannerRow)
	}
	if repairRow := store.rows[RoleRepair]; repairRow.OpenFangAgentID == repair || repairRow.Status != StatusAvailable {
		t.Fatalf("repair row = %+v, want a fresh agent", repairRow)
	}

	// Transport failure: the runtime is unreachable; roles go offline and no agent is spawned.
	runtime.probeErr = &openfang.UpstreamError{Kind: openfang.ErrorUnavailable, StatusCode: 503}
	runtime.spawned = nil
	if err := EnsureRoleAgents(context.Background(), store, runtime, runtime, testSpecs(), testPrompts(), uuid.New, logger); err != nil {
		t.Fatalf("EnsureRoleAgents() with outage error = %v", err)
	}
	if len(runtime.spawned) != 0 {
		t.Fatalf("spawned during outage: %v", runtime.spawned)
	}
	for _, role := range Roles {
		if store.rows[role].Status != StatusOffline {
			t.Fatalf("%s status = %s, want offline", role, store.rows[role].Status)
		}
	}
	// A spawn refusal is reported, not fatal, and leaves no row for the role.
	empty := newMemoryStore()
	refusing := &fakeRuntime{spawnFail: &openfang.UpstreamError{Kind: openfang.ErrorBadRequest, StatusCode: 400}}
	if err := EnsureRoleAgents(context.Background(), empty, refusing, refusing, testSpecs(), testPrompts(), uuid.New, logger); err != nil {
		t.Fatalf("EnsureRoleAgents() with refusal error = %v", err)
	}
	if len(empty.rows) != 0 {
		t.Fatalf("rows after refusal = %+v", empty.rows)
	}
	if err := EnsureRoleAgents(context.Background(), nil, refusing, refusing, testSpecs(), testPrompts(), uuid.New, logger); err == nil {
		t.Fatal("nil store accepted")
	}
}

func TestManifestEscapesAndBounds(t *testing.T) {
	manifest, err := Manifest("evil\"\n[schedule]\ncron = \"* * * * *", RolePlanner, RoleSpec{Provider: "openrouter", Model: "m"}, Prompt{Version: "v1", Text: "line1\nline2 \"quoted\""}, 0, 0)
	if err != nil {
		t.Fatalf("Manifest() error = %v", err)
	}
	headers := 0
	for _, line := range strings.Split(manifest, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			headers++
		}
	}
	if headers != 2 || strings.Contains(manifest, "\n[schedule]") {
		t.Fatalf("manifest injection succeeded:\n%s", manifest)
	}
	if !strings.Contains(manifest, `system_prompt = "line1\nline2 \"quoted\""`) || !strings.Contains(manifest, "max_tokens = 16384") ||
		!strings.Contains(manifest, "max_llm_tokens_per_hour = 4000000") {
		t.Fatalf("manifest defaults wrong:\n%s", manifest)
	}
	if _, err := Manifest("x", RolePlanner, RoleSpec{Provider: "p", Model: "m"}, Prompt{Version: "v1", Text: strings.Repeat("a", 20001)}, 0, 0); err == nil {
		t.Fatal("oversized prompt accepted")
	}
	if _, err := Manifest("x", RolePlanner, RoleSpec{}, Prompt{Version: "v1", Text: "t"}, 0, 0); err == nil {
		t.Fatal("unconfigured model accepted")
	}
	if !errors.Is(errors.New("x"), errors.New("x")) {
		// errors.Is on distinct values is false; keep the import honest.
		_ = errors.New
	}
}

func TestOnlyNotFoundAuthorisesSpawn(t *testing.T) {
	if !isMissingUpstream(&openfang.UpstreamError{Kind: openfang.ErrorNotFound}) {
		t.Error("a 404 should authorise provisioning")
	}
	for _, kind := range []openfang.ErrorKind{openfang.ErrorAuth, openfang.ErrorUnavailable, openfang.ErrorBadRequest, openfang.ErrorRateLimited} {
		if isMissingUpstream(&openfang.UpstreamError{Kind: kind}) {
			t.Errorf("%v must not authorise provisioning", kind)
		}
	}
	if isMissingUpstream(errors.New("connection refused")) {
		t.Error("a transport failure must not authorise provisioning")
	}
}
