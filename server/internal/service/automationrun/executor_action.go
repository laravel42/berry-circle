package automationrun

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
	"github.com/laravel42/berry-circle/server/internal/repository/approvals"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/goals"
)

// berryActions is every action the Berry provider declares, so an operation
// the catalog does not know fails as TOOL_UNKNOWN rather than falling into
// a default branch.
var berryActions = func() map[string]integrationcore.Tool {
	index := map[string]integrationcore.Tool{}
	for _, tool := range (providers.Berry{}).Tools() {
		if tool.Kind.Normalized() == integrationcore.ToolAction {
			index[tool.Operation()] = tool
		}
	}
	return index
}()

// executeAction calls one provider tool. Berry's own tools execute natively
// over the same repositories the routes use; every other provider is
// authorised and audited here but has no native client yet, so it answers
// TOOL_NOT_EXECUTABLE after the gate rather than pretending it ran.
func (runner *Runner) executeAction(ctx context.Context, call stepCall) (automation.StepOutcome, error) {
	action := call.step.Action
	if action == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The action step names no tool.")
	}
	input, err := resolveInput(action.Input, call.scope)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	if action.Provider == providers.ProviderBerry {
		return runner.executeBerryTool(ctx, call, action.Operation, input)
	}
	if runner.options.Registry == nil {
		return automation.StepOutcome{}, stepFailure("TOOL_NOT_EXECUTABLE", "Integrations are not configured.")
	}
	tool, ok := runner.options.Registry.ToolByOperation(action.Provider, action.Operation, integrationcore.ToolAction)
	if !ok {
		return automation.StepOutcome{}, stepFailure("TOOL_UNKNOWN", fmt.Sprintf("No action %s.%s is registered.", action.Provider, action.Operation))
	}
	if !call.approved {
		if runner.options.Authorizer == nil {
			return automation.StepOutcome{}, stepFailure("TOOL_NOT_EXECUTABLE", "Integrations are not configured.")
		}
		exec := integrationcore.ExecutionContext{WorkspaceID: call.run.WorkspaceID, RunID: &call.run.ID}
		if requester, err := actor(call); err == nil {
			exec.UserID = &requester
		}
		decision, err := runner.options.Authorizer.Authorize(ctx, exec, tool)
		if err != nil {
			return automation.StepOutcome{}, wrapFailure("TOOL_AUTHORIZATION_FAILED", "The tool could not be authorised.", err)
		}
		if !decision.Allowed {
			return automation.StepOutcome{}, stepFailure("TOOL_FORBIDDEN", decision.Reason)
		}
		if decision.RequiresApproval || tool.RequiresApproval {
			return runner.requestApproval(ctx, call, approvalRequest{
				Kind:        approvals.KindIntegrationAction,
				Title:       "Allow " + tool.Name,
				Description: tool.Description,
				Approver:    automation.Approver{Type: automation.ApproverRole, Role: "admin"},
				Risk:        riskForEffect(tool.Effect),
			})
		}
	}
	return automation.StepOutcome{}, stepFailure("TOOL_NOT_EXECUTABLE",
		fmt.Sprintf("%s has no native executor yet.", tool.Name))
}

func riskForEffect(effect integrationcore.Effect) approvals.Risk {
	switch effect {
	case integrationcore.EffectDestructive, integrationcore.EffectExternalSideEffect:
		return approvals.RiskHigh
	case integrationcore.EffectRead:
		return approvals.RiskLow
	default:
		return approvals.RiskMedium
	}
}

