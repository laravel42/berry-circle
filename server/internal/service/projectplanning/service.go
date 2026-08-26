// Package projectplanning turns a project into issues an agent proposed.
//
// The join between three things that otherwise do not know about each other:
// the project being decomposed, the runtime that answers, and the issues that
// result. Kept out of the handler so the decision of which agent to ask, and
// what to do when it answers badly, is testable without HTTP.
package projectplanning

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	projecthandlers "github.com/laravel42/berry-circle/server/internal/handlers/projects"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/planning"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// preferredAgents are tried in order, orchestrator first.
//
// Reading a project and deciding who does what is the orchestrating role, not a
// specialist one — a planner asked to assign work is guessing at a judgement
// the orchestrator exists to make. The rest are a fallback so a workspace whose
// orchestrator is unprovisioned still gets a plan rather than a refusal.
//
// Named rather than "any available" so the same project decomposes the same way
// twice. Falling through to whatever happens to be idle would make the quality
// of a plan depend on which agent was busy.
var preferredAgents = []string{"orchestrator", "planner", "architect", "analyst"}

// AgentDirectory finds an agent to ask.
type AgentDirectory interface {
	FindAgent(ctx context.Context, workspaceID uuid.UUID, names []string) (uuid.UUID, error)
	Candidates(ctx context.Context, workspaceID uuid.UUID) ([]Candidate, error)
}

// ProjectContext is everything the decomposition needs about a project, and
// where the resulting issues belong.
//
// Resolved in one query rather than assembled from configuration: the project
// already knows its workspace, and the workspace already has a board, so
// pinning either at startup would only create a way for them to disagree.
type ProjectContext struct {
	WorkspaceID uuid.UUID
	BoardID     uuid.UUID
	Name        string
	Description *string
	Repository  *string
}

// Projects reads the project being decomposed.
type Projects interface {
	ProjectContext(ctx context.Context, projectID uuid.UUID) (ProjectContext, error)
}

// Issues records what was proposed.
type Issues interface {
	CreateIssue(
		ctx context.Context,
		params core.CreateIssueParams,
	) (core.Issue, []core.IssueMutationEvent, error)
	ListIssues(ctx context.Context, filter core.IssueListFilter) ([]core.Issue, error)
}

// Responder is the one runtime call this needs: ask an agent, get an answer.
//
// Narrower than openfang.Runtime on purpose — planning has no business being
// able to dispatch runs or rewrite an agent's configuration.
type Responder interface {
	SendAgentMessage(context.Context, uuid.UUID, openfang.MessageRequest) (openfang.AgentReply, error)
}

// Authorizer decides who may spend a model call.
type Authorizer interface {
	AuthorizeWorkspace(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Role, error)
}

// Service generates issues for a project.
type Service struct {
	Projects   Projects
	Issues     Issues
	Agents     AgentDirectory
	Runtime    Responder
	Authorizer Authorizer
	Clock      func() time.Time
	NewID      func() uuid.UUID
	// Broadcaster is optional. Generated issues land on a board someone may be
	// watching, and the durable issue.created rows exist whether or not the
	// live wakeup is delivered.
	Broadcaster realtime.Broadcaster
}

// ErrNoAgent means the workspace has nobody to ask.
var ErrNoAgent = errors.New("projectplanning: no agent available to plan with")

type runtimeAsker struct {
	runtime Responder
	agentID uuid.UUID
}

func (asker runtimeAsker) Ask(ctx context.Context, prompt string) (string, error) {
	reply, err := asker.runtime.SendAgentMessage(ctx, asker.agentID, openfang.MessageRequest{
		Message: prompt,
	})
	if err != nil {
		return "", err
	}
	return reply.Response, nil
}

