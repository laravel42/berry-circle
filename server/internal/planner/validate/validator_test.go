package validate

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
)

type fakeCatalog struct {
	tools     map[string]automation.ToolSpec
	connected map[string]bool
}

func (catalog fakeCatalog) Tool(provider, operation string, kind automation.ToolKind) (automation.ToolSpec, bool) {
	spec, ok := catalog.tools[provider+"."+operation+":"+string(kind)]
	return spec, ok
}

func (catalog fakeCatalog) Connected(provider string) bool { return catalog.connected[provider] }

func testCatalog() fakeCatalog {
	return fakeCatalog{
		tools: map[string]automation.ToolSpec{
			"stripe.payment_succeeded:trigger": {Provider: "stripe", Operation: "payment_succeeded", Kind: automation.ToolTrigger, ConnectionRequired: true},
			"google_sheets.add_row:action":     {Provider: "google_sheets", Operation: "add_row", Kind: automation.ToolAction, ConnectionRequired: true, InputSchema: map[string]any{"required": []any{"spreadsheetId", "values"}}},
			"gmail.send_message:action":        {Provider: "gmail", Operation: "send_message", Kind: automation.ToolAction, ConnectionRequired: true, RequiresApproval: true},
			"slack.post_message:action":        {Provider: "slack", Operation: "post_message", Kind: automation.ToolAction, ConnectionRequired: true},
			"berry.add_comment:action":         {Provider: "berry", Operation: "add_comment", Kind: automation.ToolAction},
		},
		connected: map[string]bool{"slack": true},
	}
}

var (
	coder        = uuid.MustParse("11111111-1111-4111-8111-111111111111")
	designer     = uuid.MustParse("22222222-2222-4222-8222-222222222222")
	orchestrator = uuid.MustParse("33333333-3333-4333-8333-333333333333")
	member       = uuid.MustParse("44444444-4444-4444-8444-444444444444")
	stranger     = uuid.MustParse("55555555-5555-4555-8555-555555555555")
	boardID      = uuid.MustParse("66666666-6666-4666-8666-666666666666")
	projectID    = uuid.MustParse("77777777-7777-4777-8777-777777777777")
)

func lowCap() *int64 { value := int64(20_000); return &value }

func baseInput(plan string) Input {
	parsed, err := ir.Parse([]byte(plan))
	if err != nil {
		panic(err)
	}
	return Input{
		Plan:    parsed,
		Catalog: testCatalog(),
		Workspace: Workspace{
			ID: uuid.New(), Boards: map[uuid.UUID]bool{boardID: true}, Projects: map[uuid.UUID]bool{projectID: true},
			Members: map[uuid.UUID]bool{member: true}, HasProject: true, HasRepository: true,
		},
		Agents: []Agent{
			{ID: coder, Name: "Coder", Skills: []string{"backend", "frontend"}, Tools: []string{"file_write"}, Status: "available"},
			{ID: designer, Name: "Designer", Skills: []string{"design"}, Status: "offline", MaxLLMTokensPerHour: lowCap()},
			{ID: orchestrator, Name: "Orchestrator", Status: "available", Orchestrator: true},
		},
		ExistingIssues:    []ExistingIssue{{ID: uuid.New(), Identifier: "PLN-7", Title: "Deploy the site to production", Status: "todo"}},
		ExistingWorkflows: []ExistingWorkflow{{ID: uuid.New(), Name: "Process donations", Status: "active", TriggerType: "integration", TriggerProvider: "stripe", TriggerOperation: "payment_succeeded", Actions: []string{"google_sheets.add_row"}}},
		Permissions:       Permissions{Role: "member", CanWrite: true, Known: true},
	}
}

const head = `{"$schema":"berry-plan/1","version":"1","goal":{"tempId":"g_x","title":"Ship it"},`

func plan(body string) string { return head + body + `,"confidence":0.8}` }

func codes(report Report) map[string]int {
	out := map[string]int{}
	for _, item := range report.Findings() {
		out[item.Code]++
	}
	return out
}

func severity(report Report, code string) automation.Severity {
	for _, item := range report.Findings() {
		if item.Code == code {
			return item.Severity
		}
	}
	return ""
}

func pathOf(report Report, code string) string {
	for _, item := range report.Findings() {
		if item.Code == code {
			return item.Path
		}
	}
	return ""
}