// executeBerryTool is the native Berry provider (spec §19): thin wrappers
// over the executors and repositories, one semantic path.
func (runner *Runner) executeBerryTool(ctx context.Context, call stepCall, operation string, input map[string]any) (automation.StepOutcome, error) {
	if _, known := berryActions[operation]; !known {
		return automation.StepOutcome{}, stepFailure("TOOL_UNKNOWN", fmt.Sprintf("No action berry.%s is registered.", operation))
	}
	switch operation {
	case "create_issue":
		issue, err := runner.createIssue(ctx, call, issueSpec{
			Title: inputString(input, "title"), Description: inputString(input, "description"),
			BoardID: inputString(input, "boardId"), AssignAgentID: inputString(input, "assignAgentId"),
			Priority: inputString(input, "priority"), GoalID: inputString(input, "goalId"),
		})
		if err != nil {
			return automation.StepOutcome{}, err
		}
		return withIssueLink(succeeded(issueOutput(issue)), issue.ID), nil
	case "update_issue":
		issue, err := runner.resolveIssueRef(ctx, call, input["issue"])
		if err != nil {
			return automation.StepOutcome{}, err
		}
		patch := automation.IssuePatch{}
		for key, target := range map[string]**string{
			"title": &patch.Title, "description": &patch.Description, "status": &patch.Status,
			"priority": &patch.Priority, "assignAgentId": &patch.AssignAgentID,
		} {
			if _, present := input[key]; present {
				value := inputString(input, key)
				*target = &value
			}
		}
		if patch.Empty() {
			return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "The patch changes nothing.")
		}
		updated, err := runner.applyIssuePatch(ctx, call, issue, patch)
		if err != nil {
			return automation.StepOutcome{}, err
		}
		return withIssueLink(succeeded(issueOutput(updated)), updated.ID), nil
	case "assign_issue":
		issue, err := runner.resolveIssueRef(ctx, call, input["issue"])
		if err != nil {
			return automation.StepOutcome{}, err
		}
		assigneeID, ok := inputUUID(input, "assigneeId")
		if !ok {
			return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "assigneeId is a UUID.")
		}
		assigneeType := inputString(input, "assigneeType")
		if assigneeType == "" {
			assigneeType = "agent"
		}
		if assigneeType == "agent" {
			if _, err := runner.resolveAgentID(ctx, call, assigneeID.String()); err != nil {
				return automation.StepOutcome{}, err
			}
		} else if assigneeType != "user" {
			return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "assigneeType is user or agent.")
		}
		editor, err := actor(call)
		if err != nil {
			return automation.StepOutcome{}, err
		}
		updated, err := runner.updateIssue(ctx, issue.ID, core.IssuePatch{AssigneeSet: true, Assignee: &core.AssigneeInput{Type: assigneeType, ID: assigneeID}}, editor)
		if err != nil {
			return automation.StepOutcome{}, err
		}
		return withIssueLink(succeeded(issueOutput(updated)), updated.ID), nil
	case "move_issue":
		issue, err := runner.resolveIssueRef(ctx, call, input["issue"])
		if err != nil {
			return automation.StepOutcome{}, err
		}
		status := inputString(input, "status")
		updated, err := runner.applyIssuePatch(ctx, call, issue, automation.IssuePatch{Status: &status})
		if err != nil {
			return automation.StepOutcome{}, err
		}
		return withIssueLink(succeeded(issueOutput(updated)), updated.ID), nil
	case "complete_issue":
		// The human review gate stays: only a reviewed issue can be closed.
		issue, err := runner.resolveIssueRef(ctx, call, input["issue"])
		if err != nil {
			return automation.StepOutcome{}, err
		}
		if issue.Status != "in_review" {
			return automation.StepOutcome{}, stepFailure("ISSUE_NOT_IN_REVIEW", "Only an issue in review can be completed.")
		}
		status := "done"
		updated, err := runner.applyIssuePatch(ctx, call, issue, automation.IssuePatch{Status: &status})
		if err != nil {
			return automation.StepOutcome{}, err
		}
		return withIssueLink(succeeded(issueOutput(updated)), updated.ID), nil
	case "get_issue":
		issue, err := runner.resolveIssueRef(ctx, call, input["issue"])
		if err != nil {
			return automation.StepOutcome{}, err
		}
		return withIssueLink(succeeded(issueOutput(issue)), issue.ID), nil
	case "add_comment":
		issue, err := runner.resolveIssueRef(ctx, call, input["issue"])
		if err != nil {
			return automation.StepOutcome{}, err
		}
		author, err := actor(call)
		if err != nil {
			return automation.StepOutcome{}, err
		}
		body := strings.TrimSpace(inputString(input, "body"))
		if body == "" {
			return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "The comment has no body.")
		}
		comment, event, err := runner.options.Issues.CreateComment(ctx, core.CreateCommentParams{
			ID: runner.options.NewID(), IssueID: issue.ID, AuthorType: "user", AuthorID: author, Body: body, CreatedAt: runner.now(),
		}, runner.options.NewID())
		if err != nil {
			return automation.StepOutcome{}, wrapFailure("COMMENT_FAILED", "The comment could not be written.", err)
		}
		runner.publishComment(ctx, event)
		return withIssueLink(succeeded(map[string]any{"commentId": comment.ID.String(), "issueId": issue.ID.String()}), issue.ID), nil
	case "request_approval":
		approver := automation.Approver{Type: automation.ApproverRole, Role: inputString(input, "approverRole")}
		if userID := inputString(input, "approverUserId"); userID != "" {
			approver = automation.Approver{Type: automation.ApproverUser, UserID: userID}
		} else if approver.Role == "" {
			approver.Role = "admin"
		}
		return runner.requestApproval(ctx, call, approvalRequest{
			Kind: approvals.KindAutomationStep, Title: inputString(input, "title"), Description: inputString(input, "description"),
			Approver: approver, Timeout: inputString(input, "timeout"),
		})
	case "wait_for_approval":
		if runner.options.Approvals == nil {
			return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Approvals are not configured.")
		}
		approvalID, ok := inputUUID(input, "approvalId")
		if !ok {
			return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "approvalId is a UUID.")
		}
		approval, err := runner.options.Approvals.Get(ctx, approvalID)
		if err != nil || approval.WorkspaceID != call.run.WorkspaceID {
			return automation.StepOutcome{}, stepFailure("APPROVAL_NOT_FOUND", "The approval is not in this workspace.")
		}
		switch approval.Status {
		case approvals.StatusApproved:
			return succeeded(map[string]any{"approvalId": approval.ID, "decision": "approved"}), nil
		case approvals.StatusRejected:
			return automation.StepOutcome{}, stepFailure("APPROVAL_REJECTED", "The approval was rejected.")
		case approvals.StatusExpired:
			return automation.StepOutcome{}, stepFailure("APPROVAL_EXPIRED", "The approval expired before anyone decided.")
		}
		outcome := waiting("approval:"+approval.ID.String(), map[string]any{"approvalId": approval.ID})
		outcome.Links.ApprovalID = &approval.ID
		return outcome, nil
	case "run_agent":
		issue, err := runner.resolveIssueRef(ctx, call, input["issue"])
		if err != nil {
			return automation.StepOutcome{}, err
		}
		agent, err := runner.resolveAgentID(ctx, call, inputString(input, "agentId"))
		if err != nil {
			return automation.StepOutcome{}, err
		}
		return runner.admitRun(ctx, call, issue.ID, agent.ID, inputString(input, "instructions"))
	case "wait_for_agent":
		if runner.options.IssueRuns == nil {
			return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Issue runs are not configured.")
		}
		runID, ok := inputUUID(input, "runId")
		if !ok {
			return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "runId is a UUID.")
		}
		run, err := runner.options.IssueRuns.Get(ctx, runID)
		if err != nil || run.WorkspaceID != call.run.WorkspaceID {
			return automation.StepOutcome{}, stepFailure("AGENT_RUN_NOT_FOUND", "The run is not in this workspace.")
		}
		if run.Terminal() {
			return runner.runOutcome(ctx, run.ID)
		}
		outcome := waiting("run:"+run.ID.String(), map[string]any{"runId": run.ID, "issueId": run.IssueID})
		outcome.Links.IssueRunID = &run.ID
		outcome.Links.IssueID = &run.IssueID
		return outcome, nil
	case "ask_agent":
		spec := agentSpec{AgentID: inputString(input, "agentId"), Instruction: inputString(input, "instruction")}
		if raw, ok := input["input"].(map[string]any); ok {
			encoded, _ := json.Marshal(raw)
			spec.Input = map[string]json.RawMessage{"input": encoded}
		}
		if schema, ok := input["outputSchema"].(map[string]any); ok {
			spec.OutputSchema, _ = json.Marshal(schema)
		} else if text := inputString(input, "outputSchema"); text != "" && json.Valid([]byte(text)) {
			spec.OutputSchema = json.RawMessage(text)
		}
		return runner.askAgent(ctx, call, spec)
	case "create_goal":
		return runner.createGoal(ctx, call, input)
	case "update_goal":
		return runner.updateGoal(ctx, call, input)
	case "get_goal":
		if runner.options.Goals == nil {
			return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Goals are not configured.")
		}
		goalID, ok := inputUUID(input, "goalId")
		if !ok {
			return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "goalId is a UUID.")
		}
		goal, err := runner.options.Goals.Get(ctx, goalID)
		if err != nil || goal.WorkspaceID != call.run.WorkspaceID {
			return automation.StepOutcome{}, stepFailure("GOAL_NOT_FOUND", "The goal is not in this workspace.")
		}
		output := goalOutput(goal)
		if progress, err := runner.options.Goals.Progress(ctx, goal.ID); err == nil {
			output["progress"] = map[string]any{
				"issuesTotal": progress.IssuesTotal, "issuesDone": progress.IssuesDone, "issuesCancelled": progress.IssuesCancelled,
				"workflowsActive": progress.AutomationsActive, "approvalsPending": progress.ApprovalsPending,
			}
		}
		return succeeded(output), nil
	case "search_issues":
		return runner.searchIssues(ctx, call, input)
	default:
		return automation.StepOutcome{}, stepFailure("TOOL_NOT_EXECUTABLE", fmt.Sprintf("berry.%s has no native executor yet.", operation))
	}
}

