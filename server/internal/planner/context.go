package planner

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	"github.com/laravel42/berry-circle/server/internal/planner/validate"
)

// The context stage is deterministic: it reads the workspace and renders
// exactly what the planner may plan with — never the whole database, never
// a credential — inside a byte budget, and records only ids and counts.

// Bounds of the rendered context (30-planner.md §3).
const (
	MaxContextIssues    = 50
	MaxContextTools     = 60
	MaxContextGoals     = 20
	MaxContextWorkflows = 30
	MaxOpenIssuesRead   = 200
	RepositoryTreeBytes = 8 * 1024
	RepositoryFileBytes = 24 * 1024
	RepositoryMaxFiles  = 6
)

// WorkspaceData is what the workspace source answers.
type WorkspaceData struct {
	ID          uuid.UUID
	Name        string
	IssuePrefix string
	Boards      map[uuid.UUID]bool
	Projects    map[uuid.UUID]bool
	Members     map[uuid.UUID]bool
}

// ProjectData is the project a plan targets, when it targets one.
type ProjectData struct {
	ID          uuid.UUID
	Name        string
	Description string
	Repository  string
}

// GoalSummary is an open goal the planner may reuse.
type GoalSummary struct {
	ID    uuid.UUID `json:"id"`
	Title string    `json:"title"`
}

// Sources are the workspace reads the context stage performs. Every field
// is optional: a nil source contributes nothing, so a deployment without
// integrations or a repository still plans.
type Sources struct {
	Workspace   WorkspaceSource
	Agents      AgentSource
	Issues      IssueSource
	Workflows   WorkflowSource
	Goals       GoalSource
	Project     ProjectSource
	Connections ConnectionSource
	Registry    *integrationcore.Registry
	Code        CodeSource
}

// WorkspaceSource reads the workspace header and its id sets.
type WorkspaceSource interface {
	Workspace(ctx context.Context, workspaceID uuid.UUID) (WorkspaceData, error)
}

// AgentSource lists the workspace's agents for the validator and the model.
type AgentSource interface {
	Agents(ctx context.Context, workspaceID uuid.UUID) ([]validate.Agent, error)
}

// IssueSource lists open issues, newest first, up to a limit.
type IssueSource interface {
	OpenIssues(ctx context.Context, workspaceID uuid.UUID, limit int) ([]validate.ExistingIssue, error)
}

// WorkflowSource lists live workflows with their trigger and action set.
type WorkflowSource interface {
	Workflows(ctx context.Context, workspaceID uuid.UUID) ([]validate.ExistingWorkflow, error)
}

// GoalSource lists open goals.
type GoalSource interface {
	OpenGoals(ctx context.Context, workspaceID uuid.UUID, limit int) ([]GoalSummary, error)
}

// ProjectSource reads one project of the workspace.
type ProjectSource interface {
	Project(ctx context.Context, workspaceID, projectID uuid.UUID) (ProjectData, error)
}

// ConnectionSource lists provider connections; only provider and status
// are read, never a token.
type ConnectionSource interface {
	ListConnections(ctx context.Context, workspaceID uuid.UUID) ([]integrationcore.Connection, error)
}

// CodeSource renders repository context for a request. Best effort: empty
// when the repository cannot be read.
type CodeSource interface {
	Build(ctx context.Context, workspaceID uuid.UUID, repository, title, description string) string
}

// PlanContext is what the planner reads, rendered as JSON in the user
// message. Field order is stable so the same workspace renders the same
// bytes.
type PlanContext struct {
	Workspace         WorkspaceSummary    `json:"workspace"`
	Project           *ProjectSummary     `json:"project"`
	Repository        string              `json:"repository,omitempty"`
	ExistingIssues    []IssueSummary      `json:"existingIssues"`
	ExistingWorkflows []WorkflowSummary   `json:"existingWorkflows"`
	ExistingGoals     []GoalSummary       `json:"existingGoals"`
	Agents            []AgentCandidate    `json:"agents"`
	Tools             []ToolSummary       `json:"tools"`
	Connections       []ConnectionSummary `json:"connections"`
	Policies          []PolicySummary     `json:"policies"`
	Permissions       PermissionSummary   `json:"permissions"`
	Events            []string            `json:"events"`
	Examples          []string            `json:"examples"`
	Hint              string              `json:"hint,omitempty"`
}

