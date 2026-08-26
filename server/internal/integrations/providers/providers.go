// Package providers declares Berry's five first-class integrations.
//
// A provider here is a description, not an implementation: which tools exist,
// what each one does to the outside world, which OAuth scopes the connection
// needs, and how the runtime should reach the provider once connected. The
// calls themselves are made by the runtime's MCP server for that provider, so
// nothing in this package talks to GitHub, Slack, Linear, Notion or Google.
//
// Keeping them in one package rather than five is deliberate: they share no
// code but they must stay consistent with each other, and a reviewer comparing
// two providers' effect classifications should not have to open two packages.
package providers

import "github.com/laravel42/berry-circle/server/internal/integrations/core"

// tool is a terse constructor so a provider's table reads as a table.
// Anything not named is a read that is enabled by default, because reads are
// the common case and stating it on every row would bury the exceptions.
func tool(name, description string, effect core.Effect, opts ...func(*core.Tool)) core.Tool {
	built := core.Tool{
		Name:             name,
		Description:      description,
		Effect:           effect,
		EnabledByDefault: true,
		// Every provider in this package is reached through a workspace
		// connection; Berry's own provider (berry.go) is the exception and
		// declares its tools itself.
		ConnectionRequired: true,
		Kind:               core.ToolAction,
	}
	for _, opt := range opts {
		opt(&built)
	}
	return built
}

// trigger declares an event the provider's webhook ingestor emits (the
// operation is the normalised event name the ingestor produces) so a
// workflow may start on it. Triggers observe, so they are reads; they still
// need the connection, which is how a delivery is routed to a workspace.
func trigger(name, description string) core.Tool {
	return core.Tool{
		Name:               name,
		Description:        description,
		Effect:             core.EffectRead,
		EnabledByDefault:   true,
		ConnectionRequired: true,
		Kind:               core.ToolTrigger,
		InputSchema:        map[string]any{"type": "object"},
	}
}

// optIn keeps a tool out of a workspace's default grant.
func optIn(t *core.Tool) { t.EnabledByDefault = false }

// approval forces a human decision regardless of the granting permission.
func approval(t *core.Tool) { t.RequiresApproval = true }

// withProvider stamps ownership, applied in bulk below.
func withProvider(id string, tools []core.Tool) []core.Tool {
	for index := range tools {
		tools[index].Provider = id
	}
	return tools
}
