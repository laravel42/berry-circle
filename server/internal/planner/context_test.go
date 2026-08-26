package planner

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	"github.com/laravel42/berry-circle/server/internal/planner/validate"
	"github.com/laravel42/berry-circle/server/internal/repository/plans"
)

type codeSource struct{ text string }

func (source codeSource) Build(context.Context, uuid.UUID, string, string, string) string {
	return source.text
}

type projectSource struct{ data ProjectData }

func (source projectSource) Project(context.Context, uuid.UUID, uuid.UUID) (ProjectData, error) {
	return source.data, nil
}

// The context stage selects by entity term, renders ids and counts into the
// stage record, and trims repository, then issues, then tools — in that
// order — until the rendered JSON fits the budget.
func TestBuildContextSelectsAndTrimsToBudget(t *testing.T) {
	loaded := loadFixture(t, "donation-golden")
	ws := uuid.New()
	sources := sourcesFor(t, loaded, ws)
	data := sources.Issues.(fixtureSources)
	for index := 0; index < 150; index++ {
		data.issues = append(data.issues, validate.ExistingIssue{ID: uuid.New(), Identifier: fmt.Sprintf("BER-%d", 100+index), Title: fmt.Sprintf("Stripe checkout follow-up %d", index), Status: "todo"})
	}
	sources.Issues = data
	projectID := uuid.New()
	sources.Project = projectSource{data: ProjectData{ID: projectID, Name: "Site", Repository: "berry/site"}}
	sources.Code = codeSource{text: strings.Repeat("src/checkout.ts\n", 400)}
	intent, findings := ir.ParseIntentReply(loaded.ModelReplies.Intent)
	if !ir.Valid(findings) {
		t.Fatalf("intent = %+v", findings)
	}
	input := BuildInput{WorkspaceID: ws, ProjectID: &projectID, Intent: intent, Permissions: validate.Permissions{Role: "member", CanWrite: true, Known: true}}

	full, err := BuildContext(context.Background(), sources, input)
	if err != nil {
		t.Fatalf("BuildContext() error = %v", err)
	}
	if len(full.Rendered.ExistingIssues) != MaxContextIssues || len(full.OpenIssues) != 151 || full.Rendered.Repository == "" || full.Rendered.Project == nil ||
		!full.Workspace.HasRepository || len(full.Rendered.Agents) != 4 || len(full.Agents) != 5 || len(full.Detail.Trimmed) != 0 {
		t.Fatalf("full context = issues %d/%d repo %d project %v agents %d/%d trimmed %v", len(full.Rendered.ExistingIssues), len(full.OpenIssues),
			len(full.Rendered.Repository), full.Rendered.Project, len(full.Rendered.Agents), len(full.Agents), full.Detail.Trimmed)
	}
	// The privacy-policy issue shares no entity term and stays out of the model context.
	for _, issue := range full.Rendered.ExistingIssues {
		if issue.Identifier == "BER-3" {
			t.Fatal("unrelated issue rendered")
		}
	}
	names := strings.Join(full.Detail.ToolNames, ",")
	if !strings.Contains(names, "stripe.payment_succeeded") || !strings.Contains(names, "berry.add_comment") || !strings.Contains(names, "google_sheets.add_row") {
		t.Fatalf("tools = %s", names)
	}
	if full.Detail.Bytes != len(mustJSON(full.Rendered)) || full.Detail.RepositoryBytes == 0 {
		t.Fatalf("detail = %+v", full.Detail)
	}

	input.BudgetBytes = 6 * 1024
	trimmed, err := BuildContext(context.Background(), sources, input)
	if err != nil {
		t.Fatalf("BuildContext() error = %v", err)
	}
	if trimmed.Detail.Bytes > input.BudgetBytes {
		t.Fatalf("rendered %d bytes over the %d budget", trimmed.Detail.Bytes, input.BudgetBytes)
	}
	if got := strings.Join(trimmed.Detail.Trimmed, ","); got != "repository,existingIssues" && got != "repository,existingIssues,tools" {
		t.Fatalf("trimmed = %v", trimmed.Detail.Trimmed)
	}
	if trimmed.Rendered.Repository != "" || len(trimmed.Rendered.ExistingIssues) >= MaxContextIssues {
		t.Fatalf("repository or issues survived the trim: %d issues", len(trimmed.Rendered.ExistingIssues))
	}
	if len(trimmed.OpenIssues) != 151 || len(trimmed.Agents) != 5 {
		t.Fatal("the validator's view must not be trimmed")
	}
	// The stage record carries ids and counts only.
	detail := mustJSON(trimmed.Detail)
	if strings.Contains(detail, "Stripe checkout follow-up") || strings.Contains(detail, "Designer") {
		t.Fatalf("context detail leaks content: %s", detail)
	}
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func TestCurrentStageDerivesTheStageInProgress(t *testing.T) {
	cases := []struct {
		stage, outcome, want string
	}{
		{"", "", plans.StageIntent},
		{plans.StageIntent, plans.OutcomeOK, plans.StageContext},
		{plans.StageContext, plans.OutcomeOK, plans.StageGenerate},
		{plans.StageGenerate, plans.OutcomeOK, plans.StageValidate},
		{plans.StageGenerate, plans.OutcomeInvalid, plans.StageRepair},
		{plans.StageValidate, plans.OutcomeInvalid, plans.StageRepair},
		{plans.StageValidate, plans.OutcomeOK, plans.StageCritic},
		{plans.StageRepair, plans.OutcomeOK, plans.StageValidate},
		{plans.StageCritic, plans.OutcomeOK, plans.StageFinalize},
	}
	for _, tc := range cases {
		header := plans.PlanHeader{GenerationStatus: plans.GenerationRunning}
		if tc.stage != "" {
			stage, outcome := tc.stage, tc.outcome
			header.LastStage, header.LastOutcome = &stage, &outcome
		}
		if got := plans.CurrentStage(header); got == nil || *got != tc.want {
			t.Fatalf("CurrentStage(%s:%s) = %v, want %s", tc.stage, tc.outcome, got, tc.want)
		}
	}
	if got := plans.CurrentStage(plans.PlanHeader{GenerationStatus: plans.GenerationSucceeded}); got != nil {
		t.Fatalf("finished plan stage = %v", *got)
	}
}
