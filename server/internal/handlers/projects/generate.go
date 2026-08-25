package projects

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/planning"
)

// IssueGenerator proposes issues for a project and records them.
//
// The whole operation behind one seam: the handler decides who may ask and what
// the answer looks like, and knows nothing about which agent answered or how a
// proposal becomes a row.
type IssueGenerator interface {
	GenerateIssues(ctx context.Context, actorID, projectID uuid.UUID) ([]GeneratedIssue, error)
}

// GeneratedIssue is one issue that was created.
type GeneratedIssue struct {
	ID         uuid.UUID
	Identifier string
	Title      string
	Priority   string
}

type generatedIssueResource struct {
	ID         uuid.UUID `json:"id"`
	Identifier string    `json:"identifier"`
	Title      string    `json:"title"`
	Priority   string    `json:"priority"`
}

// generateIssues asks an agent to decompose the project, and creates what it
// proposed.
//
// Synchronous because the person is waiting on a button. It costs one model
// turn, which is why nothing here retries: a second attempt is a second charge,
// and the person can decide whether the first answer was worth paying twice for.
func (handler *handlers) generateIssues(response http.ResponseWriter, request *http.Request) {
	projectID, ok := parsePathID(response, request, "projectId", "Project")
	if !ok {
		return
	}
	if handler.generator == nil {
		httpapi.WriteError(response, request, http.StatusPreconditionFailed,
			"GENERATION_UNAVAILABLE",
			"This deployment has no agent runtime to generate issues with.", nil)
		return
	}
	user := auth.MustUser(request.Context())

	created, err := handler.generator.GenerateIssues(request.Context(), user.ID, projectID)
	switch {
	case errors.Is(err, planning.ErrNoProposals):
		// Not a fault. The agent answered and the answer was unusable, which a
		// person fixes by giving the project a better brief.
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity,
			"NO_PROPOSALS",
			"The agent could not turn this project into issues. A fuller description usually helps.",
			nil)
		return
	case err != nil:
		if !writeServiceError(response, request, err, "Project") {
			return
		}
		return
	}

	resources := make([]generatedIssueResource, 0, len(created))
	for _, issue := range created {
		resources = append(resources, generatedIssueResource{
			ID:         issue.ID,
			Identifier: issue.Identifier,
			Title:      issue.Title,
			Priority:   issue.Priority,
		})
	}
	httpapi.WriteJSON(response, http.StatusCreated, map[string]any{"issues": resources})
}

// briefFrom builds what the agent is asked to decompose.
func briefFrom(name string, description *string, repository *string, existing []string) planning.Brief {
	brief := planning.Brief{ProjectName: strings.TrimSpace(name), Existing: existing}
	if description != nil {
		brief.Description = *description
	}
	if repository != nil {
		brief.Repository = *repository
	}
	return brief
}
