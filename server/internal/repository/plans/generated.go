package plans

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/laravel42/berry-circle/server/internal/repository/approvals"
	"github.com/laravel42/berry-circle/server/internal/repository/goals"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// Generated plans (source = ai) share the plans table with orchestrator
// briefs but are goal-scoped: the planner stores only its intermediate
// representation here, version by version, until approval compiles it.

var (
	// ErrPlanOpen means the goal already has a draft or pending plan.
	ErrPlanOpen = errors.New("goal already has an open plan")
	// ErrVersionConflict means the caller saved against a stale version.
	ErrVersionConflict = errors.New("plan version conflict")
	// ErrNotOpen means the plan is neither draft nor pending approval.
	ErrNotOpen = errors.New("plan is not open")
)

// Source records who wrote the plan.
type Source string

const (
	SourceOrchestrator Source = "orchestrator"
	SourceAI           Source = "ai"
	SourceManual       Source = "manual"
)

// Generation, validation and compile stages of a generated plan.
const (
	GenerationIdle      = "idle"
	GenerationRunning   = "running"
	GenerationSucceeded = "succeeded"
	GenerationFailed    = "failed"

	ValidationUnknown = "unknown"
	ValidationValid   = "valid"
	ValidationInvalid = "invalid"
	ValidationBlocked = "blocked"

	CompileNotStarted = "not_started"
	CompileRunning    = "running"
	CompileSucceeded  = "succeeded"
	CompileFailed     = "failed"
)

// Version origins.
const (
	OriginGenerated     = "generated"
	OriginRepaired      = "repaired"
	OriginCriticRevised = "critic_revised"
	OriginPatched       = "patched"
	OriginEdited        = "edited"
)

// PlanHeader is the plans row as the planner and its handlers read it.
// ProjectID is the goal's project for generated plans and the brief's own
// project for orchestrator plans.
type PlanHeader struct {
	ID               uuid.UUID
	WorkspaceID      uuid.UUID
	GoalID           *uuid.UUID
	ProjectID        *uuid.UUID
	BoardID          *uuid.UUID
	Status           string
	Source           Source
	SourcePrompt     *string
	IR               json.RawMessage
	IRVersion        *string
	CurrentVersion   int
	PlannerVersion   *string
	Confidence       *float64
	GenerationStatus string
	GenerationError  *string
	ValidationStatus string
	CompileStatus    string
	CompileError     *string
	CompiledAt       *time.Time
	ConversationID   *uuid.UUID
	CreatedBy        *uuid.UUID
	ApprovedBy       *uuid.UUID
	ApprovedAt       *time.Time
	DecisionNote     *string
	CreatedAt        time.Time
	UpdatedAt        time.Time
	// AutoGate lets this plan's issues reach done on an agent's review rather
	// than a person's. Off unless somebody turned it on for this plan.
	AutoGate bool
	// LastStage and LastOutcome are the newest planner_events row, from
	// which the stage in progress is derived while generation runs.
	LastStage   *string
	LastOutcome *string
}

// Pipeline stages, as planner_events.stage spells them, plus the derived
// finalize stage a reader sees once the critic is done.
const (
	StageIntent   = "intent"
	StageContext  = "context"
	StageGenerate = "generate"
	StageValidate = "validate"
	StageRepair   = "repair"
	StageCritic   = "critic"
	StageFinalize = "finalize"
	StagePatch    = "patch"
	StageApprove  = "approve"
	StageCompile  = "compile"
)

// Event outcomes, as planner_events.outcome spells them.
const (
	OutcomeOK      = "ok"
	OutcomeInvalid = "invalid"
	OutcomeError   = "error"
	OutcomeTimeout = "timeout"
	OutcomeSkipped = "skipped"
)

// CurrentStage derives the stage in progress from the newest recorded stage
// and its outcome. Every stage records its row when it finishes, so the
// stage a reader sees running is the one that comes next.
func CurrentStage(header PlanHeader) *string {
	if header.GenerationStatus != GenerationRunning {
		return nil
	}
	stage := StageIntent
	if header.LastStage != nil {
		outcome := ""
		if header.LastOutcome != nil {
			outcome = *header.LastOutcome
		}
		switch *header.LastStage {
		case StageIntent:
			stage = StageContext
		case StageContext:
			stage = StageGenerate
		case StageGenerate:
			stage = StageValidate
			if outcome == OutcomeInvalid {
				stage = StageRepair
			}
		case StageValidate:
			stage = StageCritic
			if outcome == OutcomeInvalid {
				stage = StageRepair
			}
		case StageRepair:
			stage = StageValidate
		case StageCritic:
			stage = StageFinalize
		default:
			stage = *header.LastStage
		}
	}
	return &stage
}