// WorkspaceSummary names the workspace.
type WorkspaceSummary struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	IssuePrefix string    `json:"issuePrefix"`
}

// ProjectSummary names the project and its repository.
type ProjectSummary struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Repository  string    `json:"repository,omitempty"`
}

// IssueSummary is an open issue the planner may reference.
type IssueSummary struct {
	ID         uuid.UUID `json:"id"`
	Identifier string    `json:"identifier"`
	Title      string    `json:"title"`
	Status     string    `json:"status"`
}

// WorkflowSummary is a live workflow the planner may extend.
type WorkflowSummary struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Status      string    `json:"status"`
	Trigger     string    `json:"trigger"`
	StepSummary string    `json:"stepSummary"`
}

// AgentAvailability says whether an agent can take work now.
type AgentAvailability struct {
	Eligible   bool `json:"eligible"`
	ActiveRuns int  `json:"activeRuns"`
}

// AgentLimits are the manifest limits the registry surfaces.
type AgentLimits struct {
	MaxTokens           *int64 `json:"maxTokens"`
	MaxLLMTokensPerHour *int64 `json:"maxLLMTokensPerHour"`
}

// AgentCandidate is one agent the planner may assign.
type AgentCandidate struct {
	ID           uuid.UUID         `json:"id"`
	Name         string            `json:"name"`
	Skills       []string          `json:"skills"`
	Tools        []string          `json:"tools"`
	Availability AgentAvailability `json:"availability"`
	CostTier     string            `json:"costTier,omitempty"`
	Limits       AgentLimits       `json:"limits"`
}

// ToolSummary is one registered tool the planner may use.
type ToolSummary struct {
	Name               string   `json:"name"`
	Kind               string   `json:"kind"`
	Description        string   `json:"description"`
	Effect             string   `json:"effect"`
	RequiresApproval   bool     `json:"requiresApproval"`
	ConnectionRequired bool     `json:"connectionRequired"`
	RequiredInputs     []string `json:"requiredInputs"`
	Inputs             []string `json:"inputs"`
	Outputs            []string `json:"outputs"`
}

// ConnectionSummary is a provider link's status — never its token.
type ConnectionSummary struct {
	Provider string `json:"provider"`
	Status   string `json:"status"`
}

// PolicySummary is one destructive-action rule.
type PolicySummary struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Risk        string `json:"risk"`
}

// PermissionSummary is what the requesting person may do.
type PermissionSummary struct {
	ActorRole            string `json:"actorRole"`
	CanActivateHighRisk  bool   `json:"canActivateHighRisk"`
	CanPlan              bool   `json:"canPlan"`
	ApprovalRoleFallback string `json:"approvalRoleFallback"`
}

// ContextDetail is what planner_events records about the context stage:
// ids, names and counts, never content.
type ContextDetail struct {
	IssueIDs        []uuid.UUID `json:"issueIds"`
	WorkflowIDs     []uuid.UUID `json:"workflowIds"`
	AgentIDs        []uuid.UUID `json:"agentIds"`
	ToolNames       []string    `json:"toolNames"`
	RepositoryBytes int         `json:"repositoryBytes"`
	Bytes           int         `json:"bytes"`
	ExampleIDs      []string    `json:"exampleIds"`
	Trimmed         []string    `json:"trimmed"`
}

// Context is the context stage's output: the rendered PlanContext plus the
// workspace facts the validator needs, which are broader than what the
// model sees.
type Context struct {
	Rendered PlanContext
	Detail   ContextDetail

	Workspace         validate.Workspace
	Agents            []validate.Agent
	OpenIssues        []validate.ExistingIssue
	Workflows         []validate.ExistingWorkflow
	Catalog           automation.Catalog
	Permissions       validate.Permissions
	ConnectedProvider map[string]bool
}

