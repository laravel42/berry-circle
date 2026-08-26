package automationrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/repository/approvals"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/goals"
	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

// fakeStore is an in-memory run ledger with the repository's transition
// rules, so the runner is tested against the same refusals it meets in
// production.
type fakeStore struct {
	mu          sync.Mutex
	automation  automationrepo.Automation
	version     automationrepo.Version
	runs        map[uuid.UUID]*automationrepo.Run
	steps       map[uuid.UUID][]automationrepo.StepRun
	topics      []string
	agentEvents []automationrepo.AgentEventParams
	origins     []automationrepo.IssueOriginParams
	usage       []automation.Usage
}

func newFakeStore(item automationrepo.Automation, definition json.RawMessage) *fakeStore {
	return &fakeStore{
		automation: item,
		version:    automationrepo.Version{AutomationID: item.ID, Version: item.Version, Definition: definition},
		runs:       map[uuid.UUID]*automationrepo.Run{},
		steps:      map[uuid.UUID][]automationrepo.StepRun{},
	}
}

func (store *fakeStore) event(topic string) automationrepo.Event {
	store.topics = append(store.topics, topic)
	return automationrepo.Event{ID: uuid.New(), Type: topic, WorkspaceID: store.automation.WorkspaceID, OccurredAt: time.Now()}
}

func (store *fakeStore) Get(_ context.Context, id uuid.UUID) (automationrepo.Automation, error) {
	if id != store.automation.ID {
		return automationrepo.Automation{}, automationrepo.ErrNotFound
	}
	return store.automation, nil
}

func (store *fakeStore) GetVersion(_ context.Context, id uuid.UUID, version int) (automationrepo.Version, error) {
	if id != store.automation.ID || version != store.version.Version {
		return automationrepo.Version{}, automationrepo.ErrNotFound
	}
	return store.version, nil
}

func (store *fakeStore) GetRun(_ context.Context, id uuid.UUID) (automationrepo.Run, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	run, ok := store.runs[id]
	if !ok {
		return automationrepo.Run{}, automationrepo.ErrNotFound
	}
	return *run, nil
}

func (store *fakeStore) GetRunWithSteps(ctx context.Context, id uuid.UUID) (automationrepo.Run, []automationrepo.StepRun, error) {
	run, err := store.GetRun(ctx, id)
	if err != nil {
		return automationrepo.Run{}, nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return run, append([]automationrepo.StepRun(nil), store.steps[id]...), nil
}

func (store *fakeStore) transition(id uuid.UUID, topic string, check func(*automationrepo.Run) error, apply func(*automationrepo.Run)) (automationrepo.Run, automationrepo.Event, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	run, ok := store.runs[id]
	if !ok {
		return automationrepo.Run{}, automationrepo.Event{}, automationrepo.ErrNotFound
	}
	if err := check(run); err != nil {
		return automationrepo.Run{}, automationrepo.Event{}, err
	}
	apply(run)
	return *run, store.event(topic), nil
}

func (store *fakeStore) MarkRunning(_ context.Context, id uuid.UUID, now time.Time, _ func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error) {
	return store.transition(id, "workflow.run.started", func(run *automationrepo.Run) error {
		if run.Status != automationrepo.RunPending {
			return automationrepo.ErrRunState
		}
		return nil
	}, func(run *automationrepo.Run) {
		run.Status = automationrepo.RunRunning
		run.StartedAt = &now
	})
}

func (store *fakeStore) MarkWaiting(_ context.Context, id uuid.UUID, stepID, waitingOn string, resumeAt *time.Time, _ time.Time, _ func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error) {
	return store.transition(id, "workflow.run.waiting", func(run *automationrepo.Run) error {
		if run.Status != automationrepo.RunRunning {
			return automationrepo.ErrRunState
		}
		return nil
	}, func(run *automationrepo.Run) {
		run.Status = automationrepo.RunWaiting
		run.CurrentStepID = &stepID
		run.WaitingOn = &waitingOn
		run.ResumeAt = resumeAt
	})
}

func (store *fakeStore) Resume(_ context.Context, id uuid.UUID, _ time.Time, _ func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error) {
	return store.transition(id, "workflow.run.resumed", func(run *automationrepo.Run) error {
		if run.Status != automationrepo.RunWaiting {
			return automationrepo.ErrRunState
		}
		return nil
	}, func(run *automationrepo.Run) {
		run.Status = automationrepo.RunRunning
		run.WaitingOn = nil
		run.ResumeAt = nil
	})
}

func (store *fakeStore) CompleteSuccess(_ context.Context, id uuid.UUID, now time.Time, _ func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error) {
	return store.transition(id, "workflow.run.succeeded", func(run *automationrepo.Run) error {
		if run.Status != automationrepo.RunRunning {
			return automationrepo.ErrRunState
		}
		return nil
	}, func(run *automationrepo.Run) {
		run.Status = automationrepo.RunSucceeded
		run.CompletedAt = &now
	})
}

func (store *fakeStore) Fail(_ context.Context, id uuid.UUID, failure automationrepo.Failure, now time.Time, _ func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error) {
	return store.transition(id, "workflow.run.failed", func(run *automationrepo.Run) error {
		if run.Status.Terminal() {
			return automationrepo.ErrRunTerminal
		}
		return nil
	}, func(run *automationrepo.Run) {
		run.Status = automationrepo.RunFailed
		run.Failure = &failure
		run.CompletedAt = &now
	})
}

func (store *fakeStore) AddUsage(_ context.Context, id uuid.UUID, usage automation.Usage, _ time.Time) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	run, ok := store.runs[id]
	if !ok {
		return automationrepo.ErrNotFound
	}
	run.Usage.InputTokens += usage.InputTokens
	run.Usage.OutputTokens += usage.OutputTokens
	store.usage = append(store.usage, usage)
	return nil
}

func (store *fakeStore) insertStep(params automationrepo.StartStepParams, status automationrepo.StepStatus) (automationrepo.StepRun, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	run, ok := store.runs[params.RunID]
	if !ok {
		return automationrepo.StepRun{}, automationrepo.ErrNotFound
	}
	if run.Status.Terminal() {
		return automationrepo.StepRun{}, automationrepo.ErrRunTerminal
	}
	for _, existing := range store.steps[params.RunID] {
		if existing.StepID == params.StepID && existing.Attempt == params.Attempt {
			return automationrepo.StepRun{}, automationrepo.ErrConflict
		}
	}
	row := automationrepo.StepRun{
		ID: params.ID, WorkspaceID: run.WorkspaceID, RunID: params.RunID, StepID: params.StepID,
		StepType: params.StepType, Attempt: params.Attempt, Status: status, Input: params.Input, CreatedAt: params.Now,
	}
	store.steps[params.RunID] = append(store.steps[params.RunID], row)
	return row, nil
}

