package automation

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// Repository owns the hand-written pgx boundary for automations.
type Repository struct {
	Pool *pgxpool.Pool
}

// New validates the authoritative PostgreSQL dependency.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("automation repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

type database interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

const automationProjection = `
	automation.id, automation.workspace_id, automation.project_id, automation.goal_id,
	automation.name, automation.description, automation.status, automation.version,
	automation.revision, automation.definition, automation.definition_version, automation.layout,
	automation.trigger_type, automation.trigger_provider, automation.trigger_operation,
	automation.trigger_event, automation.schedule_cron, automation.schedule_timezone,
	automation.schedule_next_at, automation.webhook_secret_hash IS NOT NULL, automation.risk,
	automation.engine, automation.engine_flow_id, automation.engine_sync_status,
	automation.engine_sync_error, automation.created_by, automation.created_at,
	automation.updated_at, automation.archived_at`

type rowScanner interface {
	Scan(...any) error
}

func scanAutomation(row rowScanner) (Automation, error) {
	var (
		result                            Automation
		status, triggerType, risk, engine string
		syncStatus                        string
		provider, operation, event        *string
		cron, timezone                    *string
		definition, layout                []byte
	)
	if err := row.Scan(
		&result.ID, &result.WorkspaceID, &result.ProjectID, &result.GoalID,
		&result.Name, &result.Description, &status, &result.Version,
		&result.Revision, &definition, &result.DefinitionVersion, &layout,
		&triggerType, &provider, &operation,
		&event, &cron, &timezone,
		&result.ScheduleNextAt, &result.HasWebhookSecret, &risk,
		&engine, &result.EngineFlowID, &syncStatus,
		&result.EngineSyncError, &result.CreatedBy, &result.CreatedAt,
		&result.UpdatedAt, &result.ArchivedAt,
	); err != nil {
		return Automation{}, err
	}
	result.Status = Status(status)
	result.Definition = append(json.RawMessage(nil), definition...)
	result.Layout = append(json.RawMessage(nil), layout...)
	result.Trigger = Trigger{Type: automation.TriggerType(triggerType)}
	result.Trigger.Provider = deref(provider)
	result.Trigger.Operation = deref(operation)
	result.Trigger.Event = deref(event)
	result.Trigger.Cron = deref(cron)
	result.Trigger.Timezone = deref(timezone)
	result.Risk = automation.Risk(risk)
	result.Engine = Engine(engine)
	result.EngineSyncStatus = EngineSyncStatus(syncStatus)
	return result, nil
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullable(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// Get returns one workflow, archived or not.
func (repository *Repository) Get(ctx context.Context, automationID uuid.UUID) (Automation, error) {
	return getAutomation(ctx, repository.Pool, automationID, false)
}

func getAutomation(ctx context.Context, queryer database, automationID uuid.UUID, lock bool) (Automation, error) {
	if automationID == uuid.Nil {
		return Automation{}, ErrNotFound
	}
	statement := `SELECT ` + automationProjection + ` FROM automations AS automation WHERE automation.id = $1`
	if lock {
		statement += ` FOR UPDATE`
	}
	result, err := scanAutomation(queryer.QueryRow(ctx, statement, automationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Automation{}, ErrNotFound
	}
	if err != nil {
		return Automation{}, errors.New("get automation")
	}
	return result, nil
}

// List returns one over-fetched stable page of live (non-archived)
// workflows, most recently updated first.
func (repository *Repository) List(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter ListFilter,
	after *Cursor,
	limit int,
) ([]Automation, error) {
	if workspaceID == uuid.Nil || limit < 1 {
		return nil, errors.New("automation list configuration is invalid")
	}
	afterEnabled := after != nil
	var afterTime, afterID any
	if after != nil {
		afterTime, afterID = after.UpdatedAt, after.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+automationProjection+`
		   FROM automations AS automation
		  WHERE automation.workspace_id = $1
		    AND automation.archived_at IS NULL
		    AND ($2 = '' OR automation.status = $2)
		    AND ($3 = '' OR automation.trigger_type = $3)
		    AND ($4::uuid IS NULL OR automation.goal_id = $4::uuid)
		    AND ($5::uuid IS NULL OR automation.project_id = $5::uuid)
		    AND ($6 = '' OR automation.name ILIKE '%' || $6 || '%')
		    AND (NOT $7::boolean OR
		        (automation.updated_at, automation.id) < ($8::timestamptz, $9::uuid))
		  ORDER BY automation.updated_at DESC, automation.id DESC
		  LIMIT $10`,
		workspaceID, string(filter.Status), string(filter.TriggerType),
		filter.GoalID, filter.ProjectID, strings.TrimSpace(filter.Query),
		afterEnabled, afterTime, afterID, limit,
	)
	if err != nil {
		return nil, errors.New("list automations")
	}
	defer rows.Close()
	result := make([]Automation, 0, limit)
	for rows.Next() {
		item, err := scanAutomation(rows)
		if err != nil {
			return nil, errors.New("scan automation")
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate automations")
	}
	return result, nil
}

// Create writes a draft workflow, its first version snapshot and the
// workflow.created fact in one transaction.
func (repository *Repository) Create(ctx context.Context, params CreateParams) (Automation, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Automation{}, Event{}, errors.New("begin automation creation")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	created, event, err := CreateIn(ctx, tx, params)
	if err != nil {
		return Automation{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Automation{}, Event{}, errors.New("commit automation creation")
	}
	return created, event, nil
}

// CreateIn is Create inside a caller's transaction, which is how a plan
// compile writes its workflow drafts beside the goal and issues they serve.
func CreateIn(ctx context.Context, tx database, params CreateParams) (Automation, Event, error) {
	if params.ID == uuid.Nil || params.WorkspaceID == uuid.Nil || params.Name == "" ||
		params.CreatedBy == uuid.Nil || params.CreatedAt.IsZero() {
		return Automation{}, Event{}, errors.New("automation creation parameters are invalid")
	}
	if params.Engine == "" {
		params.Engine = EngineNative
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	definition, err := json.Marshal(params.Definition)
	if err != nil {
		return Automation{}, Event{}, errors.New("encode automation definition")
	}
	layout := params.Layout
	if len(layout) == 0 {
		layout = json.RawMessage(`{}`)
	}
	metadata := automation.DeriveMetadata(params.Definition, params.Catalog)
	syncStatus := EngineSyncNotRequired
	if params.Engine == EngineActivepieces {
		syncStatus = EngineSyncPending
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO automations (
		    id, workspace_id, project_id, goal_id, name, description, status, version, revision,
		    definition, definition_version, layout,
		    trigger_type, trigger_provider, trigger_operation, trigger_event,
		    schedule_cron, schedule_timezone, risk, engine, engine_sync_status,
		    created_by, created_at, updated_at
		 ) VALUES (
		    $1, $2, $3, $4, $5, $6, 'draft', 1, 1,
		    $7::jsonb, $8, $9::jsonb,
		    $10, $11, $12, $13,
		    $14, $15, $16, $17, $18,
		    $19, $20, $20
		 )`,
		params.ID, params.WorkspaceID, params.ProjectID, params.GoalID, params.Name, params.Description,
		string(definition), automation.DefinitionVersion, string(layout),
		string(metadata.TriggerType), nullable(metadata.TriggerProvider), nullable(metadata.TriggerOperation), nullable(metadata.TriggerEvent),
		nullable(metadata.ScheduleCron), nullable(metadata.ScheduleTimezone), string(metadata.Risk), string(params.Engine), string(syncStatus),
		params.CreatedBy, params.CreatedAt.UTC(),
	); err != nil {
		return Automation{}, Event{}, classifyWrite("insert automation", err)
	}
	if err := insertVersion(ctx, tx, newID(), params.WorkspaceID, params.ID, 1, definition, &params.CreatedBy, params.CreatedAt); err != nil {
		return Automation{}, Event{}, err
	}
	created, err := getAutomation(ctx, tx, params.ID, false)
	if err != nil {
		return Automation{}, Event{}, err
	}
	event, err := writeAutomationEvent(ctx, tx, "workflow.created", created, &core.ActorKey{Type: "user", ID: params.CreatedBy}, params.CreatedAt, newID)
	if err != nil {
		return Automation{}, Event{}, err
	}
	return created, event, nil
}

func insertVersion(
	ctx context.Context,
	tx database,
	id, workspaceID, automationID uuid.UUID,
	version int,
	definition []byte,
	createdBy *uuid.UUID,
	createdAt time.Time,
) error {
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO automation_versions (
		    id, workspace_id, automation_id, version, definition, definition_version, created_by, created_at
		 ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
		id, workspaceID, automationID, version, string(definition), automation.DefinitionVersion, createdBy, createdAt.UTC(),
	); err != nil {
		return classifyWrite("insert automation version", err)
	}
	return nil
}

// Update applies one optimistic edit. The revision bumps on every write; a
// definition change also bumps the version and snapshots it, and is refused
// while the workflow is active so a running trigger never reads a definition
// nobody activated.
func (repository *Repository) Update(ctx context.Context, params UpdateParams) (Automation, error) {
	if params.AutomationID == uuid.Nil || params.ExpectedRevision < 1 || params.UpdatedAt.IsZero() {
		return Automation{}, errors.New("automation update parameters are invalid")
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Automation{}, errors.New("begin automation update")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	current, err := getAutomation(ctx, tx, params.AutomationID, true)
	if err != nil {
		return Automation{}, err
	}
	if current.Status == StatusArchived {
		return Automation{}, ErrNotFound
	}
	if current.Revision != params.ExpectedRevision {
		return Automation{}, ErrRevisionConflict
	}
	version := current.Version
	definition := current.Definition
	metadata := automation.Metadata{
		TriggerType: current.Trigger.Type, TriggerProvider: current.Trigger.Provider,
		TriggerOperation: current.Trigger.Operation, TriggerEvent: current.Trigger.Event,
		ScheduleCron: current.Trigger.Cron, ScheduleTimezone: current.Trigger.Timezone, Risk: current.Risk,
	}
	if params.Definition != nil {
		if current.Status == StatusActive {
			return Automation{}, ErrActive
		}
		encoded, err := json.Marshal(*params.Definition)
		if err != nil {
			return Automation{}, errors.New("encode automation definition")
		}
		definition = encoded
		version = current.Version + 1
		metadata = automation.DeriveMetadata(*params.Definition, params.Catalog)
	}
	var actor *uuid.UUID
	if params.ActorID != uuid.Nil {
		actor = &params.ActorID
	}
	layout := params.Layout
	if len(layout) == 0 {
		layout = current.Layout
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automations AS automation
		    SET name = COALESCE($2, automation.name),
		        description = CASE WHEN $3::boolean THEN $4 ELSE automation.description END,
		        goal_id = CASE WHEN $5::boolean THEN $6::uuid ELSE automation.goal_id END,
		        project_id = CASE WHEN $7::boolean THEN $8::uuid ELSE automation.project_id END,
		        definition = $9::jsonb,
		        layout = $10::jsonb,
		        version = $11,
		        revision = automation.revision + 1,
		        trigger_type = $12, trigger_provider = $13, trigger_operation = $14, trigger_event = $15,
		        schedule_cron = $16, schedule_timezone = $17, risk = $18,
		        updated_at = $19
		  WHERE automation.id = $1`,
		params.AutomationID, params.Name, params.DescriptionSet, params.Description,
		params.GoalSet, params.GoalID, params.ProjectSet, params.ProjectID,
		string(definition), string(layout), version,
		string(metadata.TriggerType), nullable(metadata.TriggerProvider), nullable(metadata.TriggerOperation), nullable(metadata.TriggerEvent),
		nullable(metadata.ScheduleCron), nullable(metadata.ScheduleTimezone), string(metadata.Risk),
		params.UpdatedAt.UTC(),
	); err != nil {
		return Automation{}, classifyWrite("update automation", err)
	}
	if version != current.Version {
		if err := insertVersion(ctx, tx, newID(), current.WorkspaceID, current.ID, version, definition, actor, params.UpdatedAt); err != nil {
			return Automation{}, err
		}
	}
	updated, err := getAutomation(ctx, tx, params.AutomationID, false)
	if err != nil {
		return Automation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Automation{}, errors.New("commit automation update")
	}
	return updated, nil
}

// SetStatus moves a workflow along draft → active ⇄ paused; Archive is the
// terminal move. Triggers start and stop with the status in P1b; this only
// records the state and emits the fact.
func (repository *Repository) SetStatus(
	ctx context.Context,
	automationID uuid.UUID,
	to Status,
	actorID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) (Automation, Event, error) {
	if to != StatusActive && to != StatusPaused {
		return Automation{}, Event{}, errors.New("automation status is not activatable or pausable")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Automation{}, Event{}, errors.New("begin automation status change")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	current, err := getAutomation(ctx, tx, automationID, true)
	if err != nil {
		return Automation{}, Event{}, err
	}
	if current.Status == StatusArchived {
		return Automation{}, Event{}, ErrNotFound
	}
	if current.Status == to {
		return current, Event{}, tx.Commit(ctx)
	}
	if to == StatusPaused && current.Status != StatusActive {
		return Automation{}, Event{}, ErrInvalidTransition
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automations SET status = $2, revision = revision + 1, updated_at = $3 WHERE id = $1`,
		automationID, string(to), now.UTC(),
	); err != nil {
		return Automation{}, Event{}, classifyWrite("change automation status", err)
	}
	updated, err := getAutomation(ctx, tx, automationID, false)
	if err != nil {
		return Automation{}, Event{}, err
	}
	topic := "workflow.activated"
	if to == StatusPaused {
		topic = "workflow.paused"
	}
	event, err := writeAutomationEvent(ctx, tx, topic, updated, &core.ActorKey{Type: "user", ID: actorID}, now, newID)
	if err != nil {
		return Automation{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Automation{}, Event{}, errors.New("commit automation status change")
	}
	return updated, event, nil
}

// Archive retires a workflow. Its runs and versions stay readable.
func (repository *Repository) Archive(
	ctx context.Context,
	automationID uuid.UUID,
	actorID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) (Automation, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Automation{}, Event{}, errors.New("begin automation archive")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	current, err := getAutomation(ctx, tx, automationID, true)
	if err != nil {
		return Automation{}, Event{}, err
	}
	if current.Status == StatusArchived {
		return current, Event{}, tx.Commit(ctx)
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automations SET status = 'archived', archived_at = $2, revision = revision + 1, updated_at = $2 WHERE id = $1`,
		automationID, now.UTC(),
	); err != nil {
		return Automation{}, Event{}, classifyWrite("archive automation", err)
	}
	archived, err := getAutomation(ctx, tx, automationID, false)
	if err != nil {
		return Automation{}, Event{}, err
	}
	event, err := writeAutomationEvent(ctx, tx, "workflow.archived", archived, &core.ActorKey{Type: "user", ID: actorID}, now, newID)
	if err != nil {
		return Automation{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Automation{}, Event{}, errors.New("commit automation archive")
	}
	return archived, event, nil
}

// ListVersions returns every snapshot, newest first.
func (repository *Repository) ListVersions(ctx context.Context, automationID uuid.UUID) ([]Version, error) {
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT id, workspace_id, automation_id, version, definition, definition_version,
		        engine_flow_version_id, created_by, created_at
		   FROM automation_versions
		  WHERE automation_id = $1
		  ORDER BY version DESC`,
		automationID,
	)
	if err != nil {
		return nil, errors.New("list automation versions")
	}
	defer rows.Close()
	var result []Version
	for rows.Next() {
		var (
			version    Version
			definition []byte
		)
		if err := rows.Scan(
			&version.ID, &version.WorkspaceID, &version.AutomationID, &version.Version, &definition,
			&version.DefinitionVersion, &version.EngineFlowVersionID, &version.CreatedBy, &version.CreatedAt,
		); err != nil {
			return nil, errors.New("scan automation version")
		}
		version.Definition = append(json.RawMessage(nil), definition...)
		result = append(result, version)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate automation versions")
	}
	if result == nil {
		result = []Version{}
	}
	return result, nil
}

// GetVersion returns one snapshot; a run executes the version it was created
// against, not whatever the workflow says now.
func (repository *Repository) GetVersion(ctx context.Context, automationID uuid.UUID, version int) (Version, error) {
	var (
		result     Version
		definition []byte
	)
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT id, workspace_id, automation_id, version, definition, definition_version,
		        engine_flow_version_id, created_by, created_at
		   FROM automation_versions
		  WHERE automation_id = $1 AND version = $2`,
		automationID, version,
	).Scan(
		&result.ID, &result.WorkspaceID, &result.AutomationID, &result.Version, &definition,
		&result.DefinitionVersion, &result.EngineFlowVersionID, &result.CreatedBy, &result.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Version{}, ErrNotFound
	}
	if err != nil {
		return Version{}, errors.New("get automation version")
	}
	result.Definition = append(json.RawMessage(nil), definition...)
	return result, nil
}

// SetEngineSync records the state of the external mirror.
func (repository *Repository) SetEngineSync(
	ctx context.Context,
	automationID uuid.UUID,
	status EngineSyncStatus,
	flowID *string,
	syncError *string,
	now time.Time,
) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE automations
		    SET engine_sync_status = $2,
		        engine_flow_id = COALESCE($3, engine_flow_id),
		        engine_sync_error = $4,
		        updated_at = $5
		  WHERE id = $1`,
		automationID, string(status), flowID, syncError, now.UTC(),
	)
	if err != nil {
		return classifyWrite("record engine sync", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RotateWebhookSecret stores the digest of a new hook token; the token itself
// is returned to the caller once and never persisted.
func (repository *Repository) RotateWebhookSecret(
	ctx context.Context,
	automationID uuid.UUID,
	secret string,
	now time.Time,
) error {
	if secret == "" {
		return errors.New("webhook secret is empty")
	}
	digest := sha256.Sum256([]byte(secret))
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE automations SET webhook_secret_hash = $2, revision = revision + 1, updated_at = $3 WHERE id = $1 AND archived_at IS NULL`,
		automationID, digest[:], now.UTC(),
	)
	if err != nil {
		return classifyWrite("rotate webhook secret", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// WebhookSecretMatches compares a presented token with the stored digest in
// constant time, and returns the workflow when it is active.
func (repository *Repository) WebhookSecretMatches(
	ctx context.Context,
	automationID uuid.UUID,
	secret string,
) (Automation, bool, error) {
	digest := sha256.Sum256([]byte(secret))
	var matched bool
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT webhook_secret_hash IS NOT NULL AND webhook_secret_hash = $2
		   FROM automations WHERE id = $1 AND status = 'active'`,
		automationID, digest[:],
	).Scan(&matched)
	if errors.Is(err, pgx.ErrNoRows) {
		return Automation{}, false, nil
	}
	if err != nil {
		return Automation{}, false, errors.New("check webhook secret")
	}
	if !matched {
		return Automation{}, false, nil
	}
	current, err := repository.Get(ctx, automationID)
	if err != nil {
		return Automation{}, false, err
	}
	return current, true, nil
}

func classifyWrite(operation string, err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrNotFound
		case "23505", "23P01", "23514":
			return ErrConflict
		case "23001":
			return core.ErrApprovalRequired
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}

var _ = ledger.OutboxScopeWorkspace
