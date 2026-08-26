package automationrun

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/repository/approvals"
)

// approvalRequest is what a step asks a person to decide.
type approvalRequest struct {
	Kind        approvals.Kind
	Title       string
	Description string
	Approver    automation.Approver
	Timeout     string
	// Risk overrides the policy-derived class when set.
	Risk approvals.Risk
}

// executeApproval creates the decision and parks the run on it.
func (runner *Runner) executeApproval(ctx context.Context, call stepCall) (automation.StepOutcome, error) {
	approval := call.step.Approval
	if approval == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The approval step has no approver.")
	}
	return runner.requestApproval(ctx, call, approvalRequest{
		Kind: approvals.KindAutomationStep, Title: approval.Title, Description: approval.Description,
		Approver: approval.Approver, Timeout: approval.Timeout,
	})
}

func (runner *Runner) requestApproval(ctx context.Context, call stepCall, request approvalRequest) (automation.StepOutcome, error) {
	if runner.options.Approvals == nil {
		return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Approvals are not configured.")
	}
	title, err := render(request.Title, call.scope)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	description, err := render(request.Description, call.scope)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return automation.StepOutcome{}, stepFailure("APPROVAL_INVALID", "The approval has no title.")
	}
	if len(title) > 500 {
		title = bounded(title)
	}
	params := approvals.CreateParams{
		ID:                  runner.options.NewID(),
		WorkspaceID:         call.run.WorkspaceID,
		Kind:                request.Kind,
		Risk:                request.Risk,
		Title:               title,
		GoalID:              call.run.GoalID,
		AutomationID:        &call.run.AutomationID,
		AutomationRunID:     &call.run.ID,
		AutomationStepRunID: &call.row.ID,
		RequestedByType:     approvals.ActorSystem,
		RequestedAt:         runner.now(),
		NewID:               runner.options.NewID,
	}
	if description != "" {
		params.Description = &description
	}
	if params.Risk == "" {
		params.Risk = riskFor(call.automation.Risk, title+" "+description)
	}
	switch request.Approver.Type {
	case automation.ApproverUser:
		userID, err := uuid.Parse(request.Approver.UserID)
		if err != nil || userID == uuid.Nil {
			return automation.StepOutcome{}, stepFailure("APPROVAL_INVALID", "The approver user id is not a UUID.")
		}
		params.RequestedFromUserID = &userID
	case automation.ApproverRole:
		params.RequestedFromRole = request.Approver.Role
	default:
		return automation.StepOutcome{}, stepFailure("APPROVAL_INVALID", "The approval names no approver.")
	}
	if request.Timeout != "" {
		duration, ok := automation.ParseDuration(request.Timeout)
		if !ok || duration <= 0 {
			return automation.StepOutcome{}, stepFailure("APPROVAL_INVALID", "The approval timeout is not an ISO-8601 duration.")
		}
		expires := params.RequestedAt.Add(duration)
		params.ExpiresAt = &expires
	}
	created, event, err := runner.options.Approvals.Create(ctx, params)
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("APPROVAL_REQUEST_FAILED", "The approval could not be recorded.", err)
	}
	runner.publish(ctx, event)
	outcome := waiting("approval:"+created.ID.String(), map[string]any{"approvalId": created.ID})
	outcome.Links.ApprovalID = &created.ID
	return outcome, nil
}

// riskFor classifies a decision: a destructive-policy match is what the
// policy says, otherwise the workflow's own indexed risk.
func riskFor(automationRisk automation.Risk, text string) approvals.Risk {
	if policy, ok := integrationcore.MatchPolicy(text); ok {
		switch policy.Risk {
		case "high":
			return approvals.RiskHigh
		case "low":
			return approvals.RiskLow
		default:
			return approvals.RiskMedium
		}
	}
	switch automationRisk {
	case automation.RiskHigh:
		return approvals.RiskHigh
	case automation.RiskLow:
		return approvals.RiskLow
	default:
		return approvals.RiskMedium
	}
}