// BuildInput is what the context stage needs from the request.
type BuildInput struct {
	WorkspaceID uuid.UUID
	ProjectID   *uuid.UUID
	Intent      ir.IntentAnalysis
	Prompt      string
	Hint        Hint
	Permissions validate.Permissions
	BudgetBytes int
}

// BuildContext assembles the context deterministically. Sources that fail
// contribute nothing rather than failing the plan: a workspace whose
// integrations are unreachable still deserves a plan, with fewer tools.
func BuildContext(ctx context.Context, sources Sources, input BuildInput) (Context, error) {
	out := Context{Permissions: input.Permissions, ConnectedProvider: map[string]bool{}}
	rendered := PlanContext{
		ExistingIssues: []IssueSummary{}, ExistingWorkflows: []WorkflowSummary{}, ExistingGoals: []GoalSummary{},
		Agents: []AgentCandidate{}, Tools: []ToolSummary{}, Connections: []ConnectionSummary{}, Policies: []PolicySummary{},
		Events: append([]string(nil), automation.BerryEventTopics...), Examples: []string{}, Hint: string(input.Hint),
	}
	rendered.Permissions = PermissionSummary{
		ActorRole: input.Permissions.Role, CanActivateHighRisk: input.Permissions.CanActivateHighRisk,
		CanPlan: input.Permissions.CanWrite, ApprovalRoleFallback: "admin",
	}
	for _, policy := range integrationcore.DefaultPolicies() {
		rendered.Policies = append(rendered.Policies, PolicySummary{ID: policy.ID, Description: policy.Description, Risk: policy.Risk})
	}
	terms := input.Intent.Entities()

	out.Workspace = validate.Workspace{ID: input.WorkspaceID}
	if sources.Workspace != nil {
		if data, err := sources.Workspace.Workspace(ctx, input.WorkspaceID); err == nil {
			rendered.Workspace = WorkspaceSummary{ID: data.ID, Name: data.Name, IssuePrefix: data.IssuePrefix}
			out.Workspace.Boards, out.Workspace.Projects, out.Workspace.Members = data.Boards, data.Projects, data.Members
		}
	}
	if rendered.Workspace.ID == uuid.Nil {
		rendered.Workspace.ID = input.WorkspaceID
	}
	var project *ProjectData
	if input.ProjectID != nil && sources.Project != nil {
		if data, err := sources.Project.Project(ctx, input.WorkspaceID, *input.ProjectID); err == nil {
			project = &data
			rendered.Project = &ProjectSummary{ID: data.ID, Name: data.Name, Description: data.Description, Repository: data.Repository}
			out.Workspace.HasProject = true
			out.Workspace.HasRepository = data.Repository != ""
		}
	}
	if project != nil && project.Repository != "" && sources.Code != nil {
		rendered.Repository = sources.Code.Build(ctx, input.WorkspaceID, project.Repository, input.Intent.Goal, strings.Join(terms, " "))
		out.Detail.RepositoryBytes = len(rendered.Repository)
	}

	if sources.Agents != nil {
		if agents, err := sources.Agents.Agents(ctx, input.WorkspaceID); err == nil {
			out.Agents = agents
			for _, agent := range agents {
				if agent.Orchestrator {
					continue
				}
				eligible := (agent.Status == "available" || agent.Status == "busy") && agent.ActiveRuns < 1
				rendered.Agents = append(rendered.Agents, AgentCandidate{
					ID: agent.ID, Name: agent.Name, Skills: nonNil(agent.Skills), Tools: nonNil(agent.Tools),
					Availability: AgentAvailability{Eligible: eligible, ActiveRuns: agent.ActiveRuns}, CostTier: agent.CostTier,
					Limits: AgentLimits{MaxTokens: agent.MaxTokens, MaxLLMTokensPerHour: agent.MaxLLMTokensPerHour},
				})
				out.Detail.AgentIDs = append(out.Detail.AgentIDs, agent.ID)
			}
		}
	}
	if sources.Issues != nil {
		if issues, err := sources.Issues.OpenIssues(ctx, input.WorkspaceID, MaxOpenIssuesRead); err == nil {
			out.OpenIssues = issues
			for _, issue := range issues {
				if len(rendered.ExistingIssues) >= MaxContextIssues {
					break
				}
				if !sharesTerm(issue.Title, terms) {
					continue
				}
				rendered.ExistingIssues = append(rendered.ExistingIssues, IssueSummary{ID: issue.ID, Identifier: issue.Identifier, Title: issue.Title, Status: issue.Status})
				out.Detail.IssueIDs = append(out.Detail.IssueIDs, issue.ID)
			}
		}
	}
	if sources.Workflows != nil {
		if workflows, err := sources.Workflows.Workflows(ctx, input.WorkspaceID); err == nil {
			out.Workflows = workflows
			for _, workflow := range workflows {
				if workflow.Status != "active" || len(rendered.ExistingWorkflows) >= MaxContextWorkflows {
					continue
				}
				rendered.ExistingWorkflows = append(rendered.ExistingWorkflows, WorkflowSummary{
					ID: workflow.ID, Name: workflow.Name, Status: workflow.Status, Trigger: triggerLabel(workflow),
					StepSummary: strings.Join(workflow.Actions, ", "),
				})
				out.Detail.WorkflowIDs = append(out.Detail.WorkflowIDs, workflow.ID)
			}
		}
	}
	if sources.Goals != nil {
		if goals, err := sources.Goals.OpenGoals(ctx, input.WorkspaceID, MaxContextGoals); err == nil {
			rendered.ExistingGoals = goals
		}
	}
	if sources.Connections != nil {
		if connections, err := sources.Connections.ListConnections(ctx, input.WorkspaceID); err == nil {
			for _, connection := range connections {
				rendered.Connections = append(rendered.Connections, ConnectionSummary{Provider: connection.Provider, Status: string(connection.Status)})
				if connection.Status.Usable() {
					out.ConnectedProvider[connection.Provider] = true
				}
			}
		}
	}
	if sources.Registry != nil {
		out.Catalog = integrationcore.NewCatalog(sources.Registry, func(provider string) bool { return out.ConnectedProvider[provider] })
		rendered.Tools = selectTools(sources.Registry, out.ConnectedProvider, terms)
		for _, tool := range rendered.Tools {
			out.Detail.ToolNames = append(out.Detail.ToolNames, tool.Name)
		}
	}
	sort.Slice(rendered.Connections, func(i, j int) bool { return rendered.Connections[i].Provider < rendered.Connections[j].Provider })

	rendered, trimmed, size := fitBudget(rendered, input.BudgetBytes)
	out.Detail.Trimmed = trimmed
	out.Detail.Bytes = size
	out.Rendered = rendered
	out.Detail.IssueIDs = nonNilIDs(idsOf(rendered.ExistingIssues))
	out.Detail.WorkflowIDs = nonNilIDs(out.Detail.WorkflowIDs)
	out.Detail.AgentIDs = nonNilIDs(out.Detail.AgentIDs)
	out.Detail.ToolNames = nonNil(namesOf(rendered.Tools))
	out.Detail.ExampleIDs = []string{}
	return out, nil
}