// PlanVersion is one immutable IR snapshot with what was known about it.
type PlanVersion struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	PlanID        uuid.UUID
	Version       int
	Origin        string
	IR            json.RawMessage
	IRVersion     string
	Validation    json.RawMessage
	Critic        json.RawMessage
	Patch         json.RawMessage
	CreatedByType string
	CreatedBy     *uuid.UUID
	CreatedAt     time.Time
}

// PlannerEvent is one pipeline stage record: counts, codes and ids only.
type PlannerEvent struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	PlanID        uuid.UUID
	Sequence      int
	Stage         string
	Role          *string
	PromptVersion *string
	ModelProvider *string
	ModelName     *string
	InputTokens   *int64
	OutputTokens  *int64
	CostMicros    *int64
	DurationMS    *int64
	Outcome       string
	Detail        json.RawMessage
	OccurredAt    time.Time
}

// CreateGeneratedParams starts one generated plan. When GoalID is nil a draft
// goal is created in the same transaction — a generated plan is always
// goal-scoped, and the compile step promotes that goal to planned.
type CreateGeneratedParams struct {
	ID             uuid.UUID
	WorkspaceID    uuid.UUID
	GoalID         *uuid.UUID
	BoardID        *uuid.UUID
	ProjectID      *uuid.UUID
	Prompt         string
	ActorID        uuid.UUID
	ConversationID *uuid.UUID
	CreatedAt      time.Time
	// AutoGate lets this plan's issues close on a peer agent's review.
	AutoGate bool
	// NewID mints the goal id and its event id; nil falls back to random ids.
	NewID func() uuid.UUID
}

// SaveVersionParams appends one IR snapshot and updates the header.
type SaveVersionParams struct {
	PlanID           uuid.UUID
	ExpectedVersion  int
	Origin           string
	IR               json.RawMessage
	IRVersion        string
	Validation       json.RawMessage
	Critic           json.RawMessage
	Patch            json.RawMessage
	ValidationStatus string
	Confidence       *float64
	PlannerVersion   *string
	CreatedByType    string
	CreatedBy        *uuid.UUID
	CreatedAt        time.Time
	NewID            func() uuid.UUID
}

// RecordEventParams is one planner_events row.
type RecordEventParams struct {
	ID            uuid.UUID
	PlanID        uuid.UUID
	Stage         string
	Role          *string
	PromptVersion *string
	ModelProvider *string
	ModelName     *string
	InputTokens   *int64
	OutputTokens  *int64
	CostMicros    *int64
	DurationMS    *int64
	Outcome       string
	Detail        json.RawMessage
	OccurredAt    time.Time
}

// RequestPlanApprovalParams asks a higher role to press Start Plan.
type RequestPlanApprovalParams struct {
	PlanID              uuid.UUID
	ActorID             uuid.UUID
	Title               string
	Description         *string
	Risk                approvals.Risk
	RequestedFromRole   string
	RequestedFromUserID *uuid.UUID
	Now                 time.Time
	NewID               func() uuid.UUID
}

const headerProjection = `
	plan.id, plan.workspace_id, plan.goal_id,
	COALESCE(plan.project_id, goal.project_id), plan.board_id, plan.status, plan.source,
	plan.source_prompt, plan.ir, plan.ir_version, plan.current_version, plan.planner_version,
	plan.confidence, plan.generation_status, plan.generation_error, plan.validation_status,
	plan.compile_status, plan.compile_error, plan.compiled_at, plan.conversation_id,
	plan.created_by, plan.approved_by, plan.approved_at, plan.decision_note,
	plan.created_at, plan.updated_at, plan.auto_gate,
	(SELECT event.stage FROM planner_events AS event WHERE event.plan_id = plan.id ORDER BY event.sequence DESC LIMIT 1),
	(SELECT event.outcome FROM planner_events AS event WHERE event.plan_id = plan.id ORDER BY event.sequence DESC LIMIT 1)`

const headerSource = `
	FROM plans AS plan
	LEFT JOIN goals AS goal ON goal.id = plan.goal_id`

type querier interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type headerScanner interface {
	Scan(...any) error
}

