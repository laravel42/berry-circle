package providers

import "github.com/laravel42/berry-circle/server/internal/integrations/core"

// GitHub is the native GitHub integration.
//
// Authorisation is a GitHub App installation rather than a personal access
// token: an App's permissions are scoped to selected repositories and its
// installation survives the person who created it leaving, whereas a PAT
// carries one human's full account access and dies with their membership.
type GitHub struct{}

func (GitHub) ID() string   { return "github" }
func (GitHub) Name() string { return "GitHub" }
func (GitHub) Description() string {
	return "Repositories, issues, pull requests and checks."
}

// Scopes are the App permissions Berry requests at installation.
func (GitHub) Scopes() []string {
	return []string{"contents:read", "issues:write", "pull_requests:write", "checks:read", "metadata:read"}
}

func (GitHub) Tools() []core.Tool {
	return withProvider("github", []core.Tool{
		tool("github.list_repositories", "Repositories the installation can see.", core.EffectRead),
		tool("github.get_repository", "One repository's metadata.", core.EffectRead),
		tool("github.get_issue", "One issue by number.", core.EffectRead),
		tool("github.list_issues", "Issues on a repository, filterable by state and label.", core.EffectRead),
		tool("github.create_issue", "Open a new issue.", core.EffectWrite),
		tool("github.update_issue", "Change an issue's title, body, state or labels.", core.EffectWrite),
		tool("github.comment_issue", "Comment on an issue.", core.EffectWrite),
		tool("github.get_pull_request", "One pull request by number.", core.EffectRead),
		tool("github.list_pull_requests", "Pull requests on a repository.", core.EffectRead),
		tool("github.create_pull_request", "Open a pull request from an existing branch.", core.EffectWrite),
		tool("github.comment_pull_request", "Comment on a pull request.", core.EffectWrite),
		tool("github.list_reviews", "Reviews left on a pull request.", core.EffectRead),
		tool("github.get_file", "One file's contents at a ref.", core.EffectRead),
		tool("github.list_directory", "Entries in a directory at a ref.", core.EffectRead),
		tool("github.search_code", "Search code within the installation's repositories.", core.EffectRead),
		tool("github.create_branch", "Create a branch from an existing ref.", core.EffectWrite),
		tool("github.create_or_update_file", "Commit a file change to a branch.", core.EffectWrite),
		tool("github.get_commit", "One commit by sha.", core.EffectRead),
		tool("github.get_check_runs", "Check runs for a ref.", core.EffectRead),

		// Destructive operations are declared so the permission model can name
		// them, and left off by default so a workspace has to ask. Merging is
		// not reversible by deleting a record, and neither is deleting a branch.
		tool("github.merge_pull_request", "Merge a pull request.", core.EffectDestructive, optIn, approval),
		tool("github.delete_branch", "Delete a branch.", core.EffectDestructive, optIn, approval),
	})
}

// MCPServer points the runtime at the official GitHub MCP server.
//
// The installation token goes in the environment, not the argument list: a
// process argument is readable by anything that can list processes.
func (GitHub) MCPServer(credential string) core.MCPServerConfig {
	return core.MCPServerConfig{
		Name:      "berry-github",
		Transport: "stdio",
		Command:   "npx",
		Args:      []string{"-y", "@modelcontextprotocol/server-github"},
		Env:       map[string]string{"GITHUB_PERSONAL_ACCESS_TOKEN": credential},
	}
}