// One table row per rule: the plan that trips it, the severity expected,
// and the path the finding lands on.
func TestEveryRuleFiresAtItsPath(t *testing.T) {
	cases := map[string]struct {
		body     string
		mutate   func(input *Input)
		code     string
		severity automation.Severity
		path     string
	}{
		"AMBIGUITY_BLOCKING": {
			body: `"assumptions":[{"id":"a_1","description":"Which vendor?","confidence":"low","userEditable":true,"blocking":true}],"issues":[{"tempId":"i_1","title":"Pay vendor","type":"issue","requiresApproval":true}]`,
			code: CodeAmbiguityBlocking, severity: automation.SeverityError, path: "/assumptions/0",
		},
		"AGENT_UNKNOWN": {
			body: `"issues":[{"tempId":"i_1","title":"Build","type":"issue","suggestedAgentId":"` + stranger.String() + `"}]`,
			code: CodeAgentUnknown, severity: automation.SeverityError, path: "/issues/0/suggestedAgentId",
		},
		"AGENT_ORCHESTRATOR_SUGGESTED": {
			body: `"issues":[{"tempId":"i_1","title":"Build","type":"issue","suggestedAgentId":"` + orchestrator.String() + `"}]`,
			code: CodeAgentOrchestratorSuggested, severity: automation.SeverityError, path: "/issues/0/suggestedAgentId",
		},
		"AGENT_CAPABILITY_MISSING": {
			body: `"issues":[{"tempId":"i_1","title":"Build","type":"issue","suggestedAgentId":"` + coder.String() + `","requiredCapabilities":["backend","devops"]}]`,
			code: CodeAgentCapabilityMissing, severity: automation.SeverityWarning, path: "/issues/0/suggestedAgentId",
		},
		"AGENT_UNAVAILABLE": {
			body: `"issues":[{"tempId":"i_1","title":"Design","type":"issue","suggestedAgentId":"` + designer.String() + `","requiredCapabilities":["design"]}]`,
			code: CodeAgentUnavailable, severity: automation.SeverityWarning, path: "/issues/0/suggestedAgentId",
		},
		"AGENT_HOURLY_CAP": {
			body: `"issues":[{"tempId":"i_1","title":"Design","type":"issue","suggestedAgentId":"` + designer.String() + `"}]`,
			code: CodeAgentHourlyCap, severity: automation.SeverityWarning, path: "/issues/0/suggestedAgentId",
		},
		"AGENT_REPOSITORY_ACCESS": {
			body:   `"issues":[{"tempId":"i_1","title":"Refactor the auth module in the repository","type":"issue"}]`,
			mutate: func(input *Input) { input.Workspace.HasRepository = false },
			code:   CodeAgentRepositoryAccess, severity: automation.SeverityWarning, path: "/issues/0",
		},
		"AGENT_STEP_SHOULD_BE_ISSUE": {
			body: `"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"a","type":"agent","instruction":"Implement the feature and open a pull request"}],"entry":["a"]}]`,
			code: CodeAgentStepShouldBeIssue, severity: automation.SeverityWarning, path: "/workflows/0/steps/0",
		},
		"AGENT_UNKNOWN in agent step": {
			body: `"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"a","type":"agent","agentId":"` + stranger.String() + `","instruction":"Summarise"}],"entry":["a"]}]`,
			code: CodeAgentUnknown, severity: automation.SeverityError, path: "/workflows/0/steps/0/agentId",
		},
		"DESTRUCTIVE_WITHOUT_APPROVAL issue": {
			body: `"issues":[{"tempId":"i_1","title":"Deploy the site to production","type":"issue"}]`,
			code: CodeDestructiveWithoutApproval, severity: automation.SeverityError, path: "/issues/0",
		},
		"DESTRUCTIVE_WITHOUT_APPROVAL action": {
			body: `"requiredConnections":[{"provider":"gmail","purpose":"thank donors","connected":false}],"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"mail","type":"action","provider":"gmail","operation":"send_message","input":{"to":"x"}}],"entry":["mail"]}]`,
			code: "DESTRUCTIVE_WITHOUT_APPROVAL", severity: automation.SeverityError, path: "/workflows/0/steps/0",
		},
		"CREDENTIAL_LEAK": {
			body: `"issues":[{"tempId":"i_1","title":"Wire Stripe","type":"issue","description":"Use sk_live_51HqRz2Lx9ABCDEF for the checkout"}]`,
			code: CodeCredentialLeak, severity: automation.SeverityError, path: "/issues/0/description",
		},
		"CREDENTIAL_LEAK in step input": {
			body: `"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"c","type":"action","provider":"berry","operation":"add_comment","input":{"token":"ghp_abcdefghijklmnopqrstuvwxyz0123"}}],"entry":["c"]}]`,
			code: CodeCredentialLeak, severity: automation.SeverityError, path: "/workflows/0/steps/0/input",
		},
		"CONNECTION_MISSING undeclared is an error": {
			body: `"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"integration","provider":"stripe","operation":"payment_succeeded"},"steps":[{"id":"c","type":"action","provider":"berry","operation":"add_comment","input":{}}],"entry":["c"]}]`,
			code: "CONNECTION_MISSING", severity: automation.SeverityError, path: "/workflows/0/trigger/provider",
		},
		"CONNECTION_MISSING declared is a warning": {
			body: `"requiredConnections":[{"provider":"stripe","purpose":"payments","connected":false}],"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"integration","provider":"stripe","operation":"payment_succeeded"},"steps":[{"id":"c","type":"action","provider":"berry","operation":"add_comment","input":{}}],"entry":["c"]}]`,
			code: "CONNECTION_MISSING", severity: automation.SeverityWarning, path: "/workflows/0/trigger/provider",
		},
		"PLAN_FORBIDDEN": {
			body:   `"issues":[{"tempId":"i_1","title":"Build","type":"issue"}]`,
			mutate: func(input *Input) { input.Permissions = Permissions{Role: "viewer", Known: true} },
			code:   CodePlanForbidden, severity: automation.SeverityError, path: "",
		},
		"NEEDS_ADMIN_ACTIVATION": {
			body: `"issues":[{"tempId":"i_1","title":"Deploy to production","type":"issue","requiresApproval":true}]`,
			code: CodeNeedsAdminActivation, severity: automation.SeverityWarning, path: "",
		},
		"SCOPE_INVALID project": {
			body: strings.Replace(`"issues":[{"tempId":"i_1","title":"Build","type":"issue"}]`, `"issues"`, `"issues"`, 1),
			mutate: func(input *Input) {
				id := stranger
				input.Plan.Goal.ProjectID = &id
			},
			code: CodeScopeInvalid, severity: automation.SeverityError, path: "/goal/projectId",
		},
		"SCOPE_INVALID board": {
			body: `"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"c","type":"create_issue","title":"Follow up","boardId":"` + stranger.String() + `"}],"entry":["c"]}]`,
			code: CodeScopeInvalid, severity: automation.SeverityError, path: "/workflows/0/steps/0/boardId",
		},
		"APPROVAL_APPROVER_REQUIRED not a member": {
			body: `"issues":[{"tempId":"i_1","title":"Build","type":"issue"}],"approvals":[{"tempId":"p_1","title":"Go?","reason":"user_requested","target":{"kind":"issue","tempId":"i_1"},"approver":{"type":"user","userId":"` + stranger.String() + `"}}]`,
			code: CodeApprovalApproverReqd, severity: automation.SeverityError, path: "/approvals/0/approver/userId",
		},
		"ISSUE_SIMILAR_EXISTS": {
			body: `"issues":[{"tempId":"i_1","title":"Deploy the site to production!","type":"issue","requiresApproval":true}]`,
			code: CodeIssueSimilarExists, severity: automation.SeverityWarning, path: "/issues/0",
		},
		"WORKFLOW_DUPLICATE": {
			body: `"requiredConnections":[{"provider":"stripe","purpose":"p","connected":false},{"provider":"google_sheets","purpose":"p","connected":false}],"workflows":[{"tempId":"w_1","name":"Donations again","trigger":{"id":"t","type":"integration","provider":"stripe","operation":"payment_succeeded"},"steps":[{"id":"row","type":"action","provider":"google_sheets","operation":"add_row","input":{"spreadsheetId":"x","values":[1]}}],"entry":["row"]}]`,
			code: CodeWorkflowDuplicate, severity: automation.SeverityWarning, path: "/workflows/0",
		},
		"WEBHOOK_PROCESSOR_EXISTS": {
			body: `"requiredConnections":[{"provider":"stripe","purpose":"p","connected":false}],"workflows":[{"tempId":"w_1","name":"Thank donors","trigger":{"id":"t","type":"integration","provider":"stripe","operation":"payment_succeeded"},"steps":[{"id":"c","type":"action","provider":"berry","operation":"add_comment","input":{}}],"entry":["c"]}]`,
			code: CodeWebhookProcessorExist, severity: automation.SeverityWarning, path: "/workflows/0/trigger",
		},
		"DEPLOY_AUTOMATION_EXISTS": {
			body: `"workflows":[{"tempId":"w_1","name":"Deploy to production on merge","trigger":{"id":"t","type":"berry_event","event":"issue.completed"},"steps":[{"id":"c","type":"action","provider":"berry","operation":"add_comment","input":{}}],"entry":["c"]}]`,
			mutate: func(input *Input) {
				input.ExistingWorkflows = append(input.ExistingWorkflows, ExistingWorkflow{Name: "Deploy to production", Status: "active", TriggerType: "berry_event", TriggerEvent: "issue.completed"})
			},
			code: CodeDeployAutomationExist, severity: automation.SeverityWarning, path: "/workflows/0",
		},
		"APPROVAL_REMOVED issue gate": {
			body: `"issues":[{"tempId":"i_1","title":"Deploy to production","type":"issue","requiresApproval":true}]`,
			mutate: func(input *Input) {
				previous, _ := ir.Parse([]byte(plan(`"issues":[{"tempId":"i_1","title":"Deploy to production","type":"issue","requiresApproval":true}]`)))
				input.Plan.Issues[0].RequiresApproval = false
				input.Previous = &previous
			},
			code: CodeApprovalRemoved, severity: automation.SeverityError, path: "/issues/0",
		},
		"APPROVAL_REMOVED policy entry": {
			body: `"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"c","type":"action","provider":"berry","operation":"add_comment","input":{}}],"entry":["c"]}],"approvals":[{"tempId":"p_1","title":"Deploy?","reason":"policy","target":{"kind":"workflow","tempId":"w_1"},"approver":{"type":"role","role":"admin"}}]`,
			mutate: func(input *Input) {
				previous, _ := ir.Parse([]byte(plan(`"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"c","type":"action","provider":"berry","operation":"add_comment","input":{}}],"entry":["c"]}],"approvals":[{"tempId":"p_1","title":"Deploy?","reason":"policy","target":{"kind":"workflow","tempId":"w_1"},"approver":{"type":"role","role":"admin"}}]`)))
				input.Plan.Approvals = nil
				input.Previous = &previous
			},
			code: CodeApprovalRemoved, severity: automation.SeverityError, path: "/approvals",
		},
		"structural DEP_CYCLE surfaces": {
			body: `"issues":[{"tempId":"i_1","title":"a","type":"issue","dependsOn":["i_2"]},{"tempId":"i_2","title":"b","type":"issue","dependsOn":["i_1"]}]`,
			code: "DEP_CYCLE", severity: automation.SeverityError, path: "/issues/0/dependsOn",
		},
		"workflow TOOL_UNKNOWN surfaces with prefix": {
			body: `"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"c","type":"action","provider":"stripe","operation":"refund","input":{}}],"entry":["c"]}]`,
			code: "TOOL_UNKNOWN", severity: automation.SeverityError, path: "/workflows/0/steps/0/operation",
		},
		"INPUT_REQUIRED_MISSING surfaces": {
			body: `"requiredConnections":[{"provider":"google_sheets","purpose":"p","connected":false}],"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"row","type":"action","provider":"google_sheets","operation":"add_row","input":{"values":[1]}}],"entry":["row"]}]`,
			code: "INPUT_REQUIRED_MISSING", severity: automation.SeverityError, path: "/workflows/0/steps/0/input/spreadsheetId",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			input := baseInput(plan(tc.body))
			if tc.mutate != nil {
				tc.mutate(&input)
			}
			report := Validate(input)
			if codes(report)[tc.code] == 0 {
				t.Fatalf("report = %+v, want %s", report.Findings(), tc.code)
			}
			if got := severity(report, tc.code); got != tc.severity {
				t.Fatalf("%s severity = %s, want %s", tc.code, got, tc.severity)
			}
			if got := pathOf(report, tc.code); got != tc.path {
				t.Fatalf("%s path = %q, want %q", tc.code, got, tc.path)
			}
		})
	}
}