func (store *fakeStore) StartStep(_ context.Context, params automationrepo.StartStepParams) (automationrepo.StepRun, automationrepo.Event, error) {
	row, err := store.insertStep(params, automationrepo.StepRunning)
	if err != nil {
		return automationrepo.StepRun{}, automationrepo.Event{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.runs[params.RunID].CurrentStepID = &row.StepID
	return row, store.event("workflow.step.started"), nil
}

func (store *fakeStore) RecordSkippedStep(_ context.Context, params automationrepo.StartStepParams) (automationrepo.StepRun, automationrepo.Event, error) {
	row, err := store.insertStep(params, automationrepo.StepSkipped)
	if err != nil {
		return automationrepo.StepRun{}, automationrepo.Event{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return row, store.event("workflow.step.skipped"), nil
}

func (store *fakeStore) updateStep(id uuid.UUID, topic string, check func(automationrepo.StepRun) error, apply func(*automationrepo.StepRun)) (automationrepo.StepRun, automationrepo.Event, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	for runID, rows := range store.steps {
		for index := range rows {
			if rows[index].ID != id {
				continue
			}
			if err := check(rows[index]); err != nil {
				return automationrepo.StepRun{}, automationrepo.Event{}, err
			}
			apply(&rows[index])
			store.steps[runID] = rows
			return rows[index], store.event(topic), nil
		}
	}
	return automationrepo.StepRun{}, automationrepo.Event{}, automationrepo.ErrNotFound
}

func (store *fakeStore) CompleteStep(_ context.Context, id uuid.UUID, output json.RawMessage, usage *automation.Usage, links automationrepo.StepLinks, now time.Time, _ func() uuid.UUID) (automationrepo.StepRun, automationrepo.Event, error) {
	row, event, err := store.updateStep(id, "workflow.step.succeeded", func(step automationrepo.StepRun) error {
		if step.Status != automationrepo.StepRunning && step.Status != automationrepo.StepWaiting {
			return automationrepo.ErrStepState
		}
		return nil
	}, func(step *automationrepo.StepRun) {
		step.Status = automationrepo.StepSucceeded
		step.Output = output
		step.CompletedAt = &now
		if usage != nil {
			step.Usage, _ = json.Marshal(usage)
		}
		applyLinks(step, links)
	})
	if err == nil && usage != nil {
		store.mu.Lock()
		if run, ok := store.runs[row.RunID]; ok {
			run.Usage.InputTokens += usage.InputTokens
			run.Usage.OutputTokens += usage.OutputTokens
		}
		store.mu.Unlock()
	}
	return row, event, err
}

func (store *fakeStore) FailStep(_ context.Context, id uuid.UUID, failure automationrepo.Failure, now time.Time, _ func() uuid.UUID) (automationrepo.StepRun, automationrepo.Event, error) {
	return store.updateStep(id, "workflow.step.failed", func(step automationrepo.StepRun) error {
		if step.Status.Terminal() {
			return automationrepo.ErrStepState
		}
		return nil
	}, func(step *automationrepo.StepRun) {
		step.Status = automationrepo.StepFailed
		step.Failure = &failure
		step.CompletedAt = &now
	})
}

func (store *fakeStore) WaitStep(_ context.Context, id uuid.UUID, _ string, links automationrepo.StepLinks, _ time.Time, _ func() uuid.UUID) (automationrepo.StepRun, automationrepo.Event, error) {
	return store.updateStep(id, "workflow.step.waiting", func(step automationrepo.StepRun) error {
		if step.Status != automationrepo.StepRunning && step.Status != automationrepo.StepWaiting {
			return automationrepo.ErrStepState
		}
		return nil
	}, func(step *automationrepo.StepRun) {
		step.Status = automationrepo.StepWaiting
		applyLinks(step, links)
	})
}

func applyLinks(step *automationrepo.StepRun, links automationrepo.StepLinks) {
	if links.IssueRunID != nil {
		step.IssueRunID = links.IssueRunID
	}
	if links.IssueID != nil {
		step.IssueID = links.IssueID
	}
	if links.ApprovalID != nil {
		step.ApprovalID = links.ApprovalID
	}
}

func (store *fakeStore) RecordIssueOrigin(_ context.Context, params automationrepo.IssueOriginParams) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.origins = append(store.origins, params)
	return nil
}

func (store *fakeStore) RecordAgentEvent(_ context.Context, params automationrepo.AgentEventParams) (automationrepo.Event, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.agentEvents = append(store.agentEvents, params)
	return store.event(params.Topic), nil
}

func (store *fakeStore) stepsOf(runID uuid.UUID) map[string]automationrepo.StepRun {
	store.mu.Lock()
	defer store.mu.Unlock()
	return latestByStep(store.steps[runID])
}

// fakeIssues is the issue store with just enough state to resolve what it
// created.
type fakeIssues struct {
	mu          sync.Mutex
	workspaceID uuid.UUID
	boardID     uuid.UUID
	issues      map[uuid.UUID]core.Issue
	created     []core.CreateIssueParams
	updates     []core.UpdateIssueParams
	updateErr   error
	comments    []core.CreateCommentParams
	number      int32
}

func (issues *fakeIssues) CreateIssue(_ context.Context, params core.CreateIssueParams) (core.Issue, []core.IssueMutationEvent, error) {
	issues.mu.Lock()
	defer issues.mu.Unlock()
	issues.number++
	issue := core.Issue{
		ID: params.ID, BoardID: params.BoardID, WorkspaceID: issues.workspaceID, IssuePrefix: "TST", Number: issues.number,
		Title: params.Title, Description: params.Description, Status: params.Status, Priority: params.Priority,
	}
	if params.Assignee != nil {
		issue.Assignee = &core.ActorRef{Type: params.Assignee.Type, ID: params.Assignee.ID}
	}
	if issues.issues == nil {
		issues.issues = map[uuid.UUID]core.Issue{}
	}
	issues.issues[issue.ID] = issue
	issues.created = append(issues.created, params)
	return issue, []core.IssueMutationEvent{{ID: uuid.New(), Type: "issue.created", WorkspaceID: issues.workspaceID, BoardID: issue.BoardID, IssueID: issue.ID}}, nil
}

func (issues *fakeIssues) UpdateIssue(_ context.Context, params core.UpdateIssueParams) (core.Issue, []core.IssueMutationEvent, error) {
	issues.mu.Lock()
	defer issues.mu.Unlock()
	issues.updates = append(issues.updates, params)
	if issues.updateErr != nil {
		return core.Issue{}, nil, issues.updateErr
	}
	issue, ok := issues.issues[params.IssueID]
	if !ok {
		return core.Issue{}, nil, core.ErrNotFound
	}
	if params.Patch.Status != nil {
		issue.Status = *params.Patch.Status
	}
	if params.Patch.Title != nil {
		issue.Title = *params.Patch.Title
	}
	if params.Patch.AssigneeSet && params.Patch.Assignee != nil {
		issue.Assignee = &core.ActorRef{Type: params.Patch.Assignee.Type, ID: params.Patch.Assignee.ID}
	}
	issues.issues[issue.ID] = issue
	return issue, []core.IssueMutationEvent{{ID: uuid.New(), Type: "issue.updated", WorkspaceID: issues.workspaceID, IssueID: issue.ID}}, nil
}

func (issues *fakeIssues) GetIssue(_ context.Context, reference string) (core.Issue, error) {
	issues.mu.Lock()
	defer issues.mu.Unlock()
	for _, issue := range issues.issues {
		if issue.ID.String() == reference || strings.EqualFold(issue.Identifier(), reference) {
			return issue, nil
		}
	}
	return core.Issue{}, core.ErrNotFound
}

func (issues *fakeIssues) ListIssues(context.Context, core.IssueListFilter) ([]core.Issue, error) {
	issues.mu.Lock()
	defer issues.mu.Unlock()
	result := make([]core.Issue, 0, len(issues.issues))
	for _, issue := range issues.issues {
		result = append(result, issue)
	}
	return result, nil
}

func (issues *fakeIssues) CreateComment(_ context.Context, params core.CreateCommentParams, _ uuid.UUID) (core.Comment, core.CommentMutationEvent, error) {
	issues.mu.Lock()
	defer issues.mu.Unlock()
	issues.comments = append(issues.comments, params)
	return core.Comment{ID: params.ID, IssueID: params.IssueID, Body: params.Body}, core.CommentMutationEvent{ID: uuid.New(), Type: "comment.created"}, nil
}

func (issues *fakeIssues) seed(issue core.Issue) {
	issues.mu.Lock()
	defer issues.mu.Unlock()
	if issues.issues == nil {
		issues.issues = map[uuid.UUID]core.Issue{}
	}
	issues.issues[issue.ID] = issue
}

type fakeApprovals struct {
	mu        sync.Mutex
	approvals map[uuid.UUID]approvals.Approval
	created   []approvals.CreateParams
}

func (store *fakeApprovals) Create(_ context.Context, params approvals.CreateParams) (approvals.Approval, approvals.Event, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.approvals == nil {
		store.approvals = map[uuid.UUID]approvals.Approval{}
	}
	approval := approvals.Approval{
		ID: params.ID, WorkspaceID: params.WorkspaceID, Kind: params.Kind, Risk: params.Risk, Title: params.Title,
		RequestedFromUserID: params.RequestedFromUserID, RequestedFromRole: params.RequestedFromRole,
		Status: approvals.StatusPending, RequestedAt: params.RequestedAt, ExpiresAt: params.ExpiresAt,
	}
	store.approvals[approval.ID] = approval
	store.created = append(store.created, params)
	return approval, approvals.Event{ID: uuid.New(), Type: "approval.requested", WorkspaceID: params.WorkspaceID}, nil
}

func (store *fakeApprovals) Get(_ context.Context, id uuid.UUID) (approvals.Approval, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	approval, ok := store.approvals[id]
	if !ok {
		return approvals.Approval{}, approvals.ErrNotFound
	}
	return approval, nil
}

type fakeGoals struct {
	mu    sync.Mutex
	goal  goals.Goal
	links [][3]uuid.UUID
}

func (store *fakeGoals) Get(_ context.Context, id uuid.UUID) (goals.Goal, error) {
	if id != store.goal.ID {
		return goals.Goal{}, goals.ErrNotFound
	}
	return store.goal, nil
}

func (store *fakeGoals) Create(_ context.Context, params goals.CreateParams) (goals.Goal, goals.Event, error) {
	return goals.Goal{ID: params.ID, WorkspaceID: params.WorkspaceID, Title: params.Title, Status: params.Status}, goals.Event{ID: uuid.New(), Type: "goal.created"}, nil
}

func (store *fakeGoals) Update(_ context.Context, id uuid.UUID, patch goals.Patch, _ uuid.UUID, _ time.Time, _ func() uuid.UUID) (goals.Goal, goals.Event, error) {
	goal := store.goal
	if patch.Title != nil {
		goal.Title = *patch.Title
	}
	return goal, goals.Event{ID: uuid.New(), Type: "goal.updated"}, nil
}

func (store *fakeGoals) Transition(_ context.Context, _ uuid.UUID, to goals.Status, _ *uuid.UUID, _ time.Time, _ func() uuid.UUID) (goals.Goal, goals.Event, error) {
	goal := store.goal
	goal.Status = to
	return goal, goals.Event{ID: uuid.New(), Type: "goal.updated"}, nil
}

func (store *fakeGoals) Progress(context.Context, uuid.UUID) (goals.Progress, error) {
	return goals.Progress{IssuesTotal: 2, IssuesDone: 1}, nil
}

func (store *fakeGoals) LinkIssue(_ context.Context, workspaceID, goalID, issueID, _ uuid.UUID, _ time.Time) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.links = append(store.links, [3]uuid.UUID{workspaceID, goalID, issueID})
	return nil
}

type fakeIssueRuns struct {
	mu       sync.Mutex
	admitted []runs.AdmitParams
	queued   []uuid.UUID
	admitErr error
	runs     map[uuid.UUID]runs.Run
}

func (store *fakeIssueRuns) Admit(_ context.Context, params runs.AdmitParams) (runs.Run, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.admitted = append(store.admitted, params)
	if store.admitErr != nil {
		return runs.Run{}, store.admitErr
	}
	agentID := uuid.Nil
	if params.AgentID != nil {
		agentID = *params.AgentID
	}
	issueID, _ := uuid.Parse(params.IssueRef)
	run := runs.Run{ID: params.RunID, IssueID: issueID, WorkspaceID: params.WorkspaceID, AgentID: agentID, Status: runs.StatusQueued}
	if store.runs == nil {
		store.runs = map[uuid.UUID]runs.Run{}
	}
	store.runs[run.ID] = run
	return run, nil
}

func (store *fakeIssueRuns) Queue(id uuid.UUID) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.queued = append(store.queued, id)
	return nil
}

func (store *fakeIssueRuns) Get(_ context.Context, id uuid.UUID) (runs.Run, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	run, ok := store.runs[id]
	if !ok {
		return runs.Run{}, runs.ErrNotFound
	}
	return run, nil
}

func (store *fakeIssueRuns) finish(id uuid.UUID, status runs.Status, summary string, failure *runs.Failure) {
	store.mu.Lock()
	defer store.mu.Unlock()
	run := store.runs[id]
	run.Status = status
	run.Failure = failure
	if summary != "" {
		run.Summary = &summary
	}
	run.Usage = runs.Usage{InputTokens: 100, OutputTokens: 20}
	store.runs[id] = run
}

type fakeArtifacts struct {
	artifacts []collaboration.Attachment
}

func (store *fakeArtifacts) ListRunArtifacts(context.Context, uuid.UUID, *collaboration.AttachmentCursor, int) ([]collaboration.Attachment, error) {
	return store.artifacts, nil
}

type fakeResponder struct {
	mu       sync.Mutex
	reply    openfang.AgentReply
	err      error
	messages []openfang.MessageRequest
	agents   []uuid.UUID
}

func (responder *fakeResponder) SendAgentMessage(_ context.Context, agentID uuid.UUID, request openfang.MessageRequest) (openfang.AgentReply, error) {
	responder.mu.Lock()
	defer responder.mu.Unlock()
	responder.messages = append(responder.messages, request)
	responder.agents = append(responder.agents, agentID)
	return responder.reply, responder.err
}

type fakeAgents struct {
	agents map[uuid.UUID]AgentRef
	byCap  *AgentRef
}

func (directory fakeAgents) Agent(_ context.Context, _ uuid.UUID, id uuid.UUID) (AgentRef, error) {
	agent, ok := directory.agents[id]
	if !ok {
		return AgentRef{}, ErrAgentNotFound
	}
	return agent, nil
}

func (directory fakeAgents) FindByCapabilities(context.Context, uuid.UUID, []string) (AgentRef, error) {
	if directory.byCap == nil {
		return AgentRef{}, ErrAgentNotFound
	}
	return *directory.byCap, nil
}

type fakeBoards struct {
	workspaceID uuid.UUID
	boardID     uuid.UUID
}

func (boards fakeBoards) DefaultBoard(context.Context, uuid.UUID) (uuid.UUID, error) {
	return boards.boardID, nil
}

func (boards fakeBoards) BoardWorkspace(_ context.Context, boardID uuid.UUID) (uuid.UUID, error) {
	if boardID != boards.boardID {
		return uuid.Nil, ErrBoardNotFound
	}
	return boards.workspaceID, nil
}

// fixture is one runner over fakes with one pending run.
type fixture struct {
	runner    *Runner
	store     *fakeStore
	issues    *fakeIssues
	approvals *fakeApprovals
	goals     *fakeGoals
	issueRuns *fakeIssueRuns
	artifacts *fakeArtifacts
	responder *fakeResponder
	agent     AgentRef
	runID     uuid.UUID
	now       time.Time
	userID    uuid.UUID
}

// newFixture builds the runner over fakes. An empty definition is allowed
// for tests that need the fixture's agent id inside the definition; they
// call setDefinition afterwards.
func newFixture(t *testing.T, definition string, trigger map[string]any) *fixture {
	t.Helper()
	if definition != "" {
		if _, findings := automation.ParseDefinition([]byte(definition)); len(findings) > 0 {
			t.Fatalf("definition does not parse: %+v", findings)
		}
	}
	workspaceID, boardID, userID, goalID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	item := automationrepo.Automation{
		ID: uuid.New(), WorkspaceID: workspaceID, GoalID: &goalID, Name: "Test", Status: automationrepo.StatusActive,
		Version: 1, Risk: automation.RiskMedium, CreatedBy: &userID,
	}
	store := newFakeStore(item, json.RawMessage(definition))
	payload, _ := json.Marshal(trigger)
	runID := uuid.New()
	store.runs[runID] = &automationrepo.Run{
		ID: runID, WorkspaceID: workspaceID, AutomationID: item.ID, AutomationVersion: 1, GoalID: &goalID,
		Status: automationrepo.RunPending, TriggerType: automation.TriggerBerryEvent, TriggerPayload: payload,
		RequestedBy: &userID,
	}
	agent := AgentRef{ID: uuid.New(), UpstreamID: uuid.New(), Name: "writer"}
	fake := &fixture{
		store:     store,
		issues:    &fakeIssues{workspaceID: workspaceID, boardID: boardID},
		approvals: &fakeApprovals{},
		goals:     &fakeGoals{goal: goals.Goal{ID: goalID, WorkspaceID: workspaceID, Title: "Ship it", Status: goals.StatusActive}},
		issueRuns: &fakeIssueRuns{},
		artifacts: &fakeArtifacts{},
		responder: &fakeResponder{},
		agent:     agent,
		runID:     runID,
		now:       time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC),
		userID:    userID,
	}
	runner, err := New(Options{
		Store: store, Issues: fake.issues, Approvals: fake.approvals, Goals: fake.goals, IssueRuns: fake.issueRuns,
		Artifacts: fake.artifacts, Responder: fake.responder,
		Agents: fakeAgents{agents: map[uuid.UUID]AgentRef{agent.ID: agent}, byCap: &agent},
		Boards: fakeBoards{workspaceID: workspaceID, boardID: boardID},
		Clock:  func() time.Time { return fake.now }, NewID: uuid.New,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	fake.runner = runner
	return fake
}

func (fake *fixture) setDefinition(t *testing.T, definition string) {
	t.Helper()
	if _, findings := automation.ParseDefinition([]byte(definition)); len(findings) > 0 {
		t.Fatalf("definition does not parse: %+v", findings)
	}
	fake.store.version.Definition = json.RawMessage(definition)
}

func (fake *fixture) execute() { fake.runner.Execute(context.Background(), fake.runID) }

func (fake *fixture) run(t *testing.T) automationrepo.Run {
	t.Helper()
	run, err := fake.store.GetRun(context.Background(), fake.runID)
	if err != nil {
		t.Fatalf("GetRun() error = %v", err)
	}
	return run
}

func (fake *fixture) step(t *testing.T, id string) automationrepo.StepRun {
	t.Helper()
	step, ok := fake.store.stepsOf(fake.runID)[id]
	if !ok {
		t.Fatalf("step %q has no row; steps = %+v", id, fake.store.stepsOf(fake.runID))
	}
	return step
}

func output(t *testing.T, step automationrepo.StepRun) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(step.Output, &decoded); err != nil {
		t.Fatalf("step %s output %s: %v", step.StepID, step.Output, err)
	}
	return decoded
}

func definitionJSON(trigger string, steps ...string) string {
	return fmt.Sprintf(`{"version":"1","trigger":%s,"entry":["%s"],"steps":[%s]}`,
		trigger, firstID(steps[0]), strings.Join(steps, ","))
}

func firstID(step string) string {
	var header struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(step), &header)
	return header.ID
}

