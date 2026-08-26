package planner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/identity"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/modelgateway"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/planner/validate"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
	"github.com/laravel42/berry-circle/server/internal/repository/plans"
)

// memoryStore is the plans repository without Postgres: headers, versions,
// stage records and outbox facts kept in maps, with the same optimistic
// version check and sequence allocation.
type memoryStore struct {
	mu       sync.Mutex
	headers  map[uuid.UUID]plans.PlanHeader
	versions map[uuid.UUID][]plans.PlanVersion
	events   map[uuid.UUID][]plans.PlannerEvent
	outbox   map[uuid.UUID][]ledger.Event
	board    uuid.UUID
	openGoal map[uuid.UUID]bool
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		headers: map[uuid.UUID]plans.PlanHeader{}, versions: map[uuid.UUID][]plans.PlanVersion{},
		events: map[uuid.UUID][]plans.PlannerEvent{}, outbox: map[uuid.UUID][]ledger.Event{}, board: uuid.New(), openGoal: map[uuid.UUID]bool{},
	}
}

func (store *memoryStore) CreateGenerated(_ context.Context, params plans.CreateGeneratedParams) (plans.PlanHeader, []ledger.Event, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	goalID := params.GoalID
	var events []ledger.Event
	if goalID == nil {
		id := uuid.New()
		goalID = &id
		events = append(events, ledger.Event{ID: uuid.New(), Type: "goal.created", WorkspaceID: params.WorkspaceID, OccurredAt: params.CreatedAt})
	} else if store.openGoal[*goalID] {
		return plans.PlanHeader{}, nil, plans.ErrPlanOpen
	}
	store.openGoal[*goalID] = true
	prompt := params.Prompt
	header := plans.PlanHeader{
		ID: params.ID, WorkspaceID: params.WorkspaceID, GoalID: goalID, ProjectID: params.ProjectID, BoardID: params.BoardID,
		Status: plans.StatusDraft, Source: plans.SourceAI, SourcePrompt: &prompt, GenerationStatus: plans.GenerationRunning,
		ValidationStatus: plans.ValidationUnknown, CompileStatus: plans.CompileNotStarted, CreatedBy: &params.ActorID,
		CreatedAt: params.CreatedAt, UpdatedAt: params.CreatedAt,
	}
	store.headers[params.ID] = header
	return header, events, nil
}

func (store *memoryStore) GetHeader(_ context.Context, planID uuid.UUID) (plans.PlanHeader, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	header, ok := store.headers[planID]
	if !ok {
		return plans.PlanHeader{}, plans.ErrNotFound
	}
	return header, nil
}

func (store *memoryStore) SaveVersion(_ context.Context, params plans.SaveVersionParams) (plans.PlanVersion, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	header, ok := store.headers[params.PlanID]
	if !ok {
		return plans.PlanVersion{}, plans.ErrNotFound
	}
	if header.CurrentVersion != params.ExpectedVersion {
		return plans.PlanVersion{}, plans.ErrVersionConflict
	}
	version := plans.PlanVersion{
		ID: uuid.New(), WorkspaceID: header.WorkspaceID, PlanID: header.ID, Version: header.CurrentVersion + 1, Origin: params.Origin,
		IR: params.IR, IRVersion: params.IRVersion, Validation: params.Validation, Critic: params.Critic, CreatedByType: params.CreatedByType, CreatedAt: params.CreatedAt,
	}
	store.versions[header.ID] = append(store.versions[header.ID], version)
	header.IR = params.IR
	irVersion := params.IRVersion
	header.IRVersion = &irVersion
	header.CurrentVersion = version.Version
	if params.ValidationStatus != "" {
		header.ValidationStatus = params.ValidationStatus
	}
	if params.Confidence != nil {
		header.Confidence = params.Confidence
	}
	if params.PlannerVersion != nil {
		header.PlannerVersion = params.PlannerVersion
	}
	header.UpdatedAt = params.CreatedAt
	store.headers[header.ID] = header
	return version, nil
}

