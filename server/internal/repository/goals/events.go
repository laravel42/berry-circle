package goals

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// goalResource is the goal as a stream consumer sees it inside goal.* events.
type goalResource struct {
	ID           uuid.UUID  `json:"id"`
	WorkspaceID  uuid.UUID  `json:"workspaceId"`
	ProjectID    *uuid.UUID `json:"projectId"`
	Title        string     `json:"title"`
	Description  *string    `json:"description"`
	Status       Status     `json:"status"`
	Source       Source     `json:"source"`
	SourcePrompt *string    `json:"sourcePrompt"`
	CreatedBy    *uuid.UUID `json:"createdBy"`
	CreatedAt    string     `json:"createdAt"`
	UpdatedAt    string     `json:"updatedAt"`
	StartedAt    *string    `json:"startedAt"`
	CompletedAt  *string    `json:"completedAt"`
}

type goalEventPayload struct {
	Goal          goalResource   `json:"goal"`
	ChangedFields []string       `json:"changedFields"`
	Actor         *core.ActorKey `json:"actor,omitempty"`
}

// writeGoalEvent persists one goal.* fact. Goals belong to no board, so the
// row carries the workspace only and the workspace stream is what replays it.
func writeGoalEvent(
	ctx context.Context,
	tx database,
	topic string,
	goal Goal,
	changed []string,
	actor *core.ActorKey,
	occurredAt time.Time,
	newID func() uuid.UUID,
) (Event, error) {
	if newID == nil {
		newID = uuid.New
	}
	if changed == nil {
		changed = []string{}
	}
	payload, err := json.Marshal(goalEventPayload{Goal: serializeGoal(goal), ChangedFields: changed, Actor: actor})
	if err != nil {
		return Event{}, errors.New("encode goal event payload")
	}
	return ledger.WriteOutbox(ctx, tx, ledger.OutboxEvent{
		ID:            newID(),
		Topic:         topic,
		AggregateType: "goal",
		AggregateID:   goal.ID,
		WorkspaceID:   goal.WorkspaceID,
		Payload:       payload,
		OccurredAt:    occurredAt,
	})
}

func serializeGoal(goal Goal) goalResource {
	return goalResource{
		ID:           goal.ID,
		WorkspaceID:  goal.WorkspaceID,
		ProjectID:    goal.ProjectID,
		Title:        goal.Title,
		Description:  goal.Description,
		Status:       goal.Status,
		Source:       goal.Source,
		SourcePrompt: goal.SourcePrompt,
		CreatedBy:    goal.CreatedBy,
		CreatedAt:    goal.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:    goal.UpdatedAt.UTC().Format(time.RFC3339Nano),
		StartedAt:    formatTime(goal.StartedAt),
		CompletedAt:  formatTime(goal.CompletedAt),
	}
}

func formatTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
