package automationrun

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// issueSpec is what a created issue looks like before templates resolve.
type issueSpec struct {
	Title         string
	Description   string
	AssignAgentID string
	Priority      string
	GoalID        string
	BoardID       string
}

var wireToStorageStatus = map[string]string{
	"backlog": "backlog", "todo": "todo", "inProgress": "in_progress", "inReview": "in_review",
	"done": "done", "cancelled": "cancelled", "blocked": "blocked",
	"in_progress": "in_progress", "in_review": "in_review",
}

var storageToWireStatus = map[string]string{
	"in_progress": "inProgress", "in_review": "inReview",
}

func wireStatus(status string) string {
	if wire, ok := storageToWireStatus[status]; ok {
		return wire
	}
	return status
}

// executeCreateIssue creates the issue and, when asked, waits for a person
// to move it to done.
func (runner *Runner) executeCreateIssue(ctx context.Context, call stepCall) (automation.StepOutcome, error) {
	create := call.step.CreateIssue
	if create == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The create_issue step has no title.")
	}
	issue, err := runner.createIssue(ctx, call, issueSpec{
		Title: create.Title, Description: create.Description, AssignAgentID: create.AssignAgentID,
		Priority: create.Priority, GoalID: create.GoalID, BoardID: create.BoardID,
	})
	if err != nil {
		return automation.StepOutcome{}, err
	}
	if create.WaitForCompletion {
		outcome := waiting("issue:"+issue.ID.String(), issueOutput(issue))
		outcome.Links.IssueID = &issue.ID
		return outcome, nil
	}
	outcome := succeeded(issueOutput(issue))
	outcome.Links.IssueID = &issue.ID
	return outcome, nil
}

// executeUpdateIssue applies the typed patch to the named issue.
func (runner *Runner) executeUpdateIssue(ctx context.Context, call stepCall) (automation.StepOutcome, error) {
	update := call.step.UpdateIssue
	if update == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The update_issue step names no issue.")
	}
	issue, err := runner.resolveIssueValue(ctx, call, update.Issue)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	updated, err := runner.applyIssuePatch(ctx, call, issue, update.Patch)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	outcome := succeeded(issueOutput(updated))
	outcome.Links.IssueID = &updated.ID
	return outcome, nil
}

// createIssue writes the issue with its provenance and goal link, the same
// way the issue routes do, on behalf of the workflow's creator.
func (runner *Runner) createIssue(ctx context.Context, call stepCall, spec issueSpec) (core.Issue, error) {
	if runner.options.Issues == nil || runner.options.Boards == nil {
		return core.Issue{}, stepFailure("EXECUTOR_UNAVAILABLE", "Issue creation is not configured.")
	}
	creator, err := actor(call)
	if err != nil {
		return core.Issue{}, err
	}
	title, err := render(spec.Title, call.scope)
	if err != nil {
		return core.Issue{}, err
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return core.Issue{}, stepFailure("ISSUE_INVALID", "The issue has no title.")
	}
	if len(title) > 500 {
		title = bounded(title)
	}
	description, err := render(spec.Description, call.scope)
	if err != nil {
		return core.Issue{}, err
	}
	boardID, err := runner.resolveBoard(ctx, call, spec.BoardID)
	if err != nil {
		return core.Issue{}, err
	}
	var assignee *core.AssigneeInput
	if spec.AssignAgentID != "" {
		agent, err := runner.resolveAgentID(ctx, call, spec.AssignAgentID)
		if err != nil {
			return core.Issue{}, err
		}
		assignee = &core.AssigneeInput{Type: "agent", ID: agent.ID}
	}
	goalID, err := runner.resolveGoal(call, spec.GoalID)
	if err != nil {
		return core.Issue{}, err
	}
	priority := spec.Priority
	if priority == "" {
		priority = "none"
	}
	now := runner.now()
	params := core.CreateIssueParams{
		ID: runner.options.NewID(), AssignmentID: runner.options.NewID(), BoardID: boardID,
		Title: title, Status: "todo", Priority: priority, Assignee: assignee,
		CreatedBy: creator, CreatedAt: now, NewID: runner.options.NewID,
	}
	if description != "" {
		params.Description = &description
	}
	issue, events, err := runner.options.Issues.CreateIssue(ctx, params)
	if err != nil {
		return core.Issue{}, wrapFailure("ISSUE_CREATE_FAILED", "The issue could not be created.", err)
	}
	runner.publishIssues(ctx, events)
	if err := runner.options.Store.RecordIssueOrigin(ctx, automationrepo.IssueOriginParams{
		WorkspaceID: call.run.WorkspaceID, IssueID: issue.ID, AutomationID: call.run.AutomationID,
		RunID: call.run.ID, StepRunID: &call.row.ID, CreatedAt: now,
	}); err != nil {
		runner.options.Logger.Warn("issue origin not recorded", "runId", call.run.ID, "issueId", issue.ID, "error", err)
	}
	if goalID != nil && runner.options.Goals != nil {
		if err := runner.options.Goals.LinkIssue(ctx, call.run.WorkspaceID, *goalID, issue.ID, creator, now); err != nil {
			runner.options.Logger.Warn("issue not linked to goal", "runId", call.run.ID, "issueId", issue.ID, "goalId", *goalID, "error", err)
		}
	}
	return issue, nil
}

