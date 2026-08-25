package github

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/codecontext"
)

// RunContext renders repository context for a run's prompt.
//
// The adapter between "a run needs to know about a repository" and the pieces
// that answer it: a credential per workspace, a reader, and a selection policy.
type RunContext struct {
	Credentials CredentialSource
	BaseURL     string
	Budget      codecontext.Budget
	Logger      *slog.Logger
}

// Build renders what the agent should see, or nothing.
//
// Never fails the caller. A run whose context could not be built is worth
// dispatching with a worse-informed agent; refusing it would make every run
// depend on GitHub being reachable.
func (renderer RunContext) Build(
	ctx context.Context,
	workspaceID uuid.UUID,
	repository, title, description string,
) string {
	if renderer.Credentials == nil || repository == "" || workspaceID == uuid.Nil {
		return ""
	}
	source := CodeSource{
		Credentials: renderer.Credentials,
		WorkspaceID: workspaceID,
		BaseURL:     renderer.BaseURL,
	}
	rendered := codecontext.Build(ctx, source, codecontext.Request{
		Repository:  repository,
		Title:       title,
		Description: description,
		Budget:      renderer.Budget,
	})
	// Logged either way, because it is invisible otherwise: the run succeeds,
	// the agent simply never mentions the codebase, and nobody can tell whether
	// the context was empty, never fetched, or fetched and ignored.
	if renderer.Logger != nil {
		if rendered == "" {
			renderer.Logger.Warn("no repository context was built for a run",
				"repository", repository, "workspaceId", workspaceID)
		} else {
			renderer.Logger.Info("repository context built for a run",
				"repository", repository, "bytes", len(rendered))
		}
	}
	return rendered
}