func (store *memoryStore) FinishGeneration(_ context.Context, params plans.FinishGenerationParams) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	header, ok := store.headers[params.PlanID]
	if !ok {
		return plans.ErrNotFound
	}
	header.GenerationStatus = params.Status
	header.GenerationError = params.Error
	if params.ValidationStatus != "" {
		header.ValidationStatus = params.ValidationStatus
	}
	if params.Confidence != nil {
		header.Confidence = params.Confidence
	}
	if params.PlannerVersion != nil {
		header.PlannerVersion = params.PlannerVersion
	}
	header.UpdatedAt = params.Now
	store.headers[header.ID] = header
	return nil
}

func (store *memoryStore) RecordEvent(_ context.Context, params plans.RecordEventParams) (plans.PlannerEvent, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	header, ok := store.headers[params.PlanID]
	if !ok {
		return plans.PlannerEvent{}, plans.ErrNotFound
	}
	event := plans.PlannerEvent{
		ID: params.ID, WorkspaceID: header.WorkspaceID, PlanID: params.PlanID, Sequence: len(store.events[params.PlanID]) + 1, Stage: params.Stage,
		Role: params.Role, PromptVersion: params.PromptVersion, ModelProvider: params.ModelProvider, ModelName: params.ModelName,
		InputTokens: params.InputTokens, OutputTokens: params.OutputTokens, CostMicros: params.CostMicros, DurationMS: params.DurationMS,
		Outcome: params.Outcome, Detail: params.Detail, OccurredAt: params.OccurredAt,
	}
	store.events[params.PlanID] = append(store.events[params.PlanID], event)
	stage, outcome := event.Stage, event.Outcome
	header.LastStage, header.LastOutcome = &stage, &outcome
	store.headers[header.ID] = header
	return event, nil
}

func (store *memoryStore) EmitPlanEvent(_ context.Context, planID uuid.UUID, topic string, detail map[string]any, newID func() uuid.UUID, now time.Time) (ledger.Event, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	header, ok := store.headers[planID]
	if !ok {
		return ledger.Event{}, plans.ErrNotFound
	}
	payload, _ := json.Marshal(detail)
	event := ledger.Event{ID: newID(), Type: topic, WorkspaceID: header.WorkspaceID, OccurredAt: now, Payload: payload}
	store.outbox[planID] = append(store.outbox[planID], event)
	return event, nil
}

func (store *memoryStore) DefaultBoard(context.Context, uuid.UUID) (uuid.UUID, error) {
	return store.board, nil
}

func (store *memoryStore) snapshot(planID uuid.UUID) (plans.PlanHeader, []plans.PlanVersion, []plans.PlannerEvent, []ledger.Event) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.headers[planID], append([]plans.PlanVersion(nil), store.versions[planID]...),
		append([]plans.PlannerEvent(nil), store.events[planID]...), append([]ledger.Event(nil), store.outbox[planID]...)
}

// memoryRoles is the role table without Postgres.
type memoryRoles struct {
	rows map[modelgateway.Role]modelgateway.RoleAgent
}

func (roles memoryRoles) Get(_ context.Context, role modelgateway.Role) (modelgateway.RoleAgent, error) {
	row, ok := roles.rows[role]
	if !ok {
		return modelgateway.RoleAgent{}, modelgateway.ErrNotFound
	}
	return row, nil
}

func (roles memoryRoles) List(context.Context) ([]modelgateway.RoleAgent, error) {
	var out []modelgateway.RoleAgent
	for _, role := range modelgateway.Roles {
		if row, ok := roles.rows[role]; ok {
			out = append(out, row)
		}
	}
	return out, nil
}

func testRoles() memoryRoles {
	rows := map[modelgateway.Role]modelgateway.RoleAgent{}
	for _, role := range modelgateway.Roles {
		rows[role] = modelgateway.RoleAgent{
			Role: role, OpenFangAgentID: uuid.New(), UpstreamName: "berry-" + string(role) + "-test", Provider: "openrouter",
			Model: "test/model", PromptVersion: string(role) + "-v1", Status: modelgateway.StatusAvailable,
		}
	}
	return memoryRoles{rows: rows}
}

// chatServer is a fake OpenFang chat route: it maps the agent name to a role
// and answers with the next scripted reply for it, recording every request.
type chatServer struct {
	mu       sync.Mutex
	replies  map[modelgateway.Role][]string
	statuses map[modelgateway.Role]int
	delays   map[modelgateway.Role]time.Duration
	gates    map[modelgateway.Role]chan struct{}
	calls    map[modelgateway.Role]int
	requests map[modelgateway.Role][]string
	server   *httptest.Server
}

