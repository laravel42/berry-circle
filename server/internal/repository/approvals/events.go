package approvals

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// approvalResource is the approval as a stream or inbox consumer sees it.
// Storage kinds are translated to wire names here so no consumer learns a
// table vocabulary.
type approvalResource struct {
	ID              uuid.UUID  `json:"id"`
	WorkspaceID     uuid.UUID  `json:"workspaceId"`
	Kind            string     `json:"kind"`
	Risk            Risk       `json:"risk"`
	Title           string     `json:"title"`
	Description     *string    `json:"description"`
	GoalID          *uuid.UUID `json:"goalId"`
	PlanID          *uuid.UUID `json:"planId"`
	IssueID         *uuid.UUID `json:"issueId"`
	IssueIdentifier *string    `json:"issueIdentifier"`
	WorkflowID      *uuid.UUID `json:"workflowId"`
	WorkflowRunID   *uuid.UUID `json:"workflowRunId"`
	RequestedFrom   struct {
		UserID *uuid.UUID `json:"userId"`
		Role   *string    `json:"role"`
	} `json:"requestedFrom"`
	Status       Status     `json:"status"`
	DecisionNote *string    `json:"decisionNote"`
	ResolvedBy   *uuid.UUID `json:"resolvedBy"`
	RequestedAt  string     `json:"requestedAt"`
	ExpiresAt    *string    `json:"expiresAt"`
	ResolvedAt   *string    `json:"resolvedAt"`
}

// approvalEventPayload names the issue at the top level as well, which is how
// the shared envelope decoder recovers the issue scope for the board stream.
type approvalEventPayload struct {
	Approval approvalResource `json:"approval"`
	IssueID  *uuid.UUID       `json:"issueId,omitempty"`
	Actor    *core.ActorKey   `json:"actor,omitempty"`
}

// WireKind maps a storage kind to its API name.
func WireKind(kind Kind) string {
	switch kind {
	case KindIssueStart:
		return "issueStart"
	case KindAutomationActivation:
		return "workflowActivation"
	case KindAutomationStep:
		return "workflowStep"
	case KindIntegrationAction:
		return "integrationAction"
	default:
		return string(kind)
	}
}

// ParseWireKind maps an API kind back to storage. ok is false for unknown names.
func ParseWireKind(name string) (Kind, bool) {
	switch name {
	case "plan":
		return KindPlan, true
	case "issueStart":
		return KindIssueStart, true
	case "workflowActivation":
		return KindAutomationActivation, true
	case "workflowStep":
		return KindAutomationStep, true
	case "integrationAction":
		return KindIntegrationAction, true
	}
	return "", false
}

// writeApprovalEvent persists one approval.* fact. An approval on an issue
// carries the issue's board so the board stream replays it; every other one
// belongs to the workspace alone.
func writeApprovalEvent(
	ctx context.Context,
	tx database,
	topic string,
	approval Approval,
	actor *core.ActorKey,
	occurredAt time.Time,
	newID func() uuid.UUID,
) (Event, error) {
	if newID == nil {
		newID = uuid.New
	}
	var boardID *uuid.UUID
	if approval.IssueID != nil {
		var board uuid.UUID
		if err := tx.QueryRow(
			ctx,
			`SELECT board_id FROM issues WHERE id = $1`,
			*approval.IssueID,
		).Scan(&board); err == nil {
			boardID = &board
		}
	}
	payload, err := json.Marshal(approvalEventPayload{
		Approval: serializeApproval(approval),
		IssueID:  approval.IssueID,
		Actor:    actor,
	})
	if err != nil {
		return Event{}, errors.New("encode approval event payload")
	}
	return ledger.WriteOutbox(ctx, tx, ledger.OutboxEvent{
		ID:            newID(),
		Topic:         topic,
		AggregateType: "approval",
		AggregateID:   approval.ID,
		WorkspaceID:   approval.WorkspaceID,
		BoardID:       boardID,
		Payload:       payload,
		OccurredAt:    occurredAt,
	})
}

func serializeApproval(approval Approval) approvalResource {
	resource := approvalResource{
		ID:            approval.ID,
		WorkspaceID:   approval.WorkspaceID,
		Kind:          WireKind(approval.Kind),
		Risk:          approval.Risk,
		Title:         approval.Title,
		Description:   approval.Description,
		GoalID:        approval.GoalID,
		PlanID:        approval.PlanID,
		IssueID:       approval.IssueID,
		WorkflowID:    approval.AutomationID,
		WorkflowRunID: approval.AutomationRunID,
		Status:        approval.Status,
		DecisionNote:  approval.DecisionNote,
		ResolvedBy:    approval.ResolvedBy,
		RequestedAt:   approval.RequestedAt.UTC().Format(time.RFC3339Nano),
		ExpiresAt:     formatTime(approval.ExpiresAt),
		ResolvedAt:    formatTime(approval.ResolvedAt),
	}
	if approval.Issue != nil {
		identifier := approval.Issue.Identifier
		resource.IssueIdentifier = &identifier
	}
	resource.RequestedFrom.UserID = approval.RequestedFromUserID
	if approval.RequestedFromRole != "" {
		role := approval.RequestedFromRole
		resource.RequestedFrom.Role = &role
	}
	return resource
}

func formatTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
