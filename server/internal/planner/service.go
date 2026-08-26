// Package planner turns one request into one BerryPlan v1 through the model
// roles: intent, context, generate, validate, a bounded repair loop, a
// bounded critic round, finalize. Nothing here writes issues or workflows;
// the plan is stored as versions until a person approves it and the
// compiler runs. Generation is asynchronous: Generate creates the plan row
// and returns, the pipeline runs in a tracked goroutine, and every stage is
// one planner_events row plus a plan.updated fact on the workspace stream.
package planner

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/modelgateway"
	"github.com/laravel42/berry-circle/server/internal/observability"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	"github.com/laravel42/berry-circle/server/internal/planner/validate"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
	"github.com/laravel42/berry-circle/server/internal/repository/plans"
)

// Hint nudges classification when the person already knows what they want.
type Hint string

// Hints.
const (
	HintAuto     Hint = "auto"
	HintIssue    Hint = "issue"
	HintWorkflow Hint = "workflow"
)

// Valid reports whether the hint is one of the three; empty reads as auto.
func (hint Hint) Valid() bool {
	return hint == "" || hint == HintAuto || hint == HintIssue || hint == HintWorkflow
}

// MaxPromptLength bounds the request text, matching plans.source_prompt.
const MaxPromptLength = 20000

var (
	// ErrUnavailable means the planner is disabled or no role agent answers.
	ErrUnavailable = errors.New("planner is unavailable")
	// ErrNoBoard means the workspace has no board to plan onto.
	ErrNoBoard = errors.New("workspace has no board")
	// ErrInvalidInput means the request is malformed; handlers validate first.
	ErrInvalidInput = errors.New("planner input is invalid")
)

// GenerateInput is one request to plan.
type GenerateInput struct {
	ActorID        uuid.UUID
	WorkspaceID    uuid.UUID
	GoalID         *uuid.UUID
	ProjectID      *uuid.UUID
	BoardID        *uuid.UUID
	ConversationID *uuid.UUID
	Prompt         string
	Hint           Hint
}

// Authorizer is the workspace permission check.
type Authorizer interface {
	AuthorizeWorkspace(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Role, error)
}

// Options are the service's explicit dependencies.
type Options struct {
	Gateway       modelgateway.Gateway
	Store         Store
	Sources       Sources
	Authorization Authorizer
	Broadcaster   realtime.Broadcaster
	Clock         func() time.Time
	NewID         func() uuid.UUID
	// WorkerContext bounds every pipeline; cancelling it marks running
	// generations failed with "shutdown".
	WorkerContext context.Context
	// PlannerVersion is recorded on plans.planner_version (the planner
	// prompt version).
	PlannerVersion     string
	MaxRepairs         int
	MaxCriticRounds    int
	Timeout            time.Duration
	ContextBudgetBytes int
	Logger             *slog.Logger
	Metrics            *observability.PlannerMetrics
}

// Service owns the pipeline goroutines.
type Service struct {
	options   Options
	workerCtx context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	mu        sync.Mutex
	running   map[uuid.UUID]struct{}
}