// A clean plan validates with no errors; the warnings it carries are the
// ones the workspace state justifies, the connections are reported with
// their live status, risk and admin need are derived, and the report
// encodes the way plan_versions.validation stores it.
func TestValidReportCarriesConnectionsRiskAndJSON(t *testing.T) {
	input := baseInput(plan(`"requiredConnections":[{"provider":"stripe","purpose":"payments","connected":false},{"provider":"slack","purpose":"notify","connected":false}],` +
		`"issues":[{"tempId":"i_build","title":"Build the landing page","type":"issue","suggestedAgentId":"` + coder.String() + `","requiredCapabilities":["frontend"]},` +
		`{"tempId":"i_deploy","title":"Deploy the landing page to production","type":"issue","dependsOn":["i_build"],"requiresApproval":true}],` +
		`"workflows":[{"tempId":"w_notify","name":"Notify","trigger":{"id":"t","type":"integration","provider":"stripe","operation":"payment_succeeded"},"steps":[{"id":"post","type":"action","provider":"slack","operation":"post_message","input":{"channel":"#donations","text":"{{ trigger.amount }}"}}],"entry":["post"]}],` +
		`"approvals":[{"tempId":"p_deploy","title":"Deploy?","reason":"user_requested","target":{"kind":"issue","tempId":"i_deploy"},"approver":{"type":"user","userId":"` + member.String() + `"}}],` +
		`"dependencies":[{"from":"i_deploy","to":"i_build","kind":"blocks"}]`))
	report := Validate(input)
	if !report.Valid() {
		t.Fatalf("errors = %+v", report.Errors)
	}
	if got := codes(report); got["CONNECTION_MISSING"] != 1 || got[CodeNeedsAdminActivation] != 1 || got[CodeWebhookProcessorExist] != 1 {
		t.Fatalf("warnings = %v", got)
	}
	if len(report.RequiredConnections) != 2 || report.RequiredConnections[0].Provider != "stripe" || report.RequiredConnections[0].Connected ||
		!report.RequiredConnections[1].Connected {
		t.Fatalf("required connections = %+v", report.RequiredConnections)
	}
	if report.Risk != automation.RiskHigh || !report.NeedsAdminActivation {
		t.Fatalf("risk = %s admin = %v", report.Risk, report.NeedsAdminActivation)
	}
	encoded := string(report.JSON())
	for _, want := range []string{`"errors":[]`, `"warnings":[{`, `"requiredConnections":[{"provider":"stripe"`, `"risk":"high"`, `"needsAdminActivation":true`} {
		if !strings.Contains(encoded, want) {
			t.Fatalf("JSON() = %s, missing %s", encoded, want)
		}
	}
	input.Permissions = Permissions{Role: "admin", CanWrite: true, CanActivateHighRisk: true, Known: true}
	if again := Validate(input); again.NeedsAdminActivation || codes(again)[CodeNeedsAdminActivation] != 0 {
		t.Fatal("an admin was told to ask an admin")
	}
	input.Permissions = Permissions{}
	if unknown := Validate(input); codes(unknown)[CodePlanForbidden] != 0 || codes(unknown)[CodeNeedsAdminActivation] != 0 {
		t.Fatal("unknown permissions must skip the permission rules")
	}
}

