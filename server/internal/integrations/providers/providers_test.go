package providers

import (
	"strings"
	"testing"

	"github.com/laravel42/berry-circle/server/internal/integrations/core"
)

// Every provider must survive registration, which is where prefixes, effect
// classifications and the destructive-default rule are checked.
func TestEveryProviderRegisters(t *testing.T) {
	registry := core.NewRegistry()
	for _, provider := range All() {
		if err := registry.Register(provider); err != nil {
			t.Errorf("Register(%s): %v", provider.ID(), err)
		}
	}
	if got := len(registry.List()); got != 5 {
		t.Errorf("registered %d providers, want 5", got)
	}
}

// The spec's five, by the ids used in tool names, routes and the database.
func TestTheFiveProvidersArePresent(t *testing.T) {
	found := map[string]bool{}
	for _, provider := range All() {
		found[provider.ID()] = true
	}
	for _, want := range []string{"github", "slack", "linear", "notion", "gmail"} {
		if !found[want] {
			t.Errorf("provider %q is missing", want)
		}
	}
}

func TestEveryToolIsClassifiedAndDescribed(t *testing.T) {
	for _, provider := range All() {
		for _, tool := range provider.Tools() {
			if !tool.Effect.Valid() {
				t.Errorf("%s has invalid effect %q", tool.Name, tool.Effect)
			}
			if strings.TrimSpace(tool.Description) == "" {
				t.Errorf("%s has no description; an agent chooses tools by it", tool.Name)
			}
			if tool.Provider != provider.ID() {
				t.Errorf("%s claims provider %q", tool.Name, tool.Provider)
			}
		}
	}
}

// Anything that leaves Berry or destroys state must not be granted by a
// workspace that never opened its settings.
func TestRiskyToolsAreNotOnByDefault(t *testing.T) {
	for _, provider := range All() {
		for _, tool := range provider.Tools() {
			if tool.Effect == core.EffectDestructive && tool.EnabledByDefault {
				t.Errorf("%s is destructive and default-on", tool.Name)
			}
			if tool.RequiresApproval && tool.EnabledByDefault {
				t.Errorf("%s needs approval yet is default-on", tool.Name)
			}
		}
	}
}

// Sending mail is the motivating case for the approval gate.
func TestSendingMailRequiresApproval(t *testing.T) {
	tools := map[string]core.Tool{}
	for _, tool := range (Gmail{}).Tools() {
		tools[tool.Name] = tool
	}
	for _, name := range []string{"gmail.send_message", "gmail.send_draft"} {
		tool, ok := tools[name]
		if !ok {
			t.Fatalf("%s is missing", name)
		}
		if !tool.RequiresApproval {
			t.Errorf("%s does not require approval", name)
		}
		if tool.Effect != core.EffectExternalSideEffect {
			t.Errorf("%s effect = %s, want external_side_effect", name, tool.Effect)
		}
	}
	// Drafting must stay ungated, or an autonomous agent has no safe option.
	if draft := tools["gmail.create_draft"]; draft.RequiresApproval {
		t.Error("drafting requires approval, leaving an agent no safe path")
	}
}

// Posting reaches people; it is not an ordinary write.
func TestPostingIsAnExternalSideEffect(t *testing.T) {
	for _, tool := range (Slack{}).Tools() {
		if tool.Name == "slack.post_message" || tool.Name == "slack.reply_thread" {
			if tool.Effect != core.EffectExternalSideEffect {
				t.Errorf("%s effect = %s, want external_side_effect", tool.Name, tool.Effect)
			}
		}
	}
}

// The credential must travel in the environment: a process argument is visible
// to anything that can list processes.
func TestCredentialsNeverAppearInMCPArguments(t *testing.T) {
	const credential = "super-secret-token-value"
	for _, provider := range All() {
		config := provider.MCPServer(credential)
		for _, arg := range config.Args {
			if strings.Contains(arg, credential) {
				t.Errorf("%s puts the credential in argv: %q", provider.ID(), arg)
			}
		}
		if strings.Contains(config.Command, credential) {
			t.Errorf("%s puts the credential in the command", provider.ID())
		}
		var carried bool
		for _, value := range config.Env {
			if strings.Contains(value, credential) {
				carried = true
			}
		}
		if !carried {
			t.Errorf("%s never passes the credential to the runtime", provider.ID())
		}
	}
}

// Slack's admin surface would let a compromised token reconfigure the
// workspace, and nothing in the tool set needs it.
func TestNoProviderRequestsAdminScopes(t *testing.T) {
	for _, provider := range All() {
		for _, scope := range provider.Scopes() {
			if strings.Contains(scope, "admin") {
				t.Errorf("%s requests admin scope %q", provider.ID(), scope)
			}
		}
	}
	// Gmail must not take the full-mailbox scope when narrower ones suffice.
	for _, scope := range (Gmail{}).Scopes() {
		if scope == "https://mail.google.com/" {
			t.Error("gmail requests full-mailbox access")
		}
	}
}