// GenerateIssues asks an agent to decompose the project and records the answer.
func (service *Service) GenerateIssues(
	ctx context.Context,
	actorID, projectID uuid.UUID,
) ([]projecthandlers.GeneratedIssue, error) {
	project, err := service.Projects.ProjectContext(ctx, projectID)
	if err != nil {
		return nil, err
	}
	// Authorised against the project's own workspace, not one supplied by the
	// caller: spending a model call is a write, and it must be a write the
	// person is allowed to make where the project actually lives.
	if _, err := service.Authorizer.AuthorizeWorkspace(
		ctx, actorID, project.WorkspaceID, identity.PermissionWrite,
	); err != nil {
		return nil, err
	}

	upstreamID, err := service.Agents.FindAgent(ctx, project.WorkspaceID, preferredAgents)
	if err != nil {
		return nil, err
	}

	// What the project already has, so a second press adds to the work rather
	// than proposing it again.
	existing, err := service.existingTitles(ctx, project.BoardID, projectID)
	if err != nil {
		return nil, err
	}

	// Who the plan may assign to. Without this the issues arrive unassigned and
	// routing places them by capability match — which scores zero when nothing
	// is labelled, leaving an alphabetical tiebreak to decide who does the work.
	candidates, err := service.Agents.Candidates(ctx, project.WorkspaceID)
	if err != nil {
		return nil, err
	}
	byName := make(map[string]uuid.UUID, len(candidates))
	briefCandidates := make([]planning.Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		byName[strings.ToLower(candidate.Name)] = candidate.ID
		briefCandidates = append(briefCandidates, planning.Candidate{
			Name:         candidate.Name,
			Capabilities: candidate.Capabilities,
		})
	}

	brief := planning.Brief{
		ProjectName: project.Name,
		Existing:    existing,
		Candidates:  briefCandidates,
	}
	if project.Description != nil {
		brief.Description = *project.Description
	}
	if project.Repository != nil {
		brief.Repository = *project.Repository
	}

	proposals, err := planning.Generate(
		ctx, runtimeAsker{runtime: service.Runtime, agentID: upstreamID}, brief)
	if err != nil {
		return nil, err
	}

	now := service.Clock().UTC()
	created := make([]projecthandlers.GeneratedIssue, 0, len(proposals))
	for index, proposal := range proposals {
		// A nomination naming an agent that does not exist is dropped rather
		// than guessed at: an issue assigned to nobody looks decided and never
		// runs, which is worse than one routing can still place.
		var assignee *core.AssigneeInput
		if agentID, known := byName[strings.ToLower(proposal.Agent)]; known {
			assignee = &core.AssigneeInput{Type: "agent", ID: agentID}
		}

		// An assignment records a history row keyed by this id. Leaving it nil
		// made every assigned issue insert a row keyed by the nil UUID, so the
		// first collided with itself on the second issue — and with the run
		// before it, once one had been created.
		assignmentID := uuid.Nil
		if assignee != nil {
			assignmentID = service.NewID()
		}

		issue, events, err := service.Issues.CreateIssue(ctx, core.CreateIssueParams{
			ID:           service.NewID(),
			AssignmentID: assignmentID,
			BoardID:      project.BoardID,
			Assignee:     assignee,
			Title:        proposal.Title,
			// Empty descriptions are stored as absent rather than as "".
			Description: nonEmpty(proposal.Description),
			Status:      "todo",
			Priority:    proposal.Priority,
			// Spread so the generated set keeps the order it was proposed in,
			// which is the order the agent thought the work should happen.
			SortOrder: int32((index + 1) * 1000),
			Project:   &projectID,
			CreatedBy: actorID,
			CreatedAt: now,
			NewID:     service.NewID,
		})
		if err != nil {
			// Partial success is kept. The model call is already paid for, and
			// discarding six good issues because the seventh failed to insert
			// would waste it for nothing.
			return created, fmt.Errorf("create generated issue: %w", err)
		}
		service.publish(ctx, events)
		created = append(created, projecthandlers.GeneratedIssue{
			ID:         issue.ID,
			Identifier: issue.Identifier(),
			Title:      issue.Title,
			Priority:   issue.Priority,
		})
	}
	return created, nil
}

func (service *Service) existingTitles(
	ctx context.Context,
	boardID, projectID uuid.UUID,
) ([]string, error) {
	issues, err := service.Issues.ListIssues(ctx, core.IssueListFilter{
		BoardID: boardID,
		Limit:   200,
	})
	if err != nil {
		return nil, err
	}
	titles := make([]string, 0, len(issues))
	for _, issue := range issues {
		if issue.Project != nil && issue.Project.ID == projectID {
			titles = append(titles, issue.Title)
		}
	}
	return titles, nil
}

func nonEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// publish delivers committed issue.created facts live. Kept here rather than
// borrowed from a handler package: a service that imports HTTP helpers to
// send a wakeup has its dependencies pointing the wrong way.
func (service *Service) publish(ctx context.Context, events []core.IssueMutationEvent) {
	if service.Broadcaster == nil {
		return
	}
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for _, event := range events {
		_ = service.Broadcaster.Publish(publishCtx, realtime.Event{
			ID:          event.ID.String(),
			WorkspaceID: event.WorkspaceID.String(),
			BoardID:     event.BoardID.String(),
			Type:        event.Type,
			Payload:     event.Payload,
			OccurredAt:  event.OccurredAt,
		})
	}
}
