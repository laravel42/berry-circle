package providers

import "github.com/laravel42/berry-circle/server/internal/integrations/core"

// Linear is the native Linear integration.
type Linear struct{}

func (Linear) ID() string   { return "linear" }
func (Linear) Name() string { return "Linear" }
func (Linear) Description() string {
	return "Issues, projects, teams and labels."
}

func (Linear) Scopes() []string { return []string{"read", "write", "issues:create"} }

func (Linear) Tools() []core.Tool {
	return withProvider("linear", []core.Tool{
		// Triggers: the payload's type and action, as the /api/v1/hooks/linear
		// ingestor normalises them.
		trigger("linear.issue.create", "An issue was created."),
		trigger("linear.issue.update", "An issue changed."),
		trigger("linear.issue.remove", "An issue was removed."),
		trigger("linear.comment.create", "A comment was added."),
		trigger("linear.project.update", "A project changed."),

		tool("linear.get_issue", "One issue by id or identifier.", core.EffectRead),
		tool("linear.list_issues", "Issues on a team or project.", core.EffectRead),
		tool("linear.search_issues", "Search issues by text.", core.EffectRead),
		tool("linear.list_projects", "Projects in the workspace.", core.EffectRead),
		tool("linear.get_project", "One project by id.", core.EffectRead),
		tool("linear.list_teams", "Teams in the workspace.", core.EffectRead),
		tool("linear.get_user", "One user by id.", core.EffectRead),
		tool("linear.list_issue_labels", "Labels available for issues.", core.EffectRead),

		tool("linear.create_issue", "Create an issue.", core.EffectWrite),
		tool("linear.update_issue", "Change an issue's fields or state.", core.EffectWrite),
		tool("linear.add_comment", "Comment on an issue.", core.EffectWrite),
	})
}

func (Linear) MCPServer(credential string) core.MCPServerConfig {
	return core.MCPServerConfig{
		Name:      "berry-linear",
		Transport: "stdio",
		Command:   "npx",
		Args:      []string{"-y", "mcp-remote", "https://mcp.linear.app/sse"},
		Env:       map[string]string{"LINEAR_API_KEY": credential},
	}
}
