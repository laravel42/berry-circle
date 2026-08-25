package planning

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestParseAcceptsWhatModelsActuallyReturn(t *testing.T) {
	t.Parallel()
	// Every one of these is a real shape a model returns when asked for JSON.
	for name, reply := range map[string]string{
		"bare":           `[{"title":"A","description":"d","priority":"high"}]`,
		"fenced":         "```json\n[{\"title\":\"A\",\"description\":\"d\",\"priority\":\"high\"}]\n```",
		"prose before":   "Here are the issues:\n[{\"title\":\"A\",\"description\":\"d\",\"priority\":\"high\"}]",
		"prose after":    `[{"title":"A","description":"d","priority":"high"}]` + "\nLet me know if you want more.",
		"fenced no lang": "```\n[{\"title\":\"A\",\"description\":\"d\",\"priority\":\"high\"}]\n```",
	} {
		proposals, err := Parse(reply)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if len(proposals) != 1 || proposals[0].Title != "A" {
			t.Errorf("%s: parsed %+v", name, proposals)
		}
	}
}

func TestParseRefusesAShapeItWasNotPromised(t *testing.T) {
	t.Parallel()
	// An object where an array was asked for is a failure to report, not a
	// format to guess at: guessing produces issues nobody proposed.
	for name, reply := range map[string]string{
		"empty":        "",
		"prose only":   "I could not break this down without more detail.",
		"empty array":  "[]",
		"wrong shape":  `{"issues":[{"title":"A"}]}`,
		"titles blank": `[{"title":"   ","description":"d"}]`,
	} {
		if _, err := Parse(reply); err == nil {
			t.Errorf("%s: accepted %q", name, reply)
		}
	}
}

func TestParseDropsDuplicateTitles(t *testing.T) {
	t.Parallel()
	// A model asked for distinct issues still repeats itself, and two issues
	// with one title are one issue and a duplicate.
	proposals, err := Parse(`[
	  {"title":"Add login","description":"one"},
	  {"title":"add   LOGIN","description":"two"},
	  {"title":"Add logout","description":"three"}
	]`)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(proposals) != 2 {
		t.Fatalf("parsed %d proposals, want 2: %+v", len(proposals), proposals)
	}
}

func TestParseCapsRunawayDecomposition(t *testing.T) {
	t.Parallel()
	var builder strings.Builder
	builder.WriteString("[")
	for i := 0; i < 60; i++ {
		if i > 0 {
			builder.WriteString(",")
		}
		builder.WriteString(`{"title":"Issue `)
		builder.WriteString(string(rune('a' + i%26)))
		builder.WriteString(string(rune('a' + i/26)))
		builder.WriteString(`","description":"d"}`)
	}
	builder.WriteString("]")

	proposals, err := Parse(builder.String())
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	// A brief yielding sixty issues has been restated, not decomposed, and
	// nobody reviews sixty proposals meaningfully.
	if len(proposals) != maxIssues {
		t.Fatalf("returned %d, want the cap of %d", len(proposals), maxIssues)
	}
}

func TestUnknownPriorityBecomesNoneRatherThanAGuess(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"urgent": "urgent", "critical": "urgent", "P0": "urgent",
		"high": "high", "medium": "medium", "normal": "medium",
		"low": "low", "minor": "low",
		"": "none", "spicy": "none", "blocker": "none",
	}
	for input, want := range cases {
		if got := normalizePriority(input); got != want {
			t.Errorf("normalizePriority(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestPromptCarriesTheBriefAndWhatAlreadyExists(t *testing.T) {
	t.Parallel()
	prompt := Prompt(Brief{
		ProjectName: "Password Generator",
		Description: "Build a standalone generator.",
		Repository:  "andrealune/berry-repo-test",
		Existing:    []string{"Set up the project"},
	})
	for _, expected := range []string{
		"Password Generator",
		"andrealune/berry-repo-test",
		"Build a standalone generator.",
		// A second generation must add to the work rather than propose it again.
		"Do not repeat them",
		"Set up the project",
		"JSON array",
	} {
		if !strings.Contains(prompt, expected) {
			t.Errorf("prompt is missing %q", expected)
		}
	}
}

type stubRuntime struct {
	reply string
	err   error
	asked string
}

func (runtime *stubRuntime) Ask(_ context.Context, prompt string) (string, error) {
	runtime.asked = prompt
	return runtime.reply, runtime.err
}

func TestGenerateSurfacesARuntimeFailureUnchanged(t *testing.T) {
	t.Parallel()
	failure := errors.New("runtime unavailable")
	_, err := Generate(context.Background(), &stubRuntime{err: failure}, Brief{ProjectName: "P"})
	if !errors.Is(err, failure) {
		t.Fatalf("err = %v, want the runtime's own", err)
	}
}

func TestGenerateReturnsWhatTheAgentProposed(t *testing.T) {
	t.Parallel()
	runtime := &stubRuntime{
		reply: `[{"title":"Design the API","description":"done when documented","priority":"high"}]`,
	}
	proposals, err := Generate(context.Background(), runtime, Brief{ProjectName: "P"})
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if len(proposals) != 1 || proposals[0].Priority != "high" {
		t.Fatalf("proposals = %+v", proposals)
	}
	if !strings.Contains(runtime.asked, "P") {
		t.Error("the brief did not reach the agent")
	}
}