const berryTrigger = `{"id":"on_done","type":"berry_event","event":"issue.completed"}`

// A condition takes one branch, the other is pruned as skipped rows, and a
// step behind the taken branch runs with the created issue in scope.
func TestRunnerWalksBranchesAndPrunesTheUntakenOne(t *testing.T) {
	t.Parallel()
	fake := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"check","type":"condition","expression":{"op":"equals","left":{"ref":"trigger.issue.status"},"right":"done"},"trueSteps":["notify"],"falseSteps":["other"]}`,
		`{"id":"notify","type":"create_issue","title":"Follow up {{ trigger.issue.identifier }}","goalId":"{{ goal.id }}"}`,
		`{"id":"other","type":"create_issue","title":"Never"}`,
		`{"id":"after","type":"create_issue","title":"After {{ steps.notify.output.identifier }}","dependsOn":["notify"]}`,
	), map[string]any{"issue": map[string]any{"status": "done", "identifier": "BER-7"}})
	fake.execute()
	if run := fake.run(t); run.Status != automationrepo.RunSucceeded {
		t.Fatalf("run = %+v", run)
	}
	if got := output(t, fake.step(t, "check")); got["result"] != true {
		t.Fatalf("condition output = %v", got)
	}
	if fake.step(t, "other").Status != automationrepo.StepSkipped {
		t.Fatalf("untaken branch = %+v", fake.step(t, "other"))
	}
	notify, after := fake.step(t, "notify"), fake.step(t, "after")
	if notify.Status != automationrepo.StepSucceeded || after.Status != automationrepo.StepSucceeded {
		t.Fatalf("notify = %+v, after = %+v", notify, after)
	}
	if got := output(t, after)["title"]; got != "After TST-1" {
		t.Fatalf("after title = %v, want the first issue's identifier", got)
	}
	if len(fake.issues.created) != 2 || fake.issues.created[0].Title != "Follow up BER-7" || fake.issues.created[0].CreatedBy != fake.userID {
		t.Fatalf("created issues = %+v", fake.issues.created)
	}
	if len(fake.store.origins) != 2 || fake.store.origins[0].RunID != fake.runID || fake.store.origins[0].StepRunID == nil {
		t.Fatalf("origins = %+v", fake.store.origins)
	}
	if len(fake.goals.links) != 2 || fake.goals.links[0][1] != fake.goals.goal.ID {
		t.Fatalf("goal links = %+v", fake.goals.links)
	}
}

func TestRunnerParksOnTimerAndResumesOnTheSignal(t *testing.T) {
	t.Parallel()
	fake := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"pause","type":"wait","mode":"duration","duration":"PT5M"}`,
		`{"id":"then","type":"create_issue","title":"Later","dependsOn":["pause"]}`,
	), nil)
	fake.execute()
	run := fake.run(t)
	if run.Status != automationrepo.RunWaiting || run.WaitingOn == nil || *run.WaitingOn != "timer" ||
		run.ResumeAt == nil || !run.ResumeAt.Equal(fake.now.Add(5*time.Minute)) {
		t.Fatalf("run = %+v", run)
	}
	if fake.step(t, "pause").Status != automationrepo.StepWaiting {
		t.Fatalf("pause = %+v", fake.step(t, "pause"))
	}
	// The scheduler's claim returns the run to running before the signal.
	fake.store.runs[fake.runID].Status = automationrepo.RunRunning
	fake.store.runs[fake.runID].WaitingOn = nil
	fake.runner.Resume(context.Background(), fake.runID, ResumeSignal{Kind: SignalTimer, OccurredAt: fake.now})
	if run := fake.run(t); run.Status != automationrepo.RunSucceeded {
		t.Fatalf("run after timer = %+v", run)
	}
	if fake.step(t, "pause").Status != automationrepo.StepSucceeded || fake.step(t, "then").Status != automationrepo.StepSucceeded {
		t.Fatalf("steps = %+v", fake.store.stepsOf(fake.runID))
	}
}

