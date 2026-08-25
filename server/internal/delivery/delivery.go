// Package delivery turns what a run produced into a pull request.
//
// The last step of the loop: an issue is worked, the agent writes files, and
// those files become a branch and a pull request against the project's
// repository. Berry does the git work because the runtime has no git — no
// binary, no credential, no network path to one — so an agent that tried would
// only be able to describe the commit it wanted.
package delivery

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/artifacts"
	"github.com/laravel42/berry-circle/server/internal/integrations/github"
)

// maxFiles bounds one delivery. A run that wrote hundreds of files has not
// completed an issue, and a pull request nobody can review is not a
// contribution.
const maxFiles = 40

// Publisher opens the pull request.
type Publisher interface {
	Deliver(ctx context.Context, workspaceID uuid.UUID, repository, branch, title, body string,
		changes []github.FileChange) (github.PullRequest, error)
}

// Runs describes a finished run well enough to deliver it.
type Run struct {
	RunID           uuid.UUID
	WorkspaceID     uuid.UUID
	Repository      string
	AgentSlug       string
	IssueIdentifier string
	IssueTitle      string
	StartedAt       int64
	CompletedAt     int64
}

// Source reads what the run wrote.
type Source interface {
	Output(run artifacts.RunContext) ([]artifacts.Produced, error)
}

// Service delivers a finished run.
type Service struct {
	Output    Source
	Publisher Publisher
}

// ErrNothingProduced means the run wrote no files worth delivering.
var ErrNothingProduced = errors.New("delivery: the run produced no files")

// Deliver publishes a run's output as a pull request.
func (service *Service) Deliver(
	ctx context.Context,
	run Run,
	window artifacts.RunContext,
) (github.PullRequest, error) {
	if service.Output == nil || service.Publisher == nil {
		return github.PullRequest{}, errors.New("delivery: not configured")
	}
	if run.Repository == "" {
		return github.PullRequest{}, ErrNothingProduced
	}

	produced, err := service.Output.Output(window)
	if err != nil {
		return github.PullRequest{}, err
	}
	changes := make([]github.FileChange, 0, len(produced))
	for _, file := range produced {
		target := RepositoryPath(file.Name)
		if target == "" {
			continue
		}
		changes = append(changes, github.FileChange{Path: target, Contents: file.Contents})
		if len(changes) == maxFiles {
			break
		}
	}
	if len(changes) == 0 {
		return github.PullRequest{}, ErrNothingProduced
	}

	branch := BranchName(run.IssueIdentifier, run.RunID)
	title := fmt.Sprintf("%s %s", run.IssueIdentifier, run.IssueTitle)
	body := Body(run, changes)

	return service.Publisher.Deliver(
		ctx, run.WorkspaceID, run.Repository, branch, title, body, changes)
}

// BranchName is stable per run, not per issue.
//
// Two runs on one issue are two attempts, and reusing a branch would make the
// second silently fail against the first's existing ref — or worse, appear to
// succeed while delivering nothing new.
func BranchName(issueIdentifier string, runID uuid.UUID) string {
	slug := strings.ToLower(strings.TrimSpace(issueIdentifier))
	if slug == "" {
		slug = "berry"
	}
	safe := make([]rune, 0, len(slug))
	for _, letter := range slug {
		switch {
		case letter >= 'a' && letter <= 'z', letter >= '0' && letter <= '9', letter == '-':
			safe = append(safe, letter)
		default:
			safe = append(safe, '-')
		}
	}
	return fmt.Sprintf("berry/%s-%s", strings.Trim(string(safe), "-"), runID.String()[:8])
}

// RepositoryPath maps a produced file onto a path in the repository.
//
// The agent writes into a flat output directory, so a name is all there is to
// go on. Anything that could climb out of the repository root, or address a
// path rather than a file, is refused — a delivery is a commit, and a commit
// that writes outside the tree it claims to change is not reviewable.
func RepositoryPath(name string) string {
	cleaned := path.Clean(strings.TrimSpace(name))
	if cleaned == "" || cleaned == "." || cleaned == "/" {
		return ""
	}
	if strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "..") {
		return ""
	}
	for _, segment := range strings.Split(cleaned, "/") {
		if segment == ".." || segment == "" {
			return ""
		}
	}
	return cleaned
}

// Body explains the pull request to whoever reviews it.
func Body(run Run, changes []github.FileChange) string {
	var builder strings.Builder
	builder.WriteString("Opened by Berry for ")
	builder.WriteString(run.IssueIdentifier)
	builder.WriteString(".\n\n")
	if run.AgentSlug != "" {
		builder.WriteString("Written by the ")
		builder.WriteString(run.AgentSlug)
		builder.WriteString(" agent.\n\n")
	}
	builder.WriteString("Files:\n")
	for _, change := range changes {
		builder.WriteString("- `")
		builder.WriteString(change.Path)
		builder.WriteString("`\n")
	}
	// Said plainly, because a reviewer's first question about a machine-authored
	// change is how much of it anyone has looked at.
	builder.WriteString("\nNobody has reviewed this. It is the agent's output as written.\n")
	return builder.String()
}
