package core

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Registry resolves providers by id.
//
// Every consumer asks the registry rather than switching on a provider name, so
// adding a provider — including a future Composio adapter — touches
// registration and nothing else.
type Registry struct {
	mu        sync.RWMutex
	providers map[string]Provider
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{providers: map[string]Provider{}}
}

// Register adds a provider.
//
// Validation happens here rather than at call time: a tool whose name does not
// match its provider, or whose effect is unrecognised, is a programming error
// that should surface at startup instead of the first time an agent tries it.
func (registry *Registry) Register(provider Provider) error {
	if registry == nil {
		return fmt.Errorf("registry is nil")
	}
	if provider == nil {
		return fmt.Errorf("provider is nil")
	}
	id := provider.ID()
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("provider id is empty")
	}
	for _, tool := range provider.Tools() {
		if !strings.HasPrefix(tool.Name, id+".") {
			return fmt.Errorf(
				"provider %q declares tool %q, which is not prefixed %q",
				id, tool.Name, id+".",
			)
		}
		if !tool.Effect.Valid() {
			return fmt.Errorf("tool %q has unknown effect %q", tool.Name, tool.Effect)
		}
		// A destructive tool that is on by default would be granted by any
		// workspace that never looked at its settings.
		if tool.Effect == EffectDestructive && tool.EnabledByDefault {
			return fmt.Errorf("destructive tool %q cannot be enabled by default", tool.Name)
		}
	}

	registry.mu.Lock()
	defer registry.mu.Unlock()
	if _, exists := registry.providers[id]; exists {
		return fmt.Errorf("provider %q is already registered", id)
	}
	registry.providers[id] = provider
	return nil
}

// MustRegister panics on failure. For startup wiring, where a bad provider
// should stop the process rather than leave it half-configured.
func (registry *Registry) MustRegister(provider Provider) {
	if err := registry.Register(provider); err != nil {
		panic(fmt.Sprintf("integration registry: %v", err))
	}
}

// Get returns a provider by id.
func (registry *Registry) Get(id string) (Provider, bool) {
	if registry == nil {
		return nil, false
	}
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	provider, ok := registry.providers[id]
	return provider, ok
}

// List returns every provider, ordered by id so callers and tests see a stable
// sequence.
func (registry *Registry) List() []Provider {
	if registry == nil {
		return nil
	}
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	out := make([]Provider, 0, len(registry.providers))
	for _, provider := range registry.providers {
		out = append(out, provider)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].ID() < out[b].ID() })
	return out
}

// Tool finds one tool by its fully qualified name.
func (registry *Registry) Tool(name string) (Tool, bool) {
	provider, _, ok := strings.Cut(name, ".")
	if !ok {
		return Tool{}, false
	}
	registered, ok := registry.Get(provider)
	if !ok {
		return Tool{}, false
	}
	for _, tool := range registered.Tools() {
		if tool.Name == name {
			return tool, true
		}
	}
	return Tool{}, false
}
