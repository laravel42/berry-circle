package orchestration

import (
	"errors"
	"strings"
	"testing"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

func TestOrchestratorSpecRequiresBothFields(t *testing.T) {
	cases := map[string]OrchestratorSpec{
		"empty":         {},
		"provider only": {Provider: "anthropic"},
		"model only":    {Model: "claude-opus-5"},
		"blank":         {Provider: "  ", Model: "  "},
	}
	for name, spec := range cases {
		if spec.Configured() {
			t.Errorf("%s: Configured() = true, want false", name)
		}
	}
	if !(OrchestratorSpec{Provider: "anthropic", Model: "claude-opus-5"}).Configured() {
		t.Error("a complete spec should be configured")
	}
}

func TestOrchestratorManifestIsValidTOML(t *testing.T) {
	manifest := orchestratorManifest("Orchestrator", OrchestratorSpec{
		Provider: "anthropic",
		Model:    "claude-opus-5",
	})
	for _, want := range []string{
		`name = "Orchestrator"`,
		"[model]",
		`provider = "anthropic"`,
		`model = "claude-opus-5"`,
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest missing %q\ngot:\n%s", want, manifest)
		}
	}
}

// A name carrying a quote or newline must not be able to inject manifest keys.
func TestOrchestratorManifestEscapesInjection(t *testing.T) {
	manifest := orchestratorManifest(
		"evil\"\n[model]\nprovider = \"attacker",
		OrchestratorSpec{Provider: "anthropic", Model: "claude-opus-5"},
	)
	// The injected copy is escaped inside the quoted value, so it is inert.
	// What matters is that only one real section header exists at line start.
	headers := 0
	for _, line := range strings.Split(manifest, "\n") {
		if strings.TrimSpace(line) == "[model]" {
			headers++
		}
	}
	if headers != 1 {
		t.Fatalf("manifest injection succeeded (%d headers):\n%s", headers, manifest)
	}
	if strings.Contains(manifest, `provider = "attacker"`) {
		t.Fatalf("attacker controlled provider:\n%s", manifest)
	}
}

// Only a definitive 404 may authorise a spawn. Treating a transport or auth
// failure as absence would create a duplicate upstream agent on every restart.
func TestOnlyNotFoundAuthorisesSpawn(t *testing.T) {
	if !isMissingUpstream(&openfang.UpstreamError{Kind: openfang.ErrorNotFound}) {
		t.Error("a 404 should authorise provisioning")
	}
	for _, kind := range []openfang.ErrorKind{
		openfang.ErrorAuth,
		openfang.ErrorUnavailable,
		openfang.ErrorBadRequest,
	} {
		if isMissingUpstream(&openfang.UpstreamError{Kind: kind}) {
			t.Errorf("%v must not authorise provisioning", kind)
		}
	}
	if isMissingUpstream(errors.New("connection refused")) {
		t.Error("a transport failure must not authorise provisioning")
	}
}