func (runner *Runner) createGoal(ctx context.Context, call stepCall, input map[string]any) (automation.StepOutcome, error) {
	if runner.options.Goals == nil {
		return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Goals are not configured.")
	}
	creator, err := actor(call)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	title := strings.TrimSpace(inputString(input, "title"))
	if title == "" {
		return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "The goal has no title.")
	}
	params := goals.CreateParams{
		ID: runner.options.NewID(), WorkspaceID: call.run.WorkspaceID, Title: bounded(title),
		Status: goals.StatusDraft, Source: goals.SourceManual, CreatedBy: creator, CreatedAt: runner.now(), NewID: runner.options.NewID,
	}
	if description := inputString(input, "description"); description != "" {
		params.Description = &description
	}
	if projectID, ok := inputUUID(input, "projectId"); ok {
		params.ProjectID = &projectID
	}
	goal, event, err := runner.options.Goals.Create(ctx, params)
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("GOAL_CREATE_FAILED", "The goal could not be created.", err)
	}
	runner.publish(ctx, event)
	return succeeded(goalOutput(goal)), nil
}

func (runner *Runner) updateGoal(ctx context.Context, call stepCall, input map[string]any) (automation.StepOutcome, error) {
	if runner.options.Goals == nil {
		return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Goals are not configured.")
	}
	editor, err := actor(call)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	goalID, ok := inputUUID(input, "goalId")
	if !ok {
		return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "goalId is a UUID.")
	}
	goal, err := runner.options.Goals.Get(ctx, goalID)
	if err != nil || goal.WorkspaceID != call.run.WorkspaceID {
		return automation.StepOutcome{}, stepFailure("GOAL_NOT_FOUND", "The goal is not in this workspace.")
	}
	patch := goals.Patch{}
	if _, present := input["title"]; present {
		title := strings.TrimSpace(inputString(input, "title"))
		patch.Title = &title
	}
	if _, present := input["description"]; present {
		description := inputString(input, "description")
		patch.DescriptionSet = true
		patch.Description = &description
	}
	if !patch.Empty() {
		updated, event, err := runner.options.Goals.Update(ctx, goal.ID, patch, editor, runner.now(), runner.options.NewID)
		if err != nil {
			return automation.StepOutcome{}, wrapFailure("GOAL_UPDATE_FAILED", "The goal could not be updated.", err)
		}
		runner.publish(ctx, event)
		goal = updated
	}
	if status := goals.Status(inputString(input, "status")); status != "" {
		if !status.Valid() {
			return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "status is not a goal status.")
		}
		moved, event, err := runner.options.Goals.Transition(ctx, goal.ID, status, &editor, runner.now(), runner.options.NewID)
		if err != nil {
			return automation.StepOutcome{}, wrapFailure("GOAL_TRANSITION_INVALID", "The goal cannot move to "+string(status)+".", err)
		}
		runner.publish(ctx, event)
		goal = moved
	}
	return succeeded(goalOutput(goal)), nil
}