// fitBudget trims Repository, then ExistingIssues, then Tools — in that
// order — until the rendered context fits the byte budget.
func fitBudget(rendered PlanContext, budget int) (PlanContext, []string, int) {
	trimmed := []string{}
	size := renderedSize(rendered)
	if budget <= 0 || size <= budget {
		return rendered, trimmed, size
	}
	if rendered.Repository != "" {
		rendered.Repository = ""
		trimmed = append(trimmed, "repository")
		size = renderedSize(rendered)
	}
	for size > budget && len(rendered.ExistingIssues) > 0 {
		rendered.ExistingIssues = rendered.ExistingIssues[:len(rendered.ExistingIssues)/2]
		size = renderedSize(rendered)
		if len(trimmed) == 0 || trimmed[len(trimmed)-1] != "existingIssues" {
			trimmed = append(trimmed, "existingIssues")
		}
	}
	for size > budget && len(rendered.Tools) > 0 {
		rendered.Tools = rendered.Tools[:len(rendered.Tools)/2]
		size = renderedSize(rendered)
		if len(trimmed) == 0 || trimmed[len(trimmed)-1] != "tools" {
			trimmed = append(trimmed, "tools")
		}
	}
	return rendered, trimmed, size
}

func renderedSize(rendered PlanContext) int {
	encoded, err := json.Marshal(rendered)
	if err != nil {
		return 0
	}
	return len(encoded)
}

