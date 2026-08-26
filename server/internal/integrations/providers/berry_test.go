package providers

import (
	"testing"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/integrations/core"
)

// Berry's provider registers beside the five, needs no connection, and every
// trigger names a topic the dispatcher actually scans.
func TestBerryProviderDeclaresConnectionFreeTriggersAndActions(t *testing.T) {
	registry := core.NewRegistry()
	for _, provider := range All() {
		registry.MustRegister(provider)
	}
	if err := registry.Register(Berry{}); err != nil {
		t.Fatalf("Register(berry): %v", err)
	}
	triggers := registry.ListTools(core.ToolTrigger, ProviderBerry)
	if len(triggers) != len(berryTriggers) {
		t.Fatalf("triggers = %d, want %d", len(triggers), len(berryTriggers))
	}
	for _, tool := range triggers {
		if tool.ConnectionRequired {
			t.Errorf("%s requires a connection", tool.Name)
		}
		topic, ok := BerryTriggerTopic(tool.Operation())
		if !ok || !automation.KnownBerryEvent(topic) {
			t.Errorf("%s maps to %q, which the dispatcher never scans", tool.Name, topic)
		}
	}
	actions := registry.ListTools(core.ToolAction, ProviderBerry)
	want := []string{"create_issue", "update_issue", "assign_issue", "move_issue", "complete_issue", "create_goal", "update_goal",
		"run_agent", "wait_for_agent", "ask_agent", "request_approval", "wait_for_approval", "add_comment", "attach_artifact",
		"search_issues", "get_issue", "get_goal"}
	found := map[string]core.Tool{}
	for _, tool := range actions {
		found[tool.Operation()] = tool
	}
	for _, operation := range want {
		tool, ok := found[operation]
		if !ok {
			t.Errorf("action berry.%s is missing", operation)
			continue
		}
		if tool.ConnectionRequired || tool.Kind != core.ToolAction || tool.InputSchema == nil {
			t.Errorf("berry.%s = %+v", operation, tool)
		}
	}
	if len(found) != len(want) {
		t.Errorf("actions = %d, want %d", len(found), len(want))
	}
	catalog := core.NewCatalog(registry, nil)
	if spec, ok := catalog.Tool("berry", "issue_completed", automation.ToolTrigger); !ok || spec.ConnectionRequired {
		t.Fatalf("catalog trigger = %+v, %v", spec, ok)
	}
	// Every non-Berry tool still says it needs a connection.
	for _, tool := range registry.ListTools("", "github") {
		if !tool.ConnectionRequired {
			t.Fatalf("%s lost its connection requirement", tool.Name)
		}
	}
}
