package core

import (
	"github.com/laravel42/berry-circle/server/internal/automation"
)

// Catalog projects the provider registry into what the workflow validator
// asks: does a tool exist, what does calling it do, and is its provider
// connected in this workspace. It is built per workspace because the
// connection answer is per workspace.
type Catalog struct {
	registry *Registry
	// connected reports whether a provider has a usable connection. Nil means
	// nothing is connected, which is the right answer for a deployment
	// without integrations: Berry's own provider needs no connection and
	// every other tool then warns or refuses exactly as it should.
	connected func(provider string) bool
}

// NewCatalog builds the validator's view of the registry for one workspace.
func NewCatalog(registry *Registry, connected func(provider string) bool) Catalog {
	return Catalog{registry: registry, connected: connected}
}

// Tool implements automation.Catalog.
func (catalog Catalog) Tool(provider, operation string, kind automation.ToolKind) (automation.ToolSpec, bool) {
	if catalog.registry == nil {
		return automation.ToolSpec{}, false
	}
	tool, ok := catalog.registry.ToolByOperation(provider, operation, ToolKind(kind))
	if !ok {
		return automation.ToolSpec{}, false
	}
	return automation.ToolSpec{
		Provider:           tool.Provider,
		Operation:          tool.Operation(),
		Kind:               automation.ToolKind(tool.Kind.Normalized()),
		ConnectionRequired: tool.ConnectionRequired,
		RequiresApproval:   tool.RequiresApproval,
		Destructive:        tool.Effect == EffectDestructive,
		InputSchema:        tool.InputSchema,
		OutputSchema:       tool.OutputSchema,
	}, true
}

// Connected implements automation.Catalog.
func (catalog Catalog) Connected(provider string) bool {
	if catalog.connected == nil {
		return false
	}
	return catalog.connected(provider)
}

// ConnectedSet turns a list of provider ids into the predicate NewCatalog
// takes.
func ConnectedSet(providers []string) func(string) bool {
	set := make(map[string]bool, len(providers))
	for _, provider := range providers {
		set[provider] = true
	}
	return func(provider string) bool { return set[provider] }
}

var _ automation.Catalog = Catalog{}