func TestRunnerApprovalOutcomes(t *testing.T) {
	t.Parallel()
	definition := definitionJSON(berryTrigger,
		`{"id":"gate","type":"approval","title":"Deploy {{ trigger.issue.identifier }} to production?","approver":{"type":"role","role":"admin"},"timeout":"P2D"}`,
		`{"id":"ship","type":"create_issue","title":"Ship","dependsOn":["gate"]}`,
	)
	cases := []struct {
		name       string
		outcome    string
		wantRun    automationrepo.RunStatus
		wantStep   automationrepo.StepStatus
		wantCode   string
		wantIssues int
	}{
		{name: "approved resumes", outcome: "approved", wantRun: automationrepo.RunSucceeded, wantStep: automationrepo.StepSucceeded, wantIssues: 1},
		{name: "rejected fails", outcome: "rejected", wantRun: automationrepo.RunFailed, wantStep: automationrepo.StepFailed, wantCode: "APPROVAL_REJECTED"},
		{name: "expired fails", outcome: "expired", wantRun: automationrepo.RunFailed, wantStep: automationrepo.StepFailed, wantCode: "APPROVAL_EXPIRED"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fake := newFixture(t, definition, map[string]any{"issue": map[string]any{"identifier": "BER-1"}})
			fake.execute()
			run := fake.run(t)
			if len(fake.approvals.created) != 1 {
				t.Fatalf("approvals = %+v", fake.approvals.created)
			}
			created := fake.approvals.created[0]
			if created.Kind != approvals.KindAutomationStep || created.RequestedFromRole != "admin" || created.Risk != approvals.RiskHigh ||
				created.Title != "Deploy BER-1 to production?" || created.ExpiresAt == nil || !created.ExpiresAt.Equal(fake.now.Add(48*time.Hour)) ||
				created.AutomationRunID == nil || *created.AutomationRunID != fake.runID {
				t.Fatalf("approval = %+v", created)
			}
			if run.Status != automationrepo.RunWaiting || run.WaitingOn == nil || *run.WaitingOn != "approval:"+created.ID.String() {
				t.Fatalf("run = %+v", run)
			}
			if gate := fake.step(t, "gate"); gate.Status != automationrepo.StepWaiting || gate.ApprovalID == nil || *gate.ApprovalID != created.ID {
				t.Fatalf("gate = %+v", gate)
			}
			// A signal for something else never settles the step.
			if err := fake.runner.ApplySignal(context.Background(), fake.runID, ResumeSignal{Kind: SignalApproval, ID: uuid.New(), Outcome: "approved"}); !errors.Is(err, ErrSignalMismatch) {
				t.Fatalf("foreign signal error = %v, want ErrSignalMismatch", err)
			}
			fake.runner.Resume(context.Background(), fake.runID, ResumeSignal{Kind: SignalApproval, ID: created.ID, Outcome: test.outcome})
			run = fake.run(t)
			if run.Status != test.wantRun {
				t.Fatalf("run = %+v", run)
			}
			gate := fake.step(t, "gate")
			if gate.Status != test.wantStep || (test.wantCode != "" && (gate.Failure == nil || gate.Failure.Code != test.wantCode)) {
				t.Fatalf("gate = %+v", gate)
			}
			if test.wantCode != "" && (run.Failure == nil || run.Failure.Code != test.wantCode) {
				t.Fatalf("run failure = %+v", run.Failure)
			}
			if len(fake.issues.created) != test.wantIssues {
				t.Fatalf("issues = %+v", fake.issues.created)
			}
		})
	}
}