func TestEmptyPlanIsAWarningUnlessNothingWasClassifiable(t *testing.T) {
	input := baseInput(plan(`"issues":[]`))
	if report := Validate(input); !report.Valid() || codes(report)["PLAN_EMPTY"] != 1 {
		t.Fatalf("empty plan report = %+v", report.Findings())
	}
	input.AllUnknown = true
	if report := Validate(input); codes(report)["PLAN_EMPTY"] != 0 {
		t.Fatal("PLAN_EMPTY reported for an all-unknown intent")
	}
}

func TestBlockedReportsOnlyForBlockingQuestions(t *testing.T) {
	blocked := Validate(baseInput(plan(`"assumptions":[{"id":"a_1","description":"Which account?","confidence":"low","userEditable":true,"blocking":true}]`)))
	if !blocked.Blocked() {
		t.Fatalf("Blocked() = false for %+v", blocked.Errors)
	}
	mixed := Validate(baseInput(plan(`"assumptions":[{"id":"a_1","description":"Which account?","confidence":"low","userEditable":true,"blocking":true}],"issues":[{"tempId":"i_1","title":"Deploy to production","type":"issue"}]`)))
	if mixed.Blocked() || mixed.Valid() {
		t.Fatalf("mixed = blocked %v valid %v", mixed.Blocked(), mixed.Valid())
	}
}

func TestSimilarityAndCredentialHeuristics(t *testing.T) {
	if Similarity("Deploy to production", "Deploy to production.") < SimilarityThreshold {
		t.Fatal("punctuation should not break similarity")
	}
	if Similarity("Design the landing page", "Write the privacy policy") >= SimilarityThreshold {
		t.Fatal("unrelated titles reported similar")
	}
	if Similarity("", "x") != 0 {
		t.Fatal("empty similarity")
	}
	for _, secret := range []string{"sk_live_51HqRz2Lx9ABCDEF", "ghp_abcdefghijklmnopqrstuvwxyz0123", "xoxb-1234567890-abcdefghij", "AKIAIOSFODNN7EXAMPLE",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "0123456789abcdef0123456789abcdef", "api_key = abcdefghijklmnop123456"} {
		if !LooksLikeCredential("value " + secret + " end") {
			t.Errorf("%s not recognised", secret)
		}
	}
	for _, text := range []string{"Use the workspace Stripe connection", "spreadsheetId from connections.google_sheets.spreadsheetId", "Issue 11111111-1111-4111-8111-111111111111 is done"} {
		if LooksLikeCredential(text) {
			t.Errorf("%q flagged", text)
		}
	}
}