func scanHeader(row headerScanner) (PlanHeader, error) {
	var (
		header PlanHeader
		source string
		ir     []byte
	)
	if err := row.Scan(
		&header.ID, &header.WorkspaceID, &header.GoalID,
		&header.ProjectID, &header.BoardID, &header.Status, &source,
		&header.SourcePrompt, &ir, &header.IRVersion, &header.CurrentVersion, &header.PlannerVersion,
		&header.Confidence, &header.GenerationStatus, &header.GenerationError, &header.ValidationStatus,
		&header.CompileStatus, &header.CompileError, &header.CompiledAt, &header.ConversationID,
		&header.CreatedBy, &header.ApprovedBy, &header.ApprovedAt, &header.DecisionNote,
		&header.CreatedAt, &header.UpdatedAt, &header.AutoGate,
		&header.LastStage, &header.LastOutcome,
	); err != nil {
		return PlanHeader{}, err
	}
	header.Source = Source(source)
	if ir != nil {
		header.IR = append(json.RawMessage(nil), ir...)
	}
	return header, nil
}

// GetHeader returns one plan of any source.
func (repository *Repository) GetHeader(ctx context.Context, planID uuid.UUID) (PlanHeader, error) {
	return getHeader(ctx, repository.Pool, planID, false)
}

func getHeader(ctx context.Context, queryer querier, planID uuid.UUID, lock bool) (PlanHeader, error) {
	if planID == uuid.Nil {
		return PlanHeader{}, ErrNotFound
	}
	statement := `SELECT ` + headerProjection + headerSource + ` WHERE plan.id = $1`
	if lock {
		statement += ` FOR UPDATE OF plan`
	}
	header, err := scanHeader(queryer.QueryRow(ctx, statement, planID))
	if errors.Is(err, pgx.ErrNoRows) {
		return PlanHeader{}, ErrNotFound
	}
	if err != nil {
		return PlanHeader{}, errors.New("get plan header")
	}
	return header, nil
}

// ListForGoal returns every plan of a goal, newest first.
func (repository *Repository) ListForGoal(ctx context.Context, goalID uuid.UUID, limit int) ([]PlanHeader, error) {
	if goalID == uuid.Nil || limit < 1 {
		return nil, errors.New("plan goal listing is invalid")
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+headerProjection+headerSource+`
		  WHERE plan.goal_id = $1
		  ORDER BY plan.created_at DESC, plan.id DESC
		  LIMIT $2`,
		goalID, limit,
	)
	if err != nil {
		return nil, errors.New("list goal plans")
	}
	defer rows.Close()
	result := make([]PlanHeader, 0, limit)
	for rows.Next() {
		header, err := scanHeader(rows)
		if err != nil {
			return nil, errors.New("scan plan header")
		}
		result = append(result, header)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate goal plans")
	}
	return result, nil
}

