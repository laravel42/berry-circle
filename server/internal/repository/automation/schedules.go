package automation

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/automation"
)

// DefaultCatchupWindow is how far behind a schedule may fall and still fire
// its missed instants. Instants older than the window are advanced past
// without a run: a scheduler that was down for a day must not start a
// day's worth of runs when it comes back. The Temporal schedule seam sets
// the same window so both paths create the same rows.
const DefaultCatchupWindow = time.Hour

// MaxCatchupFires bounds the instants fired for one workflow in one claim.
const MaxCatchupFires = 50

// ScheduleKey is the source event key of the run one schedule instant
// creates; the same key on both execution paths makes the run idempotent
// per instant.
func ScheduleKey(automationID uuid.UUID, fireTime time.Time) string {
	return "schedule:" + automationID.String() + ":" + fireTime.UTC().Format(time.RFC3339)
}

// SchedulePayload is the trigger payload of a scheduled run.
func SchedulePayload(fireTime time.Time, cron, timezone string) (json.RawMessage, error) {
	return json.Marshal(map[string]any{
		"scheduledAt": fireTime.UTC().Format(time.RFC3339),
		"cron":        cron,
		"timezone":    timezone,
	})
}

// NextFire computes the fire time after an instant for a cron and timezone;
// ok is false when the expression never fires again.
type NextFire func(cron, timezone string, after time.Time) (time.Time, bool)

// FireParams bounds one in-process scheduler tick.
type FireParams struct {
	Now   time.Time
	Limit int
	// WorkspaceID narrows the claim; nil claims across every workspace.
	WorkspaceID *uuid.UUID
	// CatchupWindow overrides DefaultCatchupWindow when positive.
	CatchupWindow time.Duration
	NewID         func() uuid.UUID
	Next          NextFire
}

// FireSchedules claims the active schedule-triggered workflows whose next
// fire time has passed, skipping rows another scheduler holds, creates one
// pending run per due instant inside the catch-up window, and advances
// schedule_next_at past now — all in one transaction, so a scheduler that
// dies mid-tick leaves the instants unfired for the next tick rather than
// fired twice. It returns the runs it created.
func (repository *Repository) FireSchedules(ctx context.Context, params FireParams) ([]Run, error) {
	if params.Now.IsZero() || params.Limit < 1 || params.Limit > 500 || params.Next == nil {
		return nil, errors.New("schedule fire parameters are invalid")
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	window := params.CatchupWindow
	if window <= 0 {
		window = DefaultCatchupWindow
	}
	now := params.Now.UTC()
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, errors.New("begin schedule claim")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(
		ctx,
		`SELECT `+automationProjection+`
		   FROM automations AS automation
		  WHERE automation.status = 'active'
		    AND automation.trigger_type = 'schedule'
		    AND automation.schedule_next_at IS NOT NULL
		    AND automation.schedule_next_at <= $1
		    AND ($3::uuid IS NULL OR automation.workspace_id = $3::uuid)
		  ORDER BY automation.schedule_next_at ASC, automation.id ASC
		  LIMIT $2
		  FOR UPDATE SKIP LOCKED`,
		now, params.Limit, params.WorkspaceID,
	)
	if err != nil {
		return nil, errors.New("claim due schedules")
	}
	var due []Automation
	for rows.Next() {
		item, err := scanAutomation(rows)
		if err != nil {
			rows.Close()
			return nil, errors.New("scan due schedule")
		}
		due = append(due, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate due schedules")
	}
	var created []Run
	for _, item := range due {
		instant := item.ScheduleNextAt.UTC()
		var next *time.Time
		for fires := 0; !instant.After(now); fires++ {
			if fires < MaxCatchupFires && now.Sub(instant) <= window {
				payload, err := SchedulePayload(instant, item.Trigger.Cron, item.Trigger.Timezone)
				if err != nil {
					return nil, errors.New("encode schedule payload")
				}
				key := ScheduleKey(item.ID, instant)
				run, isNew, err := createRunIn(ctx, tx, CreateRunParams{
					ID: newID(), AutomationID: item.ID, TriggerType: automation.TriggerSchedule, Payload: payload,
					SourceEventKey: &key, RequestedBy: item.CreatedBy, RequestID: key, CreatedAt: now,
				})
				if err != nil {
					return nil, err
				}
				if isNew {
					created = append(created, run)
				}
			}
			following, ok := params.Next(item.Trigger.Cron, item.Trigger.Timezone, instant)
			if !ok {
				next = nil
				break
			}
			instant = following.UTC()
			value := instant
			next = &value
		}
		if _, err := tx.Exec(ctx, `UPDATE automations SET schedule_next_at = $2 WHERE id = $1`, item.ID, next); err != nil {
			return nil, classifyWrite("advance schedule", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, errors.New("commit schedule claim")
	}
	return created, nil
}

// SetScheduleNextAt records when the in-process scheduler fires a workflow
// next; nil withdraws it from the scheduler.
func (repository *Repository) SetScheduleNextAt(ctx context.Context, automationID uuid.UUID, nextAt *time.Time) error {
	if automationID == uuid.Nil {
		return ErrNotFound
	}
	var value *time.Time
	if nextAt != nil {
		utc := nextAt.UTC()
		value = &utc
	}
	tag, err := repository.Pool.Exec(ctx, `UPDATE automations SET schedule_next_at = $2 WHERE id = $1 AND archived_at IS NULL`, automationID, value)
	if err != nil {
		return classifyWrite("set schedule next fire", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// OldestDueSchedule is the earliest schedule_next_at that has passed among
// active schedule-triggered workflows, or nil when the scheduler is caught
// up. It feeds the scheduler lag gauge.
func (repository *Repository) OldestDueSchedule(ctx context.Context, now time.Time, workspaceID *uuid.UUID) (*time.Time, error) {
	var oldest *time.Time
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT min(schedule_next_at) FROM automations
		  WHERE status = 'active' AND trigger_type = 'schedule'
		    AND schedule_next_at IS NOT NULL AND schedule_next_at <= $1
		    AND ($2::uuid IS NULL OR workspace_id = $2::uuid)`,
		now.UTC(), workspaceID,
	).Scan(&oldest); err != nil {
		return nil, errors.New("read schedule lag")
	}
	if oldest != nil {
		value := oldest.UTC()
		oldest = &value
	}
	return oldest, nil
}
