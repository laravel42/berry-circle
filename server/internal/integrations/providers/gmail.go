package providers

import "github.com/laravel42/berry-circle/server/internal/integrations/core"

// Gmail is the native Gmail integration.
//
// Sending is the highest-risk operation Berry offers: it reaches people outside
// the workspace under the connected account's name and cannot be recalled. Both
// send tools therefore require approval and neither is on by default, so an
// autonomous agent drafts and a human sends.
type Gmail struct{}

func (Gmail) ID() string   { return "gmail" }
func (Gmail) Name() string { return "Gmail" }
func (Gmail) Description() string {
	return "Search, read and draft mail."
}

// Scopes are the narrowest that cover the tool set. gmail.modify allows drafts
// and labels without granting the full-mailbox `https://mail.google.com/`.
func (Gmail) Scopes() []string {
	return []string{
		"https://www.googleapis.com/auth/gmail.readonly",
		"https://www.googleapis.com/auth/gmail.compose",
		"https://www.googleapis.com/auth/gmail.modify",
	}
}

func (Gmail) Tools() []core.Tool {
	return withProvider("gmail", []core.Tool{
		tool("gmail.search_messages", "Search messages with Gmail query syntax.", core.EffectRead),
		tool("gmail.get_message", "One message by id.", core.EffectRead),
		tool("gmail.get_thread", "A thread and its messages.", core.EffectRead),
		tool("gmail.list_threads", "Threads matching a query.", core.EffectRead),
		tool("gmail.list_labels", "Labels on the mailbox.", core.EffectRead),

		// Drafting is a write: it changes the mailbox but reaches nobody.
		tool("gmail.create_draft", "Create a draft. Preferred over sending.", core.EffectWrite),
		tool("gmail.update_draft", "Change an existing draft.", core.EffectWrite),

		// Sending leaves Berry. Approval is required and neither is default-on.
		tool("gmail.send_draft", "Send an existing draft.", core.EffectExternalSideEffect, optIn, approval),
		tool("gmail.send_message", "Compose and send a message.", core.EffectExternalSideEffect, optIn, approval),
	})
}

func (Gmail) MCPServer(credential string) core.MCPServerConfig {
	return core.MCPServerConfig{
		Name:      "berry-gmail",
		Transport: "stdio",
		Command:   "npx",
		Args:      []string{"-y", "@gongrzhe/server-gmail-autoauth-mcp"},
		Env:       map[string]string{"GOOGLE_OAUTH_ACCESS_TOKEN": credential},
	}
}

// All returns every first-class provider, for registry wiring.
func All() []core.Provider {
	return []core.Provider{GitHub{}, Gmail{}, Linear{}, Notion{}, Slack{}}
}