func newChatServer(t *testing.T, replies map[modelgateway.Role][]string) *chatServer {
	t.Helper()
	fake := &chatServer{
		replies: map[modelgateway.Role][]string{}, statuses: map[modelgateway.Role]int{}, delays: map[modelgateway.Role]time.Duration{},
		gates: map[modelgateway.Role]chan struct{}{}, calls: map[modelgateway.Role]int{}, requests: map[modelgateway.Role][]string{},
	}
	for role, list := range replies {
		fake.replies[role] = append([]string(nil), list...)
	}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(fake.server.Close)
	return fake
}

func (fake *chatServer) handle(response http.ResponseWriter, request *http.Request) {
	var body struct {
		Model    string `json:"model"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
		ResponseFormat *struct {
			Type string `json:"type"`
		} `json:"response_format"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		response.WriteHeader(http.StatusBadRequest)
		return
	}
	var role modelgateway.Role
	for _, candidate := range modelgateway.Roles {
		if body.Model == "berry-"+string(candidate)+"-test" {
			role = candidate
		}
	}
	fake.mu.Lock()
	fake.calls[role]++
	if len(body.Messages) > 0 {
		fake.requests[role] = append(fake.requests[role], body.Messages[0].Content)
	}
	delay, gate, status := fake.delays[role], fake.gates[role], fake.statuses[role]
	var reply string
	hasReply := len(fake.replies[role]) > 0
	if hasReply {
		reply = fake.replies[role][0]
		fake.replies[role] = fake.replies[role][1:]
	}
	fake.mu.Unlock()
	if body.ResponseFormat == nil || body.ResponseFormat.Type != "json_object" {
		response.WriteHeader(http.StatusBadRequest)
		return
	}
	if gate != nil {
		select {
		case <-gate:
		case <-request.Context().Done():
			return
		}
	}
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-request.Context().Done():
			return
		}
	}
	if status != 0 {
		response.WriteHeader(status)
		return
	}
	if !hasReply {
		response.WriteHeader(http.StatusInternalServerError)
		return
	}
	encoded, _ := json.Marshal(reply)
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("X-Request-Id", "req_"+string(role))
	_, _ = io.WriteString(response, `{"object":"chat.completion","choices":[{"message":{"role":"assistant","content":`+string(encoded)+`}}],"usage":{"prompt_tokens":120,"completion_tokens":80}}`)
}

func (fake *chatServer) count(role modelgateway.Role) int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.calls[role]
}

func (fake *chatServer) request(role modelgateway.Role, index int) string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if index >= len(fake.requests[role]) {
		return ""
	}
	return fake.requests[role][index]
}