// CreateGenerated opens a generated plan in draft with generation running.
// The goal comes into existence here when the caller has none, so the
// plans_scope_ck invariant (generated plans always name a goal) holds from
// the first row. A goal with a draft or pending plan refuses a second.
func (repository *Repository) CreateGenerated(
	ctx context.Context,
	params CreateGeneratedParams,
) (PlanHeader, []ledger.Event, error) {
	if params.ID == uuid.Nil || params.WorkspaceID == uuid.Nil || params.ActorID == uuid.Nil ||
		strings.TrimSpace(params.Prompt) == "" || params.CreatedAt.IsZero() {
		return PlanHeader{}, nil, errors.New("generated plan parameters are invalid")
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PlanHeader{}, nil, errors.New("begin generated plan")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var events []ledger.Event
	goalID := params.GoalID
	if goalID == nil {
		goal, event, err := goals.CreateIn(ctx, tx, goals.CreateParams{
			ID:           newID(),
			WorkspaceID:  params.WorkspaceID,
			ProjectID:    params.ProjectID,
			Title:        goalTitleFromPrompt(params.Prompt),
			Status:       goals.StatusDraft,
			Source:       goals.SourceAI,
			SourcePrompt: &params.Prompt,
			CreatedBy:    params.ActorID,
			CreatedAt:    params.CreatedAt,
			NewID:        newID,
		})
		if err != nil {
			return PlanHeader{}, nil, err
		}
		goalID = &goal.ID
		events = append(events, event)
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO plans (
		    id, workspace_id, goal_id, board_id, status, source, source_prompt,
		    generation_status, validation_status, compile_status, conversation_id,
		    briefed_by, created_by, auto_gate, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, 'draft', 'ai', $5, 'running', 'unknown', 'not_started', $6, $7, $7, $8, $9, $9)`,
		params.ID, params.WorkspaceID, goalID, params.BoardID, params.Prompt,
		params.ConversationID, params.ActorID, params.AutoGate, params.CreatedAt.UTC(),
	); err != nil {
		return PlanHeader{}, nil, classifyGeneratedWrite("insert generated plan", err)
	}
	header, err := getHeader(ctx, tx, params.ID, false)
	if err != nil {
		return PlanHeader{}, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PlanHeader{}, nil, errors.New("commit generated plan")
	}
	return header, events, nil
}

// goalTitleFromPrompt derives a provisional title; the compile step replaces
// it with the plan's own goal title.
func goalTitleFromPrompt(prompt string) string {
	title := strings.TrimSpace(strings.SplitN(prompt, "\n", 2)[0])
	if len(title) > 120 {
		title = strings.TrimSpace(title[:117]) + "..."
	}
	if title == "" {
		title = "New goal"
	}
	return title
}

// SaveVersion appends one IR snapshot under an optimistic version check and
// makes it the plan's current IR.
func (repository *Repository) SaveVersion(ctx context.Context, params SaveVersionParams) (PlanVersion, error) {
	switch {
	case params.PlanID == uuid.Nil, params.ExpectedVersion < 0, params.CreatedAt.IsZero():
		return PlanVersion{}, errors.New("plan version parameters are invalid")
	case !json.Valid(params.IR):
		return PlanVersion{}, errors.New("plan IR is not valid JSON")
	case params.Origin == "":
		return PlanVersion{}, errors.New("plan version origin is required")
	}
	if params.IRVersion == "" {
		params.IRVersion = "1"
	}
	if len(params.Validation) == 0 {
		params.Validation = json.RawMessage(`{}`)
	}
	if params.CreatedByType == "" {
		params.CreatedByType = "system"
		if params.CreatedBy != nil {
			params.CreatedByType = "user"
		}
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PlanVersion{}, errors.New("begin plan version")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	header, err := getHeader(ctx, tx, params.PlanID, true)
	if err != nil {
		return PlanVersion{}, err
	}
	if header.CurrentVersion != params.ExpectedVersion {
		return PlanVersion{}, ErrVersionConflict
	}
	version := PlanVersion{
		ID: newID(), WorkspaceID: header.WorkspaceID, PlanID: header.ID,
		Version: header.CurrentVersion + 1, Origin: params.Origin,
		IR: params.IR, IRVersion: params.IRVersion, Validation: params.Validation,
		Critic: params.Critic, Patch: params.Patch,
		CreatedByType: params.CreatedByType, CreatedBy: params.CreatedBy, CreatedAt: params.CreatedAt.UTC(),
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO plan_versions (
		    id, workspace_id, plan_id, version, origin, ir, ir_version, validation, critic, patch,
		    created_by_type, created_by, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)`,
		version.ID, version.WorkspaceID, version.PlanID, version.Version, version.Origin,
		string(version.IR), version.IRVersion, string(version.Validation), nullableJSON(version.Critic), nullableJSON(version.Patch),
		version.CreatedByType, version.CreatedBy, version.CreatedAt,
	); err != nil {
		return PlanVersion{}, classifyGeneratedWrite("insert plan version", err)
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE plans
		    SET ir = $2::jsonb, ir_version = $3, current_version = $4,
		        validation_status = COALESCE(NULLIF($5, ''), validation_status),
		        confidence = COALESCE($6, confidence),
		        planner_version = COALESCE($7, planner_version),
		        updated_at = $8
		  WHERE id = $1`,
		params.PlanID, string(version.IR), version.IRVersion, version.Version,
		params.ValidationStatus, params.Confidence, params.PlannerVersion, params.CreatedAt.UTC(),
	); err != nil {
		return PlanVersion{}, classifyGeneratedWrite("update plan header", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PlanVersion{}, errors.New("commit plan version")
	}
	return version, nil
}

func nullableJSON(value json.RawMessage) *string {
	if len(value) == 0 {
		return nil
	}
	text := string(value)
	return &text
}

// SetGeneration records the pipeline state.
func (repository *Repository) SetGeneration(ctx context.Context, planID uuid.UUID, status string, generationError *string, now time.Time) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE plans SET generation_status = $2, generation_error = $3, updated_at = $4 WHERE id = $1`,
		planID, status, generationError, now.UTC(),
	)
	if err != nil {
		return classifyGeneratedWrite("record plan generation", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// FinishGenerationParams closes one pipeline run on the header.
type FinishGenerationParams struct {
	PlanID           uuid.UUID
	Status           string
	Error            *string
	ValidationStatus string
	Confidence       *float64
	PlannerVersion   *string
	Now              time.Time
}

// FinishGeneration records how the pipeline ended: the generation status
// and error, the validator's verdict, and the confidence after repairs.
func (repository *Repository) FinishGeneration(ctx context.Context, params FinishGenerationParams) error {
	if params.PlanID == uuid.Nil || params.Status == "" || params.Now.IsZero() {
		return errors.New("finish generation parameters are invalid")
	}
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE plans
		    SET generation_status = $2, generation_error = $3,
		        validation_status = COALESCE(NULLIF($4, ''), validation_status),
		        confidence = COALESCE($5, confidence),
		        planner_version = COALESCE($6, planner_version),
		        updated_at = $7
		  WHERE id = $1`,
		params.PlanID, params.Status, params.Error, params.ValidationStatus, params.Confidence, params.PlannerVersion, params.Now.UTC(),
	)
	if err != nil {
		return classifyGeneratedWrite("finish plan generation", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// EmitPlanEvent writes one plan.* fact to the outbox for the workspace
// stream and returns it for the live broadcast. Progress facts are written
// outside the stage transactions on purpose: a stage that fails still
// leaves the fact that it ran.
func (repository *Repository) EmitPlanEvent(
	ctx context.Context,
	planID uuid.UUID,
	topic string,
	detail map[string]any,
	newID func() uuid.UUID,
	now time.Time,
) (ledger.Event, error) {
	if planID == uuid.Nil || topic == "" || now.IsZero() {
		return ledger.Event{}, errors.New("plan event parameters are invalid")
	}
	if newID == nil {
		newID = uuid.New
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ledger.Event{}, errors.New("begin plan event")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	header, err := getHeader(ctx, tx, planID, false)
	if err != nil {
		return ledger.Event{}, err
	}
	event, err := writePlanEvent(ctx, tx, topic, header, detail, newID, now)
	if err != nil {
		return ledger.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ledger.Event{}, errors.New("commit plan event")
	}
	return event, nil
}

// DefaultBoard is the workspace's oldest board, where a plan lands when the
// request names none.
func (repository *Repository) DefaultBoard(ctx context.Context, workspaceID uuid.UUID) (uuid.UUID, error) {
	if workspaceID == uuid.Nil {
		return uuid.Nil, errors.New("workspace is required")
	}
	var boardID uuid.UUID
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT id FROM boards WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1`,
		workspaceID,
	).Scan(&boardID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNotFound
	}
	if err != nil {
		return uuid.Nil, errors.New("find default board")
	}
	return boardID, nil
}

// SetValidation records the validator's verdict on the current IR.
func (repository *Repository) SetValidation(ctx context.Context, planID uuid.UUID, status string, now time.Time) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE plans SET validation_status = $2, updated_at = $3 WHERE id = $1`,
		planID, status, now.UTC(),
	)
	if err != nil {
		return classifyGeneratedWrite("record plan validation", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GetVersion returns one snapshot with its IR.
func (repository *Repository) GetVersion(ctx context.Context, planID uuid.UUID, version int) (PlanVersion, error) {
	result, err := scanVersion(repository.Pool.QueryRow(
		ctx,
		`SELECT id, workspace_id, plan_id, version, origin, ir, ir_version, validation, critic, patch,
		        created_by_type, created_by, created_at
		   FROM plan_versions WHERE plan_id = $1 AND version = $2`,
		planID, version,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return PlanVersion{}, ErrNotFound
	}
	if err != nil {
		return PlanVersion{}, errors.New("get plan version")
	}
	return result, nil
}

// ListVersions returns every snapshot, newest first, with their IR.
func (repository *Repository) ListVersions(ctx context.Context, planID uuid.UUID) ([]PlanVersion, error) {
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT id, workspace_id, plan_id, version, origin, ir, ir_version, validation, critic, patch,
		        created_by_type, created_by, created_at
		   FROM plan_versions WHERE plan_id = $1
		  ORDER BY version DESC`,
		planID,
	)
	if err != nil {
		return nil, errors.New("list plan versions")
	}
	defer rows.Close()
	result := []PlanVersion{}
	for rows.Next() {
		version, err := scanVersion(rows)
		if err != nil {
			return nil, errors.New("scan plan version")
		}
		result = append(result, version)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate plan versions")
	}
	return result, nil
}

func scanVersion(row headerScanner) (PlanVersion, error) {
	var (
		version                       PlanVersion
		ir, validation, critic, patch []byte
	)
	if err := row.Scan(
		&version.ID, &version.WorkspaceID, &version.PlanID, &version.Version, &version.Origin,
		&ir, &version.IRVersion, &validation, &critic, &patch,
		&version.CreatedByType, &version.CreatedBy, &version.CreatedAt,
	); err != nil {
		return PlanVersion{}, err
	}
	version.IR = append(json.RawMessage(nil), ir...)
	version.Validation = append(json.RawMessage(nil), validation...)
	if critic != nil {
		version.Critic = append(json.RawMessage(nil), critic...)
	}
	if patch != nil {
		version.Patch = append(json.RawMessage(nil), patch...)
	}
	return version, nil
}

// RecordEvent appends one pipeline stage record. The sequence is allocated
// under the plan's row lock so concurrent stages never collide.
func (repository *Repository) RecordEvent(ctx context.Context, params RecordEventParams) (PlannerEvent, error) {
	if params.PlanID == uuid.Nil || params.Stage == "" || params.Outcome == "" || params.OccurredAt.IsZero() {
		return PlannerEvent{}, errors.New("planner event parameters are invalid")
	}
	if params.ID == uuid.Nil {
		params.ID = uuid.New()
	}
	if len(params.Detail) == 0 {
		params.Detail = json.RawMessage(`{}`)
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PlannerEvent{}, errors.New("begin planner event")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	header, err := getHeader(ctx, tx, params.PlanID, true)
	if err != nil {
		return PlannerEvent{}, err
	}
	event := PlannerEvent{
		ID: params.ID, WorkspaceID: header.WorkspaceID, PlanID: header.ID, Stage: params.Stage,
		Role: params.Role, PromptVersion: params.PromptVersion, ModelProvider: params.ModelProvider,
		ModelName: params.ModelName, InputTokens: params.InputTokens, OutputTokens: params.OutputTokens,
		CostMicros: params.CostMicros, DurationMS: params.DurationMS, Outcome: params.Outcome,
		Detail: params.Detail, OccurredAt: params.OccurredAt.UTC(),
	}
	if err := tx.QueryRow(
		ctx,
		`INSERT INTO planner_events (
		    id, workspace_id, plan_id, sequence, stage, role, prompt_version, model_provider, model_name,
		    input_tokens, output_tokens, cost_micros, duration_ms, outcome, detail, occurred_at
		 ) VALUES (
		    $1, $2, $3,
		    (SELECT COALESCE(MAX(sequence), 0) + 1 FROM planner_events WHERE plan_id = $3),
		    $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15
		 ) RETURNING sequence`,
		event.ID, event.WorkspaceID, event.PlanID, event.Stage, event.Role, event.PromptVersion,
		event.ModelProvider, event.ModelName, event.InputTokens, event.OutputTokens, event.CostMicros,
		event.DurationMS, event.Outcome, string(event.Detail), event.OccurredAt,
	).Scan(&event.Sequence); err != nil {
		return PlannerEvent{}, classifyGeneratedWrite("insert planner event", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PlannerEvent{}, errors.New("commit planner event")
	}
	return event, nil
}

// ListEvents returns the pipeline records in order.
func (repository *Repository) ListEvents(ctx context.Context, planID uuid.UUID) ([]PlannerEvent, error) {
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT id, workspace_id, plan_id, sequence, stage, role, prompt_version, model_provider, model_name,
		        input_tokens, output_tokens, cost_micros, duration_ms, outcome, detail, occurred_at
		   FROM planner_events WHERE plan_id = $1
		  ORDER BY sequence ASC`,
		planID,
	)
	if err != nil {
		return nil, errors.New("list planner events")
	}
	defer rows.Close()
	result := []PlannerEvent{}
	for rows.Next() {
		var (
			event  PlannerEvent
			detail []byte
		)
		if err := rows.Scan(
			&event.ID, &event.WorkspaceID, &event.PlanID, &event.Sequence, &event.Stage, &event.Role,
			&event.PromptVersion, &event.ModelProvider, &event.ModelName, &event.InputTokens, &event.OutputTokens,
			&event.CostMicros, &event.DurationMS, &event.Outcome, &detail, &event.OccurredAt,
		); err != nil {
			return nil, errors.New("scan planner event")
		}
		event.Detail = append(json.RawMessage(nil), detail...)
		result = append(result, event)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate planner events")
	}
	return result, nil
}

// RequestPlanApproval moves a draft plan to pending_approval and opens the
// kind=plan approval a higher role resolves from the inbox.
func (repository *Repository) RequestPlanApproval(
	ctx context.Context,
	params RequestPlanApprovalParams,
) (PlanHeader, approvals.Approval, ledger.Event, error) {
	if params.PlanID == uuid.Nil || params.ActorID == uuid.Nil || params.Now.IsZero() {
		return PlanHeader{}, approvals.Approval{}, ledger.Event{}, errors.New("plan approval request parameters are invalid")
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PlanHeader{}, approvals.Approval{}, ledger.Event{}, errors.New("begin plan approval request")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	header, err := getHeader(ctx, tx, params.PlanID, true)
	if err != nil {
		return PlanHeader{}, approvals.Approval{}, ledger.Event{}, err
	}
	if header.Status != StatusDraft {
		return PlanHeader{}, approvals.Approval{}, ledger.Event{}, ErrNotOpen
	}
	title := params.Title
	if title == "" {
		title = "Start plan"
	}
	approval, event, err := approvals.CreateIn(ctx, tx, approvals.CreateParams{
		ID:                  newID(),
		WorkspaceID:         header.WorkspaceID,
		Kind:                approvals.KindPlan,
		Risk:                params.Risk,
		Title:               title,
		Description:         params.Description,
		GoalID:              header.GoalID,
		PlanID:              &header.ID,
		RequestedFromUserID: params.RequestedFromUserID,
		RequestedFromRole:   params.RequestedFromRole,
		RequestedByType:     approvals.ActorUser,
		RequestedBy:         &params.ActorID,
		RequestedAt:         params.Now,
		NewID:               newID,
	})
	if err != nil {
		return PlanHeader{}, approvals.Approval{}, ledger.Event{}, err
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE plans SET status = 'pending_approval', updated_at = $2 WHERE id = $1`,
		params.PlanID, params.Now.UTC(),
	); err != nil {
		return PlanHeader{}, approvals.Approval{}, ledger.Event{}, classifyGeneratedWrite("request plan approval", err)
	}
	updated, err := getHeader(ctx, tx, params.PlanID, false)
	if err != nil {
		return PlanHeader{}, approvals.Approval{}, ledger.Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PlanHeader{}, approvals.Approval{}, ledger.Event{}, errors.New("commit plan approval request")
	}
	return updated, approval, event, nil
}

// RejectGenerated closes an open generated plan. Nothing was compiled, so
// nothing is released or removed.
func (repository *Repository) RejectGenerated(ctx context.Context, planID uuid.UUID, note string, now time.Time) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE plans
		    SET status = 'rejected', decision_note = NULLIF($2, ''), updated_at = $3
		  WHERE id = $1 AND source <> 'orchestrator' AND status IN ('draft', 'pending_approval')`,
		planID, note, now.UTC(),
	)
	if err != nil {
		return classifyGeneratedWrite("reject generated plan", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotOpen
	}
	return nil
}

// Supersede marks every open plan of a goal superseded before a regenerate.
func (repository *Repository) Supersede(ctx context.Context, goalID uuid.UUID, now time.Time) (int, error) {
	if goalID == uuid.Nil {
		return 0, errors.New("plan goal is required")
	}
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE plans SET status = 'superseded', updated_at = $2
		  WHERE goal_id = $1 AND status IN ('draft', 'pending_approval')`,
		goalID, now.UTC(),
	)
	if err != nil {
		return 0, classifyGeneratedWrite("supersede plans", err)
	}
	return int(tag.RowsAffected()), nil
}

func classifyGeneratedWrite(operation string, err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrNotFound
		case "23505", "23P01":
			if postgresError.ConstraintName == "plans_one_open_per_goal_key" {
				return ErrPlanOpen
			}
			return ErrPlanConflict
		case "23514":
			return ErrPlanConflict
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}
