package codecontext

import (
	"context"
	"fmt"
	"strings"
)

// Source reads a repository.
type Source interface {
	Tree(ctx context.Context, fullName, ref string) ([]Entry, bool, error)
	File(ctx context.Context, fullName, ref, path string) (string, error)
	DefaultBranch(ctx context.Context, fullName string) (string, error)
}

// Request is one issue's need for context.
type Request struct {
	Repository  string
	Title       string
	Description string
	Budget      Budget
}

// Build renders the repository context for a prompt.
//
// Best effort by design. A run whose context could not be fetched should still
// happen — the agent is worse informed, not blocked — so every failure here
// returns empty rather than an error the dispatcher would treat as fatal.
func Build(ctx context.Context, source Source, request Request) string {
	if source == nil || strings.TrimSpace(request.Repository) == "" {
		return ""
	}
	budget := request.Budget
	if budget.MaxFiles == 0 {
		budget = DefaultBudget()
	}

	branch, err := source.DefaultBranch(ctx, request.Repository)
	if err != nil {
		return ""
	}
	entries, truncated, err := source.Tree(ctx, request.Repository, branch)
	if err != nil || len(entries) == 0 {
		return ""
	}

	var builder strings.Builder
	builder.WriteString("\n\nRepository: ")
	builder.WriteString(request.Repository)
	builder.WriteString(" (branch ")
	builder.WriteString(branch)
	builder.WriteString(")\n")

	tree, treeTruncated := RenderTree(entries, budget)
	if tree != "" {
		builder.WriteString("\nFiles:\n")
		builder.WriteString(tree)
		if treeTruncated || truncated {
			// Said rather than hidden: an agent that believes it has seen the
			// whole tree will conclude a file does not exist when it simply
			// did not fit.
			builder.WriteString("… tree truncated; more files exist.\n")
		}
	}

	chosen := Choose(entries, Terms(request.Title, request.Description), budget)
	for _, path := range chosen {
		contents, err := source.File(ctx, request.Repository, branch, path)
		if err != nil {
			continue
		}
		builder.WriteString("\n--- ")
		builder.WriteString(path)
		builder.WriteString(" ---\n")
		builder.WriteString(contents)
		if !strings.HasSuffix(contents, "\n") {
			builder.WriteByte('\n')
		}
	}

	// The agent is told what it was and was not given, because a selection it
	// cannot see the edges of reads as the whole repository.
	builder.WriteString(fmt.Sprintf(
		"\nYou were shown %d of %d files. Ask for others by path if you need them.\n",
		len(chosen), len(entries)))
	return builder.String()
}