// fixture is one recorded scenario under testdata/planner.
type fixture struct {
	Name       string `json:"name"`
	Category   string `json:"category"`
	UserPrompt string `json:"userPrompt"`
	Hint       string `json:"hint"`
	Context    struct {
		Workspace struct {
			Name        string `json:"name"`
			IssuePrefix string `json:"issuePrefix"`
		} `json:"workspace"`
		ActorRole string `json:"actorRole"`
		Agents    []struct {
			ID           uuid.UUID `json:"id"`
			Name         string    `json:"name"`
			Skills       []string  `json:"skills"`
			Tools        []string  `json:"tools"`
			Status       string    `json:"status"`
			ActiveRuns   int       `json:"activeRuns"`
			Orchestrator bool      `json:"orchestrator"`
		} `json:"agents"`
		Tools []struct {
			Provider           string   `json:"provider"`
			Operation          string   `json:"operation"`
			Kind               string   `json:"kind"`
			Effect             string   `json:"effect"`
			Description        string   `json:"description"`
			ConnectionRequired bool     `json:"connectionRequired"`
			RequiresApproval   bool     `json:"requiresApproval"`
			RequiredInputs     []string `json:"requiredInputs"`
			Inputs             []string `json:"inputs"`
			Outputs            []string `json:"outputs"`
		} `json:"tools"`
		Connections    []string `json:"connections"`
		ExistingIssues []struct {
			Identifier string `json:"identifier"`
			Title      string `json:"title"`
			Status     string `json:"status"`
		} `json:"existingIssues"`
		ExistingWorkflows []struct {
			Name             string   `json:"name"`
			Status           string   `json:"status"`
			TriggerType      string   `json:"triggerType"`
			TriggerProvider  string   `json:"triggerProvider"`
			TriggerOperation string   `json:"triggerOperation"`
			TriggerEvent     string   `json:"triggerEvent"`
			Actions          []string `json:"actions"`
		} `json:"existingWorkflows"`
		Members []uuid.UUID `json:"members"`
	} `json:"context"`
	ModelReplies struct {
		Intent  string   `json:"intent"`
		Planner []string `json:"planner"`
		Repair  []string `json:"repair"`
		Critic  []string `json:"critic"`
	} `json:"modelReplies"`
	Expected struct {
		GenerationStatus    string            `json:"generationStatus"`
		GenerationError     string            `json:"generationError"`
		ValidationStatus    string            `json:"validationStatus"`
		IssueCount          *countRange       `json:"issueCount"`
		WorkflowCount       *int              `json:"workflowCount"`
		ApprovalCount       *int              `json:"approvalCount"`
		ValidationErrors    []string          `json:"validationErrors"`
		ValidationWarnings  []string          `json:"validationWarnings"`
		RequiredConnections []string          `json:"requiredConnections"`
		Blocking            *bool             `json:"blocking"`
		Classification      map[string]string `json:"classification"`
		ApprovalsProtect    []string          `json:"approvalsProtect"`
		ReusesExisting      *bool             `json:"reusesExisting"`
		RepairedWithin      *int              `json:"repairedWithin"`
		AgentsBySkill       map[string]string `json:"agentsBySkill"`
		Versions            *int              `json:"versions"`
		ConfidenceMax       *float64          `json:"confidenceMax"`
	} `json:"expectedProperties"`
}

// countRange is {"min", "max"} or a plain number.
type countRange struct{ Min, Max int }

func (bounds *countRange) UnmarshalJSON(raw []byte) error {
	var single int
	if err := json.Unmarshal(raw, &single); err == nil {
		bounds.Min, bounds.Max = single, single
		return nil
	}
	var object struct {
		Min int `json:"min"`
		Max int `json:"max"`
	}
	if err := json.Unmarshal(raw, &object); err != nil {
		return err
	}
	bounds.Min, bounds.Max = object.Min, object.Max
	return nil
}

func loadFixture(t *testing.T, name string) fixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "planner", name+".json"))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	var loaded fixture
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatalf("decode fixture %s: %v", name, err)
	}
	return loaded
}

func fixtureNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join("testdata", "planner"))
	if err != nil {
		t.Fatalf("list fixtures: %v", err)
	}
	var names []string
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".json" {
			names = append(names, entry.Name()[:len(entry.Name())-len(".json")])
		}
	}
	sort.Strings(names)
	return names
}

// fixtureProvider registers a fixture's tools for one provider so the real
// registry and catalog answer for them.
type fixtureProvider struct {
	id    string
	tools []integrationcore.Tool
}

func (provider fixtureProvider) ID() string          { return provider.id }
func (provider fixtureProvider) Name() string        { return provider.id }
func (provider fixtureProvider) Description() string { return provider.id + " (fixture)" }
func (provider fixtureProvider) Tools() []integrationcore.Tool {
	return provider.tools
}
func (provider fixtureProvider) Scopes() []string { return nil }
func (provider fixtureProvider) MCPServer(string) integrationcore.MCPServerConfig {
	return integrationcore.MCPServerConfig{}
}

// fixtureSources answers the context stage from the fixture.
type fixtureSources struct {
	workspace   WorkspaceData
	agents      []validate.Agent
	issues      []validate.ExistingIssue
	workflows   []validate.ExistingWorkflow
	connections []integrationcore.Connection
}