func TestRunnerFailsUnsupportedNodesAndHonoursOnError(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		onError  string
		wantRun  automationrepo.RunStatus
		wantNext automationrepo.StepStatus
	}{
		{name: "fail stops the run", onError: "", wantRun: automationrepo.RunFailed},
		{name: "skip continues", onError: `,"onError":"skip"`, wantRun: automationrepo.RunSucceeded, wantNext: automationrepo.StepSucceeded},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fake := newFixture(t, definitionJSON(berryTrigger,
				`{"id":"branch","type":"switch","value":{"ref":"trigger.kind"},"cases":[{"equals":"a","steps":["next"]}]`+test.onError+`}`,
				`{"id":"next","type":"create_issue","title":"Next","dependsOn":["branch"]}`,
			), map[string]any{"kind": "a"})
			fake.execute()
			run := fake.run(t)
			branch := fake.step(t, "branch")
			if branch.Status != automationrepo.StepFailed || branch.Failure == nil || branch.Failure.Code != "NODE_TYPE_UNSUPPORTED" {
				t.Fatalf("branch = %+v", branch)
			}
			if run.Status != test.wantRun {
				t.Fatalf("run = %+v", run)
			}
			if test.wantNext != "" && fake.step(t, "next").Status != test.wantNext {
				t.Fatalf("next = %+v", fake.step(t, "next"))
			}
			if test.wantRun == automationrepo.RunFailed && (run.Failure == nil || run.Failure.Code != "NODE_TYPE_UNSUPPORTED") {
				t.Fatalf("run failure = %+v", run.Failure)
			}
		})
	}
}

