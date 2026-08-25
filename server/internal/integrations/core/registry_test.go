package core

import (
	"strings"
	"testing"
)

type fakeProvider struct {
	id    string
	tools []Tool
}

func (p fakeProvider) ID() string          { return p.id }
func (p fakeProvider) Name() string        { return strings.ToUpper(p.id) }
func (p fakeProvider) Description() string { return "" }
func (p fakeProvider) Tools() []Tool       { return p.tools }
func (p fakeProvider) Scopes() []string    { return nil }
func (p fakeProvider) MCPServer(string) MCPServerConfig {
	return MCPServerConfig{Name: p.id}
}

func TestRegistryResolvesProvidersAndTools(t *testing.T) {
	registry := NewRegistry()
	github := fakeProvider{id: "github", tools: []Tool{
		{Name: "github.get_issue", Provider: "github", Effect: EffectRead},
	}}
	if err := registry.Register(github); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if _, ok := registry.Get("github"); !ok {
		t.Error("registered provider is not resolvable")
	}
	if _, ok := registry.Get("nope"); ok {
		t.Error("an unregistered provider resolved")
	}
	tool, ok := registry.Tool("github.get_issue")
	if !ok || tool.Effect != EffectRead {
		t.Errorf("Tool lookup = %+v, %v", tool, ok)
	}
	if _, ok := registry.Tool("github.not_a_tool"); ok {
		t.Error("an unknown tool resolved")
	}
	if _, ok := registry.Tool("unqualified"); ok {
		t.Error("a name with no provider prefix resolved")
	}
}

// A mismatched prefix would make tool names ambiguous across providers, so it
// must fail at startup rather than the first time an agent calls it.
func TestRegistrationRejectsAMisprefixedTool(t *testing.T) {
	registry := NewRegistry()
	err := registry.Register(fakeProvider{id: "slack", tools: []Tool{
		{Name: "github.get_issue", Provider: "slack", Effect: EffectRead},
	}})
	if err == nil {
		t.Fatal("a tool prefixed with another provider was accepted")
	}
}

func TestRegistrationRejectsAnUnclassifiedTool(t *testing.T) {
	registry := NewRegistry()
	err := registry.Register(fakeProvider{id: "slack", tools: []Tool{
		{Name: "slack.post_message", Provider: "slack", Effect: Effect("")},
	}})
	if err == nil {
		t.Fatal("a tool with no effect classification was accepted")
	}
}

// A destructive tool enabled by default would be granted by any workspace that
// never opened its settings.
func TestRegistrationRejectsADefaultOnDestructiveTool(t *testing.T) {
	registry := NewRegistry()
	err := registry.Register(fakeProvider{id: "github", tools: []Tool{
		{
			Name: "github.merge_pull_request", Provider: "github",
			Effect: EffectDestructive, EnabledByDefault: true,
		},
	}})
	if err == nil {
		t.Fatal("a destructive tool was allowed to default on")
	}
}

func TestRegistrationRejectsDuplicatesAndEmptyIDs(t *testing.T) {
	registry := NewRegistry()
	if err := registry.Register(fakeProvider{id: "github"}); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if err := registry.Register(fakeProvider{id: "github"}); err == nil {
		t.Error("a duplicate provider was accepted")
	}
	if err := registry.Register(fakeProvider{id: "  "}); err == nil {
		t.Error("a blank provider id was accepted")
	}
	if err := registry.Register(nil); err == nil {
		t.Error("a nil provider was accepted")
	}
}

func TestListIsOrdered(t *testing.T) {
	registry := NewRegistry()
	for _, id := range []string{"slack", "github", "notion"} {
		if err := registry.Register(fakeProvider{id: id}); err != nil {
			t.Fatalf("Register(%s): %v", id, err)
		}
	}
	var ids []string
	for _, provider := range registry.List() {
		ids = append(ids, provider.ID())
	}
	want := []string{"github", "notion", "slack"}
	for index := range want {
		if ids[index] != want[index] {
			t.Fatalf("List() = %v, want %v", ids, want)
		}
	}
}
