package codecontext

import (
	"strings"
	"testing"
)

func TestNoiseIsNotWorthAnAgentsAttention(t *testing.T) {
	t.Parallel()
	// Every one of these costs budget and teaches an agent nothing.
	for _, path := range []string{
		"node_modules/react/index.js", "vendor/github.com/x/y.go",
		"dist/bundle.js", "package-lock.json", "go.sum",
		"assets/logo.png", "app.min.js", "coverage/report.html",
	} {
		if Interesting(path) {
			t.Errorf("kept noise: %s", path)
		}
	}
	for _, path := range []string{
		"src/password.ts", "internal/service/run.go", "README.md",
	} {
		if !Interesting(path) {
			t.Errorf("dropped real code: %s", path)
		}
	}
}

func TestTermsDropWordsThatMatchEverything(t *testing.T) {
	t.Parallel()
	terms := Terms("Implement the password strength calculation",
		"This should build a meter that users can see")
	joined := strings.Join(terms, " ")
	// A term like "implement" or "build" matches half a repository, which is
	// the same as selecting nothing.
	for _, unwanted := range []string{"the", "this", "should", "implement", "build", "users"} {
		if strings.Contains(" "+joined+" ", " "+unwanted+" ") {
			t.Errorf("kept a term that matches everything: %s", unwanted)
		}
	}
	for _, wanted := range []string{"password", "strength", "calculation", "meter"} {
		if !strings.Contains(joined, wanted) {
			t.Errorf("dropped a term worth matching: %s", wanted)
		}
	}
}

func TestChoosePrefersFilesNamedAfterTheWork(t *testing.T) {
	t.Parallel()
	entries := []Entry{
		{Path: "README.md", Size: 500},
		{Path: "src/password.ts", Size: 800},
		{Path: "src/ui/button.tsx", Size: 400},
		{Path: "src/deep/nested/other/password-helper.ts", Size: 300},
		{Path: "node_modules/x/password.js", Size: 100},
	}
	chosen := Choose(entries, Terms("Implement password generation", ""), Budget{
		TreeBytes: 4096, FileBytes: 4096, MaxFiles: 4,
	})
	if len(chosen) == 0 {
		t.Fatal("chose nothing")
	}
	// Orientation first: an agent that does not know what the project is
	// cannot use the rest.
	if chosen[0] != "README.md" {
		t.Errorf("first choice = %s, want README.md", chosen[0])
	}
	if !contains(chosen, "src/password.ts") {
		t.Errorf("missed the file named after the work: %v", chosen)
	}
	for _, path := range chosen {
		if strings.Contains(path, "node_modules") {
			t.Errorf("chose a dependency: %s", path)
		}
	}
}

func TestChooseStaysWithinItsBudget(t *testing.T) {
	t.Parallel()
	entries := make([]Entry, 0, 50)
	for i := 0; i < 50; i++ {
		entries = append(entries, Entry{Path: "src/password" + string(rune('a'+i%26)) + ".ts", Size: 5000})
	}
	budget := Budget{TreeBytes: 4096, FileBytes: 12000, MaxFiles: 8}
	chosen := Choose(entries, []string{"password"}, budget)
	if len(chosen) > budget.MaxFiles {
		t.Fatalf("chose %d files, over the cap of %d", len(chosen), budget.MaxFiles)
	}
	// Every run of every issue in the project pays for this.
	if len(chosen)*5000 > budget.FileBytes {
		t.Fatalf("chose %d files of 5000 bytes, over the budget of %d",
			len(chosen), budget.FileBytes)
	}
}

func TestRenderTreeSaysWhenItRanOut(t *testing.T) {
	t.Parallel()
	entries := make([]Entry, 0, 200)
	for i := 0; i < 200; i++ {
		entries = append(entries, Entry{Path: strings.Repeat("x", 50) + string(rune(i)), Size: 10})
	}
	rendered, truncated := RenderTree(entries, Budget{TreeBytes: 500})
	if !truncated {
		t.Fatal("a tree that did not fit reported as complete")
	}
	if len(rendered) > 500 {
		t.Fatalf("rendered %d bytes over a 500 budget", len(rendered))
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