// resolveBoard picks the board a created issue goes to: the one named, or
// the workspace's oldest. A board from another workspace is refused.
func (runner *Runner) resolveBoard(ctx context.Context, call stepCall, raw string) (uuid.UUID, error) {
	if raw == "" {
		boardID, err := runner.options.Boards.DefaultBoard(ctx, call.run.WorkspaceID)
		if err != nil {
			return uuid.Nil, wrapFailure("BOARD_NOT_FOUND", "The workspace has no board for the issue.", err)
		}
		return boardID, nil
	}
	boardID, err := uuid.Parse(raw)
	if err != nil || boardID == uuid.Nil {
		return uuid.Nil, stepFailure("BOARD_NOT_FOUND", "The board id is not a UUID.")
	}
	workspaceID, err := runner.options.Boards.BoardWorkspace(ctx, boardID)
	if err != nil || workspaceID != call.run.WorkspaceID {
		return uuid.Nil, stepFailure("BOARD_NOT_FOUND", "The board is not in this workspace.")
	}
	return boardID, nil
}

// resolveGoal reads a literal goal id or the {{ goal.id }} template, and
// falls back to the run's goal.
func (runner *Runner) resolveGoal(call stepCall, raw string) (*uuid.UUID, error) {
	if raw == "" {
		return call.run.GoalID, nil
	}
	text, err := render(raw, call.scope)
	if err != nil {
		return nil, err
	}
	goalID, err := uuid.Parse(strings.TrimSpace(text))
	if err != nil || goalID == uuid.Nil {
		return nil, stepFailure("GOAL_NOT_FOUND", "The goal id is not a UUID.")
	}
	return &goalID, nil
}

func (runner *Runner) resolveAgentID(ctx context.Context, call stepCall, raw string) (AgentRef, error) {
	if runner.options.Agents == nil {
		return AgentRef{}, stepFailure("EXECUTOR_UNAVAILABLE", "Agents are not configured.")
	}
	agentID, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil || agentID == uuid.Nil {
		return AgentRef{}, stepFailure("AGENT_NOT_FOUND", "The agent id is not a UUID.")
	}
	agent, err := runner.options.Agents.Agent(ctx, call.run.WorkspaceID, agentID)
	if err != nil {
		return AgentRef{}, wrapFailure("AGENT_NOT_FOUND", "The agent is not in this workspace.", err)
	}
	return agent, nil
}

// resolveIssueValue reads an issue reference from a step value: a uuid or
// identifier string, or an object carrying id or identifier (a previous
// step's output).
func (runner *Runner) resolveIssueValue(ctx context.Context, call stepCall, raw json.RawMessage) (core.Issue, error) {
	value, err := automation.ResolveValue(raw, call.scope)
	if err != nil {
		return core.Issue{}, wrapFailure("ISSUE_NOT_FOUND", "The issue reference resolves to nothing.", err)
	}
	return runner.resolveIssueRef(ctx, call, value)
}