// New validates the options.
func New(options Options) (*Service, error) {
	switch {
	case options.Store == nil:
		return nil, errors.New("planner store is nil")
	case options.Authorization == nil:
		return nil, errors.New("planner authorizer is nil")
	case options.WorkerContext == nil:
		return nil, errors.New("planner worker context is nil")
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.NewID == nil {
		options.NewID = uuid.New
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.Timeout <= 0 {
		options.Timeout = 4 * time.Minute
	}
	if options.MaxRepairs < 0 {
		options.MaxRepairs = 0
	}
	if options.MaxCriticRounds < 0 {
		options.MaxCriticRounds = 0
	}
	if options.ContextBudgetBytes <= 0 {
		options.ContextBudgetBytes = 48 * 1024
	}
	workerCtx, cancel := context.WithCancel(options.WorkerContext)
	return &Service{options: options, workerCtx: workerCtx, cancel: cancel, running: map[uuid.UUID]struct{}{}}, nil
}

// Ready reports whether a plan can be generated now.
func (service *Service) Ready(ctx context.Context) error {
	if service.options.Gateway == nil {
		return ErrUnavailable
	}
	if err := service.options.Gateway.Ready(ctx); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	return nil
}

// Generate authorizes the request, creates the plan row and starts the
// pipeline. It returns the header with generation running and the facts
// the creation wrote (a draft goal, when the request named none); the
// caller publishes those.
func (service *Service) Generate(ctx context.Context, input GenerateInput) (plans.PlanHeader, []ledger.Event, error) {
	prompt := strings.TrimSpace(input.Prompt)
	if input.ActorID == uuid.Nil || input.WorkspaceID == uuid.Nil || prompt == "" || utf8.RuneCountInString(prompt) > MaxPromptLength || !input.Hint.Valid() {
		return plans.PlanHeader{}, nil, ErrInvalidInput
	}
	role, err := service.options.Authorization.AuthorizeWorkspace(ctx, input.ActorID, input.WorkspaceID, identity.PermissionWrite)
	if err != nil {
		return plans.PlanHeader{}, nil, err
	}
	if err := service.Ready(ctx); err != nil {
		return plans.PlanHeader{}, nil, err
	}
	if service.workerCtx.Err() != nil {
		return plans.PlanHeader{}, nil, ErrUnavailable
	}
	boardID := input.BoardID
	if boardID == nil {
		found, err := service.options.Store.DefaultBoard(ctx, input.WorkspaceID)
		if errors.Is(err, plans.ErrNotFound) {
			return plans.PlanHeader{}, nil, ErrNoBoard
		}
		if err != nil {
			return plans.PlanHeader{}, nil, err
		}
		boardID = &found
	}
	input.Prompt = prompt
	input.BoardID = boardID
	if input.Hint == "" {
		input.Hint = HintAuto
	}
	header, events, err := service.options.Store.CreateGenerated(ctx, plans.CreateGeneratedParams{
		ID: service.options.NewID(), WorkspaceID: input.WorkspaceID, GoalID: input.GoalID, BoardID: boardID, ProjectID: input.ProjectID,
		Prompt: prompt, ActorID: input.ActorID, ConversationID: input.ConversationID, CreatedAt: service.options.Clock().UTC(), NewID: service.options.NewID,
	})
	if err != nil {
		return plans.PlanHeader{}, nil, err
	}
	permissions := validate.Permissions{
		Role: string(role), CanWrite: role.Allows(identity.PermissionWrite),
		CanActivateHighRisk: role.Allows(identity.PermissionSettingsWrite), Known: true,
	}
	service.mu.Lock()
	service.running[header.ID] = struct{}{}
	service.mu.Unlock()
	service.wg.Add(1)
	go service.execute(header, input, permissions)
	return header, events, nil
}

// Running reports whether this process is generating the plan.
func (service *Service) Running(planID uuid.UUID) bool {
	service.mu.Lock()
	defer service.mu.Unlock()
	_, ok := service.running[planID]
	return ok
}

func (service *Service) execute(header plans.PlanHeader, input GenerateInput, permissions validate.Permissions) {
	defer service.wg.Done()
	defer func() {
		service.mu.Lock()
		delete(service.running, header.ID)
		service.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(service.workerCtx, service.options.Timeout)
	defer cancel()
	pipeline := &run{service: service, header: header, input: input, permissions: permissions}
	pipeline.execute(ctx)
}

// Close drains running generations, cancelling them when the context ends.
func (service *Service) Close(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		service.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		service.cancel()
		return nil
	case <-ctx.Done():
		service.cancel()
		<-done
		return ctx.Err()
	}
}

// Report validates a stored plan the way the pipeline does, with the
// workspace's agents, issues and workflows, so a read shows the same
// findings a generation produced. Sources that cannot be read fall back to
// the pure rules.
func (service *Service) Report(ctx context.Context, header plans.PlanHeader, plan ir.Plan, permissions validate.Permissions, catalog automation.Catalog) validate.Report {
	input := validate.Input{Plan: plan, Catalog: catalog, Permissions: permissions, Workspace: validate.Workspace{ID: header.WorkspaceID}}
	sources := service.options.Sources
	if sources.Workspace != nil {
		if data, err := sources.Workspace.Workspace(ctx, header.WorkspaceID); err == nil {
			input.Workspace.Boards, input.Workspace.Projects, input.Workspace.Members = data.Boards, data.Projects, data.Members
		}
	}
	if header.ProjectID != nil && sources.Project != nil {
		if project, err := sources.Project.Project(ctx, header.WorkspaceID, *header.ProjectID); err == nil {
			input.Workspace.HasProject = true
			input.Workspace.HasRepository = project.Repository != ""
		}
	}
	if sources.Agents != nil {
		if agents, err := sources.Agents.Agents(ctx, header.WorkspaceID); err == nil {
			input.Agents = agents
		}
	}
	if sources.Issues != nil {
		if issues, err := sources.Issues.OpenIssues(ctx, header.WorkspaceID, MaxOpenIssuesRead); err == nil {
			input.ExistingIssues = issues
		}
	}
	if sources.Workflows != nil {
		if workflows, err := sources.Workflows.Workflows(ctx, header.WorkspaceID); err == nil {
			input.ExistingWorkflows = workflows
		}
	}
	return validate.Validate(input)
}

// publish delivers committed facts to the live stream.
func (service *Service) publish(ctx context.Context, events []ledger.Event) {
	shared.PublishLedger(ctx, service.options.Broadcaster, events)
}
