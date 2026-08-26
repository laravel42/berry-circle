package automation

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// ResolveRunCursor validates that a public cursor belongs to this run and is
// inside the retention window.
func (repository *Repository) ResolveRunCursor(
	ctx context.Context,
	runID, eventID uuid.UUID,
	cutoff time.Time,
) (int64, error) {
	if _, err := repository.GetRun(ctx, runID); err != nil {
		return 0, err
	}
	return ledger.ResolveCursor(ctx, repository.Pool, ledger.AutomationRuns, runID, eventID, cutoff)
}

// ListRunEvents replays the run ledger after one sequence, oldest first.
func (repository *Repository) ListRunEvents(
	ctx context.Context,
	runID uuid.UUID,
	afterSequence int64,
	cutoff time.Time,
	limit int,
) ([]RunEvent, error) {
	entries, err := ledger.Replay(ctx, repository.Pool, ledger.AutomationRuns, runID, afterSequence, cutoff, limit)
	if err != nil {
		return nil, err
	}
	result := make([]RunEvent, 0, len(entries))
	if len(entries) == 0 {
		return result, nil
	}
	// Every event of a run belongs to the run's workflow; one lookup per
	// non-empty batch rather than a join per row.
	var automationID uuid.UUID
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT automation_id FROM automation_runs WHERE id = $1`,
		runID,
	).Scan(&automationID); err != nil {
		return nil, errors.New("resolve automation run workflow")
	}
	for _, entry := range entries {
		var stamped struct {
			StepID *string `json:"stepId"`
		}
		_ = json.Unmarshal(entry.Payload, &stamped)
		result = append(result, RunEvent{
			ID:           entry.ID,
			Type:         entry.Type,
			OccurredAt:   entry.OccurredAt,
			WorkspaceID:  entry.Scope[0],
			AutomationID: automationID,
			RunID:        entry.OwnerID,
			StepID:       stamped.StepID,
			Sequence:     entry.Sequence,
			Payload:      entry.Payload,
		})
	}
	return result, nil
}