func TestRunnerInlineAgentStep(t *testing.T) {
	t.Parallel()
	definition := func(agent AgentRef) string {
		return definitionJSON(berryTrigger,
			`{"id":"ask","type":"agent","agentId":"`+agent.ID.String()+`","instruction":"Summarise {{ trigger.issue.identifier }}","input":{"title":{"ref":"trigger.issue.title"}},"outputSchema":{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"}}}}`,
		)
	}
	cases := []struct {
		name       string
		reply      openfang.AgentReply
		err        error
		wantStep   automationrepo.StepStatus
		wantCode   string
		wantEvents []string
	}{
		{
			name:       "json reply matching the schema succeeds",
			reply:      openfang.AgentReply{Response: "```json\n{\"summary\":\"all good\"}\n```", InputTokens: 10, OutputTokens: 5, CostUSD: 0.0015, Iterations: 2, RequestID: "req-1"},
			wantStep:   automationrepo.StepSucceeded,
			wantEvents: []string{"agent.started", "agent.completed"},
		},
		{
			name:       "prose reply fails the schema and keeps the usage",
			reply:      openfang.AgentReply{Response: "I could not do that.", InputTokens: 7, OutputTokens: 3},
			wantStep:   automationrepo.StepFailed,
			wantCode:   "AGENT_OUTPUT_INVALID",
			wantEvents: []string{"agent.started", "agent.failed"},
		},
		{
			name:       "runtime failure is never retried",
			err:        errors.New("upstream down"),
			wantStep:   automationrepo.StepFailed,
			wantCode:   "AGENT_CALL_FAILED",
			wantEvents: []string{"agent.started", "agent.failed"},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fake := newFixture(t, "", nil)
			fake.setDefinition(t, definition(fake.agent))
			fake.store.runs[fake.runID].TriggerPayload, _ = json.Marshal(map[string]any{"issue": map[string]any{"identifier": "BER-3", "title": "Write docs"}})
			fake.responder.reply, fake.responder.err = test.reply, test.err
			fake.execute()
			step := fake.step(t, "ask")
			if step.Status != test.wantStep {
				t.Fatalf("step = %+v", step)
			}
			if len(fake.responder.messages) != 1 || fake.responder.agents[0] != fake.agent.UpstreamID {
				t.Fatalf("calls = %d to %v, want exactly one to the upstream agent", len(fake.responder.messages), fake.responder.agents)
			}
			message := fake.responder.messages[0].Message
			if !strings.HasPrefix(message, "Summarise BER-3") || !strings.Contains(message, `"title": "Write docs"`) || !strings.Contains(message, "JSON Schema") {
				t.Fatalf("message = %q", message)
			}
			var topics []string
			for _, event := range fake.store.agentEvents {
				topics = append(topics, event.Topic)
				if event.AgentID != fake.agent.ID || event.StepID != "ask" || event.RunID != fake.runID {
					t.Fatalf("agent event = %+v", event)
				}
			}
			if strings.Join(topics, ",") != strings.Join(test.wantEvents, ",") {
				t.Fatalf("agent events = %v, want %v", topics, test.wantEvents)
			}
			run := fake.run(t)
			switch test.wantStep {
			case automationrepo.StepSucceeded:
				got := output(t, step)
				result, _ := got["result"].(map[string]any)
				if result["summary"] != "all good" || got["agentName"] != "writer" {
					t.Fatalf("output = %v", got)
				}
				var usage automation.Usage
				_ = json.Unmarshal(step.Usage, &usage)
				if usage.InputTokens != 10 || usage.OutputTokens != 5 || usage.CostMicros == nil || *usage.CostMicros != 1500 || usage.UpstreamRequestID != "req-1" {
					t.Fatalf("usage = %+v", usage)
				}
				if run.Status != automationrepo.RunSucceeded || run.Usage.InputTokens != 10 || run.Usage.OutputTokens != 5 {
					t.Fatalf("run = %+v", run)
				}
			default:
				if step.Failure == nil || step.Failure.Code != test.wantCode || run.Status != automationrepo.RunFailed {
					t.Fatalf("step = %+v, run = %+v", step, run)
				}
				if test.wantCode == "AGENT_OUTPUT_INVALID" && (run.Usage.InputTokens != 7 || len(fake.store.usage) != 1) {
					t.Fatalf("failed paid call must keep its usage: run = %+v, usage = %+v", run.Usage, fake.store.usage)
				}
			}
		})
	}
}