func (sources fixtureSources) Workspace(context.Context, uuid.UUID) (WorkspaceData, error) {
	return sources.workspace, nil
}
func (sources fixtureSources) Agents(context.Context, uuid.UUID) ([]validate.Agent, error) {
	return sources.agents, nil
}
func (sources fixtureSources) OpenIssues(_ context.Context, _ uuid.UUID, limit int) ([]validate.ExistingIssue, error) {
	if len(sources.issues) > limit {
		return sources.issues[:limit], nil
	}
	return sources.issues, nil
}
func (sources fixtureSources) Workflows(context.Context, uuid.UUID) ([]validate.ExistingWorkflow, error) {
	return sources.workflows, nil
}
func (sources fixtureSources) OpenGoals(context.Context, uuid.UUID, int) ([]GoalSummary, error) {
	return []GoalSummary{}, nil
}
func (sources fixtureSources) ListConnections(context.Context, uuid.UUID) ([]integrationcore.Connection, error) {
	return sources.connections, nil
}

func sourcesFor(t *testing.T, loaded fixture, workspaceID uuid.UUID) Sources {
	t.Helper()
	data := fixtureSources{workspace: WorkspaceData{ID: workspaceID, Name: loaded.Context.Workspace.Name, IssuePrefix: loaded.Context.Workspace.IssuePrefix,
		Boards: map[uuid.UUID]bool{}, Projects: map[uuid.UUID]bool{}, Members: map[uuid.UUID]bool{}}}
	for _, member := range loaded.Context.Members {
		data.workspace.Members[member] = true
	}
	for _, agent := range loaded.Context.Agents {
		data.agents = append(data.agents, validate.Agent{ID: agent.ID, Name: agent.Name, Skills: agent.Skills, Tools: agent.Tools, Status: agent.Status, ActiveRuns: agent.ActiveRuns, Orchestrator: agent.Orchestrator})
	}
	for _, issue := range loaded.Context.ExistingIssues {
		data.issues = append(data.issues, validate.ExistingIssue{ID: uuid.New(), Identifier: issue.Identifier, Title: issue.Title, Status: issue.Status})
	}
	for _, workflow := range loaded.Context.ExistingWorkflows {
		data.workflows = append(data.workflows, validate.ExistingWorkflow{ID: uuid.New(), Name: workflow.Name, Status: workflow.Status, TriggerType: workflow.TriggerType,
			TriggerProvider: workflow.TriggerProvider, TriggerOperation: workflow.TriggerOperation, TriggerEvent: workflow.TriggerEvent, Actions: workflow.Actions})
	}
	for _, provider := range loaded.Context.Connections {
		data.connections = append(data.connections, integrationcore.Connection{ID: uuid.New(), WorkspaceID: workspaceID, Provider: provider, Status: integrationcore.StatusConnected})
	}
	registry := integrationcore.NewRegistry()
	byProvider := map[string]*fixtureProvider{}
	var order []string
	for _, tool := range loaded.Context.Tools {
		provider, ok := byProvider[tool.Provider]
		if !ok {
			provider = &fixtureProvider{id: tool.Provider}
			byProvider[tool.Provider] = provider
			order = append(order, tool.Provider)
		}
		input := map[string]any{"type": "object", "properties": map[string]any{}, "required": []any{}}
		for _, name := range tool.Inputs {
			input["properties"].(map[string]any)[name] = map[string]any{"type": "string"}
		}
		for _, name := range tool.RequiredInputs {
			input["required"] = append(input["required"].([]any), name)
		}
		output := map[string]any{"type": "object", "properties": map[string]any{}}
		for _, name := range tool.Outputs {
			output["properties"].(map[string]any)[name] = map[string]any{"type": "string"}
		}
		effect := integrationcore.Effect(tool.Effect)
		if effect == "" {
			effect = integrationcore.EffectWrite
		}
		provider.tools = append(provider.tools, integrationcore.Tool{
			Name: tool.Provider + "." + tool.Operation, Description: tool.Description, InputSchema: input, OutputSchema: output, Effect: effect,
			RequiresApproval: tool.RequiresApproval, Provider: tool.Provider, Kind: integrationcore.ToolKind(tool.Kind), ConnectionRequired: tool.ConnectionRequired,
		})
	}
	for _, id := range order {
		if err := registry.Register(*byProvider[id]); err != nil {
			t.Fatalf("register fixture provider %s: %v", id, err)
		}
	}
	return Sources{Workspace: data, Agents: data, Issues: data, Workflows: data, Goals: data, Connections: data, Registry: registry}
}

type fakeAuthorizer struct{ roles map[uuid.UUID]identity.Role }

