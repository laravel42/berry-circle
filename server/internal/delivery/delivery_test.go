package delivery

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/integrations/github"
)

func TestRepositoryPathRefusesAnythingThatLeavesTheTree(t *testing.T) {
	t.Parallel()
	// A delivery is a commit, and a commit that writes outside the tree it
	// claims to change is not reviewable. The agent names these files, and the
	// agent is running model-authored code.
	for _, name := range []string{
		"", ".", "/", "/etc/passwd", "../outside.txt", "../../escape",
		"a/../../b", "./../x", "//",
	} {
		if got := RepositoryPath(name); got != "" {
			t.Errorf("RepositoryPath(%q) = %q, want refusal", name, got)
		}
	}
	for name, want := range map[string]string{
		"index.ts":        "index.ts",
		"src/password.ts": "src/password.ts",
		"./src/app.tsx":   "src/app.tsx",
		"docs/readme.md":  "docs/readme.md",
	} {
		if got := RepositoryPath(name); got != want {
			t.Errorf("RepositoryPath(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestBranchNameIsUniquePerRunNotPerIssue(t *testing.T) {
	t.Parallel()
	first, second := uuid.New(), uuid.New()
	// Two runs on one issue are two attempts. Reusing a branch would make the
	// second fail against the first's ref, or appear to succeed while
	// delivering nothing new.
	a := BranchName("PLATFORM-34", first)
	b := BranchName("PLATFORM-34", second)
	if a == b {
		t.Fatalf("two runs produced one branch: %s", a)
	}
	for _, branch := range []string{a, b} {
		if !strings.HasPrefix(branch, "berry/platform-34-") {
			t.Errorf("branch = %q, want it named after the issue", branch)
		}
		if strings.ContainsAny(branch, " ~^:?*[\\") {
			t.Errorf("branch = %q contains characters git refuses", branch)
		}
	}
}

func TestBranchNameSurvivesAnAwkwardIdentifier(t *testing.T) {
	t.Parallel()
	branch := BranchName("Feature/Odd Name!", uuid.New())
	if strings.ContainsAny(branch, " !") {
		t.Errorf("branch = %q kept characters git refuses", branch)
	}
	if !strings.HasPrefix(branch, "berry/") {
		t.Errorf("branch = %q lost its prefix", branch)
	}
}

func TestBodySaysNobodyHasReviewedIt(t *testing.T) {
	t.Parallel()
	body := Body(
		Run{IssueIdentifier: "PLATFORM-34", AgentSlug: "coder"},
		[]github.FileChange{{Path: "src/a.ts"}, {Path: "src/b.ts"}},
	)
	// A reviewer's first question about a machine-authored change is how much
	// of it anyone has looked at.
	if !strings.Contains(body, "Nobody has reviewed this") {
		t.Error("the body does not say the change is unreviewed")
	}
	for _, expected := range []string{"PLATFORM-34", "coder", "src/a.ts", "src/b.ts"} {
		if !strings.Contains(body, expected) {
			t.Errorf("body is missing %q", expected)
		}
	}
}