// An issue-mode step admits and queues a run, then waits on run:<id>. Only
// run.completed / run.failed settle it; the per-turn done never reaches the
// runner as a signal at all.
func TestRunnerIssueModeAgentWaitsOnRunCompletion(t *testing.T) {
	t.Parallel()
	definition := func(agent AgentRef) string {
		return definitionJSON(berryTrigger,
			`{"id":"work","type":"agent","issueMode":"issue","agentId":"`+agent.ID.String()+`","instruction":"Research {{ trigger.topic }}\nThen report."}`,
			`{"id":"after","type":"create_issue","title":"Review {{ steps.work.output.result }}","dependsOn":["work"]}`,
		)
	}
	cases := []struct {
		name     string
		status   runs.Status
		failure  *runs.Failure
		signal   string
		wantRun  automationrepo.RunStatus
		wantStep automationrepo.StepStatus
		wantCode string
	}{
		{name: "completed at EOF after the terminal phase", status: runs.StatusSucceeded, signal: "completed", wantRun: automationrepo.RunSucceeded, wantStep: automationrepo.StepSucceeded},
		{name: "EOF without the terminal phase", status: runs.StatusFailed, failure: &runs.Failure{Code: "RUN_INCOMPLETE"}, signal: "failed", wantRun: automationrepo.RunFailed, wantStep: automationrepo.StepFailed, wantCode: "AGENT_RUN_FAILED"},
		{name: "cancelled", status: runs.StatusCancelled, signal: "cancelled", wantRun: automationrepo.RunFailed, wantStep: automationrepo.StepFailed, wantCode: "AGENT_RUN_CANCELLED"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fake := newFixture(t, "", nil)
			fake.setDefinition(t, definition(fake.agent))
			fake.store.runs[fake.runID].TriggerPayload, _ = json.Marshal(map[string]any{"topic": "issue.completed"})
			fake.artifacts.artifacts = []collaboration.Attachment{{ID: uuid.New(), FileName: "report.md", ContentType: "text/markdown", SizeBytes: 12}}
			fake.execute()
			run := fake.run(t)
			if len(fake.issueRuns.admitted) != 1 || len(fake.issueRuns.queued) != 1 {
				t.Fatalf("admitted = %+v, queued = %+v", fake.issueRuns.admitted, fake.issueRuns.queued)
			}
			admitted := fake.issueRuns.admitted[0]
			if len(fake.issues.created) != 1 || fake.issues.created[0].Assignee == nil || fake.issues.created[0].Assignee.ID != fake.agent.ID ||
				fake.issues.created[0].Title != "Research issue.completed" {
				t.Fatalf("issue = %+v", fake.issues.created)
			}
			if admitted.IssueRef != fake.issues.created[0].ID.String() || admitted.AgentID == nil || *admitted.AgentID != fake.agent.ID ||
				admitted.RequestedBy != fake.userID || admitted.Instructions == nil || !strings.HasPrefix(*admitted.Instructions, "Research issue.completed") {
				t.Fatalf("admitted = %+v", admitted)
			}
			if run.Status != automationrepo.RunWaiting || run.WaitingOn == nil || *run.WaitingOn != "run:"+admitted.RunID.String() {
				t.Fatalf("run = %+v", run)
			}
			work := fake.step(t, "work")
			if work.Status != automationrepo.StepWaiting || work.IssueRunID == nil || *work.IssueRunID != admitted.RunID || work.IssueID == nil {
				t.Fatalf("work = %+v", work)
			}
			fake.issueRuns.finish(admitted.RunID, test.status, "The report says three things.", test.failure)
			payload, _ := json.Marshal(map[string]any{"run": map[string]any{"failure": test.failure}})
			fake.runner.Resume(context.Background(), fake.runID, ResumeSignal{Kind: SignalRun, ID: admitted.RunID, Outcome: test.signal, Payload: payload})
			run = fake.run(t)
			work = fake.step(t, "work")
			if run.Status != test.wantRun || work.Status != test.wantStep {
				t.Fatalf("run = %+v, work = %+v", run, work)
			}
			if test.wantCode != "" {
				if work.Failure == nil || work.Failure.Code != test.wantCode {
					t.Fatalf("work failure = %+v", work.Failure)
				}
				if test.failure != nil && !strings.Contains(work.Failure.Message, test.failure.Code) {
					t.Fatalf("failure message %q does not name %s", work.Failure.Message, test.failure.Code)
				}
				return
			}
			got := output(t, work)
			artifacts, _ := got["artifacts"].([]any)
			if got["result"] != "The report says three things." || got["identifier"] != "TST-1" || len(artifacts) != 1 {
				t.Fatalf("output = %v", got)
			}
			if after := output(t, fake.step(t, "after")); after["title"] != "Review The report says three things." {
				t.Fatalf("after = %v", after)
			}
		})
	}
}

