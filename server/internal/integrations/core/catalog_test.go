package core

import (
	"testing"

	"github.com/laravel42/berry-circle/server/internal/automation"
)

type catalogProvider struct {
	id    string
	tools []Tool
}

func (provider catalogProvider) ID() string                       { return provider.id }
func (provider catalogProvider) Name() string                     { return provider.id }
func (provider catalogProvider) Description() string              { return "" }
func (provider catalogProvider) Tools() []Tool                    { return provider.tools }
func (provider catalogProvider) Scopes() []string                 { return nil }
func (provider catalogProvider) MCPServer(string) MCPServerConfig { return MCPServerConfig{} }

// The catalog answers by operation and kind, translates the effect ladder
// into the validator's destructive flag, and reports connections per
// workspace.
func TestCatalogProjectsRegistryToolsForTheValidator(t *testing.T) {
	registry := NewRegistry()
	registry.MustRegister(catalogProvider{id: "acme", tools: []Tool{
		{Name: "acme.on_order", Provider: "acme", Effect: EffectRead, Kind: ToolTrigger, ConnectionRequired: true},
		{Name: "acme.ship", Provider: "acme", Effect: EffectWrite, ConnectionRequired: true,
			InputSchema: map[string]any{"required": []any{"orderId"}}},
		{Name: "acme.purge", Provider: "acme", Effect: EffectDestructive, RequiresApproval: true, ConnectionRequired: true},
	}})
	catalog := NewCatalog(registry, ConnectedSet([]string{"acme"}))

	if spec, ok := catalog.Tool("acme", "on_order", automation.ToolTrigger); !ok || spec.Kind != automation.ToolTrigger {
		t.Fatalf("trigger lookup = %+v, %v", spec, ok)
	}
	if _, ok := catalog.Tool("acme", "on_order", automation.ToolAction); ok {
		t.Fatal("a trigger must not resolve as an action")
	}
	ship, ok := catalog.Tool("acme", "ship", automation.ToolAction)
	if !ok || ship.Destructive || ship.RequiresApproval || !ship.ConnectionRequired || ship.InputSchema == nil {
		t.Fatalf("action lookup = %+v, %v", ship, ok)
	}
	if purge, ok := catalog.Tool("acme", "purge", automation.ToolAction); !ok || !purge.Destructive || !purge.RequiresApproval {
		t.Fatalf("destructive lookup = %+v, %v", purge, ok)
	}
	if _, ok := catalog.Tool("acme", "missing", automation.ToolAction); ok {
		t.Fatal("unknown operation resolved")
	}
	if !catalog.Connected("acme") || catalog.Connected("other") {
		t.Fatal("connection predicate not honoured")
	}
	if NewCatalog(registry, nil).Connected("acme") {
		t.Fatal("nil predicate must report nothing connected")
	}
	if got := registry.ListTools(ToolTrigger, ""); len(got) != 1 || got[0].Name != "acme.on_order" {
		t.Fatalf("ListTools(trigger) = %+v", got)
	}
	if got := registry.ListTools("", "acme"); len(got) != 3 || got[1].Kind != ToolAction {
		t.Fatalf("ListTools(all) = %+v", got)
	}
}
