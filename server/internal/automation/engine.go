package automation

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

// ErrEngineDisabled is what every NoopEngine call returns. Handlers map it to
// 409 WORKFLOW_ENGINE_DISABLED: an external engine is optional and fails
// closed (D2).
var ErrEngineDisabled = errors.New("workflow engine disabled")

// FlowSpec is what an external engine needs to mirror one workflow version.
type FlowSpec struct {
	AutomationID uuid.UUID
	WorkspaceID  uuid.UUID
	Name         string
	Version      int
	Definition   Definition
}

// FlowRef is the engine's handle for a mirrored workflow.
type FlowRef struct {
	FlowID        string
	FlowVersionID string
}

// EngineRunRef is the engine's handle for one started run.
type EngineRunRef struct {
	RunID string
}

// EngineRunStatus is the normalised state of an engine run.
type EngineRunStatus string

const (
	EngineRunRunning   EngineRunStatus = "running"
	EngineRunSucceeded EngineRunStatus = "succeeded"
	EngineRunFailed    EngineRunStatus = "failed"
	EngineRunCancelled EngineRunStatus = "cancelled"
)

// EngineRunState is what Berry records about an engine run; engine data
// structures never become domain state.
type EngineRunState struct {
	RunID          string
	Status         EngineRunStatus
	FailureMessage string
}

// PieceCatalogEntry is one tool an engine exposes.
type PieceCatalogEntry struct {
	Provider    string
	Operation   string
	Kind        ToolKind
	Description string
	InputSchema map[string]any
}

// Engine is an external execution engine behind the adapter (D2). Berry-native
// node types never go through it; only provider nodes it can execute do.
type Engine interface {
	Name() string
	// EnsureFlow is idempotent on spec.AutomationID.
	EnsureFlow(ctx context.Context, spec FlowSpec) (FlowRef, error)
	SetFlowStatus(ctx context.Context, flowID string, enabled bool) error
	DeleteFlow(ctx context.Context, flowID string) error
	StartRun(ctx context.Context, flowID string, input map[string]any, idempotencyKey string) (EngineRunRef, error)
	GetRun(ctx context.Context, engineRunID string) (EngineRunState, error)
	ListPieces(ctx context.Context) ([]PieceCatalogEntry, error)
	RegisterWebhook(ctx context.Context, flowID, targetURL string) error
}

// NoopEngine is the engine when none is configured. It refuses everything so
// a workflow that needs an engine can never be half-activated.
type NoopEngine struct{}

// Name identifies the absent engine.
func (NoopEngine) Name() string { return "none" }

// EnsureFlow refuses.
func (NoopEngine) EnsureFlow(context.Context, FlowSpec) (FlowRef, error) {
	return FlowRef{}, ErrEngineDisabled
}

// SetFlowStatus refuses.
func (NoopEngine) SetFlowStatus(context.Context, string, bool) error { return ErrEngineDisabled }

// DeleteFlow refuses.
func (NoopEngine) DeleteFlow(context.Context, string) error { return ErrEngineDisabled }

// StartRun refuses.
func (NoopEngine) StartRun(context.Context, string, map[string]any, string) (EngineRunRef, error) {
	return EngineRunRef{}, ErrEngineDisabled
}

// GetRun refuses.
func (NoopEngine) GetRun(context.Context, string) (EngineRunState, error) {
	return EngineRunState{}, ErrEngineDisabled
}

// ListPieces refuses.
func (NoopEngine) ListPieces(context.Context) ([]PieceCatalogEntry, error) {
	return nil, ErrEngineDisabled
}

// RegisterWebhook refuses.
func (NoopEngine) RegisterWebhook(context.Context, string, string) error { return ErrEngineDisabled }

var _ Engine = NoopEngine{}