func TestRunnerUpdateIssueSurfacesTheApprovalGate(t *testing.T) {
	t.Parallel()
	fake := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"start","type":"update_issue","issue":{"ref":"trigger.issue.id"},"patch":{"status":"todo"}}`,
	), nil)
	issue := core.Issue{ID: uuid.New(), WorkspaceID: fake.issues.workspaceID, IssuePrefix: "TST", Number: 9, Status: "backlog", Title: "Gated"}
	fake.issues.seed(issue)
	fake.store.runs[fake.runID].TriggerPayload, _ = json.Marshal(map[string]any{"issue": map[string]any{"id": issue.ID.String()}})
	fake.issues.updateErr = core.ErrApprovalRequired
	fake.execute()
	step := fake.step(t, "start")
	if step.Status != automationrepo.StepFailed || step.Failure == nil || step.Failure.Code != "APPROVAL_REQUIRED" {
		t.Fatalf("step = %+v", step)
	}
	if len(fake.issues.updates) != 1 || fake.issues.updates[0].Patch.Status == nil || *fake.issues.updates[0].Patch.Status != "todo" {
		t.Fatalf("updates = %+v", fake.issues.updates)
	}
	if run := fake.run(t); run.Status != automationrepo.RunFailed || run.Failure.Code != "APPROVAL_REQUIRED" {
		t.Fatalf("run = %+v", run)
	}
}

func TestRunnerActionSteps(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		step     string
		wantStep automationrepo.StepStatus
		wantCode string
		check    func(t *testing.T, fake *fixture, step automationrepo.StepRun)
	}{
		{
			name:     "berry.create_issue runs natively",
			step:     `{"id":"act","type":"action","provider":"berry","operation":"create_issue","input":{"title":"Hi {{ trigger.name }}","priority":"high"}}`,
			wantStep: automationrepo.StepSucceeded,
			check: func(t *testing.T, fake *fixture, step automationrepo.StepRun) {
				if len(fake.issues.created) != 1 || fake.issues.created[0].Title != "Hi Ada" || fake.issues.created[0].Priority != "high" {
					t.Fatalf("issues = %+v", fake.issues.created)
				}
				if step.IssueID == nil {
					t.Fatalf("step = %+v, want the issue link", step)
				}
			},
		},
		{
			name:     "berry.add_comment writes as the workflow creator",
			step:     `{"id":"act","type":"action","provider":"berry","operation":"add_comment","input":{"issue":{"ref":"trigger.issueId"},"body":"Done by {{ trigger.name }}"}}`,
			wantStep: automationrepo.StepSucceeded,
			check: func(t *testing.T, fake *fixture, _ automationrepo.StepRun) {
				if len(fake.issues.comments) != 1 || fake.issues.comments[0].AuthorID != fake.userID || fake.issues.comments[0].Body != "Done by Ada" {
					t.Fatalf("comments = %+v", fake.issues.comments)
				}
			},
		},
		{
			name:     "berry.complete_issue keeps the review gate",
			step:     `{"id":"act","type":"action","provider":"berry","operation":"complete_issue","input":{"issue":{"ref":"trigger.issueId"}}}`,
			wantStep: automationrepo.StepFailed,
			wantCode: "ISSUE_NOT_IN_REVIEW",
		},
		{
			name:     "unknown berry tool",
			step:     `{"id":"act","type":"action","provider":"berry","operation":"teleport","input":{}}`,
			wantStep: automationrepo.StepFailed,
			wantCode: "TOOL_UNKNOWN",
		},
		{
			name:     "provider without a native client",
			step:     `{"id":"act","type":"action","provider":"slack","operation":"post_message","input":{"channel":"#x","text":"hi"}}`,
			wantStep: automationrepo.StepFailed,
			wantCode: "TOOL_NOT_EXECUTABLE",
		},
		{
			name:     "template reading nothing fails the step",
			step:     `{"id":"act","type":"action","provider":"berry","operation":"create_issue","input":{"title":"Hi {{ trigger.missing }}"}}`,
			wantStep: automationrepo.StepFailed,
			wantCode: "INPUT_INVALID",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fake := newFixture(t, definitionJSON(berryTrigger, test.step), nil)
			issue := core.Issue{ID: uuid.New(), WorkspaceID: fake.issues.workspaceID, IssuePrefix: "TST", Number: 4, Status: "todo", Title: "Open"}
			fake.issues.seed(issue)
			fake.store.runs[fake.runID].TriggerPayload, _ = json.Marshal(map[string]any{"name": "Ada", "issueId": issue.ID.String()})
			fake.execute()
			step := fake.step(t, "act")
			if step.Status != test.wantStep {
				t.Fatalf("step = %+v", step)
			}
			if test.wantCode != "" && (step.Failure == nil || step.Failure.Code != test.wantCode) {
				t.Fatalf("failure = %+v, want %s", step.Failure, test.wantCode)
			}
			if test.check != nil {
				test.check(t, fake, step)
			}
		})
	}
}

func TestSignalKeysFollowTheWaitVocabulary(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	signals := WaitKeys("run.completed", id, nil, time.Now())
	if len(signals) != 2 || signals[0].Key() != "run:"+id.String() || signals[0].Outcome != "completed" || signals[1].Key() != "event:run.completed" {
		t.Fatalf("signals = %+v", signals)
	}
	if (ResumeSignal{Kind: SignalTimer}).Key() != "timer" || (ResumeSignal{Kind: SignalApproval, ID: id}).Key() != "approval:"+id.String() {
		t.Fatal("keys do not match automation_runs.waiting_on")
	}
}

// approvalAuthorizer allows every tool but asks for an approval first, the
// way a grant with an approval policy does.
type approvalAuthorizer struct{}

func (approvalAuthorizer) Authorize(context.Context, integrationcore.ExecutionContext, integrationcore.Tool) (integrationcore.Decision, error) {
	return integrationcore.Decision{Allowed: true, RequiresApproval: true}, nil
}

// A provider tool without a native executor fails before anyone is asked to
// approve it: an approval for a call that cannot happen would only cost the
// approver's attention.
func TestRunnerRefusesInexecutableToolsBeforeRequestingApproval(t *testing.T) {
	t.Parallel()
	fake := newFixture(t, definitionJSON(berryTrigger,
		`{"id":"act","type":"action","provider":"slack","operation":"post_message","input":{"channel":"#x","text":"hi"}}`), map[string]any{"name": "Ada"})
	registry := integrationcore.NewRegistry()
	for _, provider := range append(providers.All(), providers.Berry{}) {
		registry.MustRegister(provider)
	}
	runner, err := New(Options{
		Store: fake.store, Issues: fake.issues, Approvals: fake.approvals, Goals: fake.goals, IssueRuns: fake.issueRuns,
		Registry: registry, Authorizer: approvalAuthorizer{},
		Clock: func() time.Time { return fake.now }, NewID: uuid.New,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	runner.Execute(context.Background(), fake.runID)
	step := fake.step(t, "act")
	if step.Status != automationrepo.StepFailed || step.Failure == nil || step.Failure.Code != "TOOL_NOT_EXECUTABLE" {
		t.Fatalf("step = %+v", step)
	}
	if len(fake.approvals.created) != 0 {
		t.Fatalf("approvals requested for a tool that cannot run: %+v", fake.approvals.created)
	}
	if run := fake.run(t); run.Status != automationrepo.RunFailed {
		t.Fatalf("run = %+v, want failed", run)
	}
}
