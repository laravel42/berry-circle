package providers

import "github.com/laravel42/berry-circle/server/internal/integrations/core"

// Slack is the native Slack integration.
//
// Posting is classified as an external side effect rather than a write: a
// message reaches people and cannot be undone by deleting a record, which is
// the distinction the effect ladder exists to draw.
type Slack struct{}

func (Slack) ID() string   { return "slack" }
func (Slack) Name() string { return "Slack" }
func (Slack) Description() string {
	return "Channels, messages and threads."
}

// Scopes are bot scopes only. No admin.* scope is requested: nothing in the
// tool set needs one, and asking for it would let a compromised token
// reconfigure the workspace.
func (Slack) Scopes() []string {
	return []string{
		"channels:read", "channels:history", "groups:read", "groups:history",
		"chat:write", "search:read", "users:read",
	}
}

func (Slack) Tools() []core.Tool {
	return withProvider("slack", []core.Tool{
		// Triggers: Events API event types, as the /api/v1/hooks/slack
		// ingestor normalises them.
		trigger("slack.message", "A message was posted in a channel the bot is in."),
		trigger("slack.app_mention", "The bot was mentioned."),
		trigger("slack.reaction_added", "A reaction was added to a message."),
		trigger("slack.member_joined_channel", "Someone joined a channel."),

		tool("slack.list_channels", "Channels the bot can see.", core.EffectRead),
		tool("slack.get_channel", "One channel's metadata.", core.EffectRead),
		tool("slack.search_messages", "Search messages the bot can read.", core.EffectRead),
		tool("slack.get_messages", "Recent messages in a channel.", core.EffectRead),
		tool("slack.get_thread", "A thread's replies.", core.EffectRead),
		tool("slack.get_user", "One user's profile.", core.EffectRead),

		tool("slack.post_message", "Post a message to a channel.", core.EffectExternalSideEffect),
		tool("slack.reply_thread", "Reply in a thread.", core.EffectExternalSideEffect),
	})
}

func (Slack) MCPServer(credential string) core.MCPServerConfig {
	return core.MCPServerConfig{
		Name:      "berry-slack",
		Transport: "stdio",
		Command:   "npx",
		Args:      []string{"-y", "@modelcontextprotocol/server-slack"},
		Env:       map[string]string{"SLACK_BOT_TOKEN": credential},
	}
}