func (authorizer fakeAuthorizer) AuthorizeWorkspace(_ context.Context, userID, _ uuid.UUID, permission identity.Permission) (identity.Role, error) {
	role, ok := authorizer.roles[userID]
	if !ok {
		return "", identity.ErrNotFound
	}
	if !role.Allows(permission) {
		return role, identity.ErrForbidden
	}
	return role, nil
}

// harness wires a service around the memory store and the fake chat route.
type harness struct {
	service *Service
	store   *memoryStore
	chat    *chatServer
	actor   uuid.UUID
	viewer  uuid.UUID
	ws      uuid.UUID
	cancel  context.CancelFunc
}

type harnessOption func(*Options)

func newHarness(t *testing.T, loaded fixture, chat *chatServer, options ...harnessOption) *harness {
	t.Helper()
	client, err := openfang.New(chat.server.URL, "", chat.server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("openfang.New() error = %v", err)
	}
	gateway, err := modelgateway.NewOpenFang(client, testRoles(), nil)
	if err != nil {
		t.Fatalf("NewOpenFang() error = %v", err)
	}
	store := newMemoryStore()
	actor, viewer, ws := uuid.New(), uuid.New(), uuid.New()
	role := identity.Role(loaded.Context.ActorRole)
	if role == "" {
		role = identity.RoleMember
	}
	ctx, cancel := context.WithCancel(context.Background())
	opts := Options{
		Gateway: gateway, Store: store, Sources: sourcesFor(t, loaded, ws),
		Authorization: fakeAuthorizer{roles: map[uuid.UUID]identity.Role{actor: role, viewer: identity.RoleViewer}},
		Clock:         time.Now, NewID: uuid.New, WorkerContext: ctx, PlannerVersion: "planner-v1",
		MaxRepairs: 3, MaxCriticRounds: 1, Timeout: 20 * time.Second, ContextBudgetBytes: 48 * 1024, Logger: slog.New(slog.DiscardHandler),
	}
	for _, option := range options {
		option(&opts)
	}
	service, err := New(opts)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer closeCancel()
		_ = service.Close(closeCtx)
		cancel()
	})
	return &harness{service: service, store: store, chat: chat, actor: actor, viewer: viewer, ws: ws, cancel: cancel}
}

func (h *harness) generate(t *testing.T, loaded fixture) plans.PlanHeader {
	t.Helper()
	header, _, err := h.service.Generate(context.Background(), GenerateInput{ActorID: h.actor, WorkspaceID: h.ws, Prompt: loaded.UserPrompt, Hint: Hint(loaded.Hint)})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if header.GenerationStatus != plans.GenerationRunning || header.ID == uuid.Nil {
		t.Fatalf("header = %+v", header)
	}
	return header
}

// wait blocks until the pipeline left the running state.
func (h *harness) wait(t *testing.T, planID uuid.UUID) plans.PlanHeader {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		header, _, _, _ := h.store.snapshot(planID)
		if header.GenerationStatus != plans.GenerationRunning {
			return header
		}
		time.Sleep(10 * time.Millisecond)
	}
	header, _, events, _ := h.store.snapshot(planID)
	t.Fatalf("plan %s still running after %+v", planID, stages(events))
	return header
}

func stages(events []plans.PlannerEvent) []string {
	out := make([]string, 0, len(events))
	for _, event := range events {
		out = append(out, event.Stage+":"+event.Outcome)
	}
	return out
}

func topics(events []ledger.Event) []string {
	out := make([]string, 0, len(events))
	for _, event := range events {
		out = append(out, event.Type)
	}
	return out
}

func replies(loaded fixture) map[modelgateway.Role][]string {
	return map[modelgateway.Role][]string{
		modelgateway.RoleClassifier: {loaded.ModelReplies.Intent},
		modelgateway.RolePlanner:    loaded.ModelReplies.Planner,
		modelgateway.RoleRepair:     loaded.ModelReplies.Repair,
		modelgateway.RoleCritic:     loaded.ModelReplies.Critic,
	}
}

func hasAll(codes []string, want []string) error {
	set := map[string]bool{}
	for _, code := range codes {
		set[code] = true
	}
	for _, code := range want {
		if !set[code] {
			return fmt.Errorf("missing %s in %v", code, codes)
		}
	}
	return nil
}

var _ = errors.Is