func (runner *Runner) searchIssues(ctx context.Context, call stepCall, input map[string]any) (automation.StepOutcome, error) {
	if runner.options.Issues == nil || runner.options.Boards == nil {
		return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Issues are not configured.")
	}
	boardID, err := runner.resolveBoard(ctx, call, inputString(input, "boardId"))
	if err != nil {
		return automation.StepOutcome{}, err
	}
	filter := core.IssueListFilter{BoardID: boardID, Limit: 50}
	if query := strings.TrimSpace(inputString(input, "query")); query != "" {
		filter.Query = &query
	}
	if status := inputString(input, "status"); status != "" {
		storage, ok := wireToStorageStatus[status]
		if !ok {
			return automation.StepOutcome{}, stepFailure("INPUT_INVALID", "status is not an issue status.")
		}
		filter.Statuses = []string{storage}
	}
	if assigneeID, ok := inputUUID(input, "assigneeId"); ok {
		filter.Assignee = &core.AssigneeInput{Type: "agent", ID: assigneeID}
	}
	issues, err := runner.options.Issues.ListIssues(ctx, filter)
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("ISSUE_SEARCH_FAILED", "Issues could not be listed.", err)
	}
	results := make([]map[string]any, 0, len(issues))
	for _, issue := range issues {
		results = append(results, issueOutput(issue))
	}
	return succeeded(map[string]any{"issues": results, "count": len(results)}), nil
}

func goalOutput(goal goals.Goal) map[string]any {
	output := map[string]any{
		"id": goal.ID.String(), "title": goal.Title, "status": string(goal.Status), "source": string(goal.Source),
	}
	if goal.Description != nil {
		output["description"] = *goal.Description
	}
	if goal.ProjectID != nil {
		output["projectId"] = goal.ProjectID.String()
	}
	return output
}

func withIssueLink(outcome automation.StepOutcome, issueID uuid.UUID) automation.StepOutcome {
	outcome.Links.IssueID = &issueID
	return outcome
}