// selectTools picks the registry tools the planner may use: Berry's own,
// every connected provider's, and any provider an entity term names.
func selectTools(registry *integrationcore.Registry, connected map[string]bool, terms []string) []ToolSummary {
	var tools []ToolSummary
	for _, kind := range []integrationcore.ToolKind{integrationcore.ToolTrigger, integrationcore.ToolAction} {
		for _, tool := range registry.ListTools(kind, "") {
			if tool.Provider != "berry" && !connected[tool.Provider] && !providerNamed(tool.Provider, terms) {
				continue
			}
			tools = append(tools, summariseTool(tool))
		}
	}
	sort.SliceStable(tools, func(i, j int) bool {
		if tools[i].Kind != tools[j].Kind {
			return tools[i].Kind == string(integrationcore.ToolTrigger)
		}
		return tools[i].Name < tools[j].Name
	})
	if len(tools) > MaxContextTools {
		tools = tools[:MaxContextTools]
	}
	if tools == nil {
		tools = []ToolSummary{}
	}
	return tools
}

func summariseTool(tool integrationcore.Tool) ToolSummary {
	summary := ToolSummary{
		Name: tool.Name, Kind: string(tool.Kind.Normalized()), Description: tool.Description, Effect: string(tool.Effect),
		RequiresApproval: tool.RequiresApproval, ConnectionRequired: tool.ConnectionRequired,
		RequiredInputs: []string{}, Inputs: []string{}, Outputs: []string{},
	}
	if required, ok := tool.InputSchema["required"].([]any); ok {
		for _, entry := range required {
			if name, ok := entry.(string); ok {
				summary.RequiredInputs = append(summary.RequiredInputs, name)
			}
		}
	}
	summary.Inputs = propertyNames(tool.InputSchema)
	summary.Outputs = propertyNames(tool.OutputSchema)
	return summary
}

func propertyNames(schema map[string]any) []string {
	names := []string{}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return names
	}
	for name := range properties {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func providerNamed(provider string, terms []string) bool {
	normalised := strings.ReplaceAll(provider, "_", " ")
	for _, term := range terms {
		term = strings.ReplaceAll(term, "_", " ")
		if term == "" {
			continue
		}
		if strings.Contains(term, normalised) || strings.Contains(normalised, term) {
			return true
		}
	}
	return false
}

func sharesTerm(title string, terms []string) bool {
	normalised := " " + validate.Normalise(title) + " "
	for _, term := range terms {
		term = validate.Normalise(term)
		if term != "" && strings.Contains(normalised, " "+term+" ") {
			return true
		}
	}
	return false
}

func triggerLabel(workflow validate.ExistingWorkflow) string {
	switch workflow.TriggerType {
	case "integration":
		return workflow.TriggerProvider + "." + workflow.TriggerOperation
	case "berry_event":
		return "berry_event " + workflow.TriggerEvent
	}
	return workflow.TriggerType
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func nonNilIDs(values []uuid.UUID) []uuid.UUID {
	if values == nil {
		return []uuid.UUID{}
	}
	return values
}

func idsOf(issues []IssueSummary) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(issues))
	for _, issue := range issues {
		ids = append(ids, issue.ID)
	}
	return ids
}

func namesOf(tools []ToolSummary) []string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Name)
	}
	return names
}