func (runner *Runner) resolveIssueRef(ctx context.Context, call stepCall, value any) (core.Issue, error) {
	if runner.options.Issues == nil {
		return core.Issue{}, stepFailure("EXECUTOR_UNAVAILABLE", "Issues are not configured.")
	}
	var reference string
	switch typed := value.(type) {
	case string:
		reference = typed
	case map[string]any:
		if id, ok := typed["id"].(string); ok {
			reference = id
		} else if identifier, ok := typed["identifier"].(string); ok {
			reference = identifier
		}
	}
	reference = strings.TrimSpace(reference)
	if reference == "" {
		return core.Issue{}, stepFailure("ISSUE_NOT_FOUND", "The issue reference is empty.")
	}
	issue, err := runner.options.Issues.GetIssue(ctx, reference)
	if err != nil || issue.WorkspaceID != call.run.WorkspaceID {
		return core.Issue{}, stepFailure("ISSUE_NOT_FOUND", "The issue is not in this workspace.")
	}
	return issue, nil
}

// applyIssuePatch translates the typed patch and writes it through the
// issue store, which enforces transitions and the approval gates.
func (runner *Runner) applyIssuePatch(ctx context.Context, call stepCall, issue core.Issue, patch automation.IssuePatch) (core.Issue, error) {
	editor, err := actor(call)
	if err != nil {
		return core.Issue{}, err
	}
	var target core.IssuePatch
	if patch.Title != nil {
		title, err := render(*patch.Title, call.scope)
		if err != nil {
			return core.Issue{}, err
		}
		target.Title = &title
	}
	if patch.Description != nil {
		description, err := render(*patch.Description, call.scope)
		if err != nil {
			return core.Issue{}, err
		}
		target.DescriptionSet = true
		target.Description = &description
	}
	if patch.Status != nil {
		status, ok := wireToStorageStatus[*patch.Status]
		if !ok {
			return core.Issue{}, stepFailure("ISSUE_TRANSITION_INVALID", "The status is not an issue status.")
		}
		target.Status = &status
	}
	if patch.Priority != nil {
		priority := *patch.Priority
		target.Priority = &priority
	}
	if patch.AssignAgentID != nil {
		agent, err := runner.resolveAgentID(ctx, call, *patch.AssignAgentID)
		if err != nil {
			return core.Issue{}, err
		}
		target.AssigneeSet = true
		target.Assignee = &core.AssigneeInput{Type: "agent", ID: agent.ID}
	}
	return runner.updateIssue(ctx, issue.ID, target, editor)
}

func (runner *Runner) updateIssue(ctx context.Context, issueID uuid.UUID, patch core.IssuePatch, editor uuid.UUID) (core.Issue, error) {
	updated, events, err := runner.options.Issues.UpdateIssue(ctx, core.UpdateIssueParams{
		IssueID: issueID, Patch: patch, AssignmentID: runner.options.NewID(), AssignedBy: editor,
		UpdatedAt: runner.now(), NewID: runner.options.NewID,
	})
	if err != nil {
		var transition *core.StateTransitionError
		switch {
		case errors.Is(err, core.ErrApprovalRequired):
			return core.Issue{}, wrapFailure("APPROVAL_REQUIRED", "The issue is waiting for an approval before it can start.", err)
		case errors.As(err, &transition):
			return core.Issue{}, wrapFailure("ISSUE_TRANSITION_INVALID", "The issue cannot move from "+transition.From+" to "+transition.To+".", err)
		case errors.Is(err, core.ErrNotFound):
			return core.Issue{}, wrapFailure("ISSUE_NOT_FOUND", "The issue no longer exists.", err)
		}
		return core.Issue{}, wrapFailure("ISSUE_UPDATE_FAILED", "The issue could not be updated.", err)
	}
	runner.publishIssues(ctx, events)
	return updated, nil
}

func issueOutput(issue core.Issue) map[string]any {
	output := map[string]any{
		"id":         issue.ID.String(),
		"identifier": issue.Identifier(),
		"boardId":    issue.BoardID.String(),
		"title":      issue.Title,
		"status":     wireStatus(issue.Status),
		"priority":   issue.Priority,
	}
	if issue.Description != nil {
		output["description"] = *issue.Description
	}
	if issue.Assignee != nil {
		output["assignee"] = map[string]any{"type": issue.Assignee.Type, "id": issue.Assignee.ID.String(), "name": issue.Assignee.Name}
	}
	return output
}
