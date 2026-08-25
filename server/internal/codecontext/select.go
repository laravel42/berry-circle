// Package codecontext decides what an agent sees of a repository.
//
// A repository does not fit in a context window — this one is roughly three
// million tokens — so something must choose, and the choice is the feature.
// The tree is always included because it is small and tells an agent where
// things live; file contents are chosen by how well their path matches the
// issue, under a byte budget that is spent on the best matches first.
package codecontext

import (
	"path"
	"sort"
	"strings"
	"unicode"
)

// Budget bounds what is added to a prompt.
//
// Deliberately modest. A run already carries a system prompt and tool schemas,
// the prompt itself is capped at 64KB downstream, and every byte here is paid
// for on every run of every issue in the project.
type Budget struct {
	// TreeBytes caps the rendered file tree.
	TreeBytes int
	// FileBytes caps the total of all included file contents.
	FileBytes int
	// MaxFiles caps how many files are read, because each is a request.
	MaxFiles int
}

// DefaultBudget is what a run gets unless a caller says otherwise.
func DefaultBudget() Budget {
	return Budget{TreeBytes: 12 * 1024, FileBytes: 40 * 1024, MaxFiles: 8}
}

// Entry is one candidate file.
type Entry struct {
	Path string
	Size int64
}

// noise are paths that cost budget and teach an agent nothing: dependencies,
// build output, lockfiles, and anything generated.
var noise = []string{
	"node_modules/", "vendor/", "dist/", "build/", ".next/", "target/",
	"coverage/", "testdata/", ".git/", "__pycache__/", ".venv/",
}

var noiseSuffix = []string{
	".lock", ".sum", ".min.js", ".map", ".snap", ".png", ".jpg", ".jpeg",
	".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".zip",
	".mp4", ".mov", ".webm", ".wasm", ".bin",
}

// noiseNames are lockfiles and generated manifests that a suffix rule misses:
// package-lock.json ends in .json like every real config file does.
var noiseNames = map[string]bool{
	"package-lock.json": true, "pnpm-lock.yaml": true, "yarn.lock": true,
	"composer.lock": true, "gemfile.lock": true, "poetry.lock": true,
	"cargo.lock": true, "go.sum": true,
}

// Interesting reports whether a path is worth an agent's attention.
func Interesting(candidate string) bool {
	lower := strings.ToLower(candidate)
	if noiseNames[strings.ToLower(path.Base(candidate))] {
		return false
	}
	for _, prefix := range noise {
		if strings.Contains(lower, prefix) {
			return false
		}
	}
	for _, suffix := range noiseSuffix {
		if strings.HasSuffix(lower, suffix) {
			return false
		}
	}
	return true
}

// alwaysRead are read regardless of the issue, because they describe the
// project itself and orient everything else.
var alwaysRead = []string{
	"readme.md", "readme", "package.json", "go.mod", "cargo.toml",
	"pyproject.toml", "requirements.txt", "makefile",
}

// Rank scores a path against the words in an issue.
//
// Path-based rather than content-based on purpose: scoring contents would mean
// reading every file first, which is the cost this exists to avoid. A path is a
// weak signal, but a repository's paths are named after what is in them.
func Rank(candidate string, terms []string) int {
	lower := strings.ToLower(candidate)
	base := strings.ToLower(path.Base(candidate))
	stem := strings.TrimSuffix(base, path.Ext(base))

	score := 0
	for _, term := range terms {
		switch {
		case stem == term:
			// The file is named exactly what the issue is about.
			score += 12
		case strings.Contains(base, term):
			score += 6
		case strings.Contains(lower, term):
			score += 2
		}
	}
	if score > 0 {
		// Shallow files are more likely to be the thing itself rather than one
		// of its many implementation details.
		score += 3 - min(strings.Count(candidate, "/"), 3)
	}
	return score
}

// Terms extracts the words worth matching on from an issue.
//
// Short and common words are dropped: matching "the" or "add" against a path
// list returns the whole repository, which is the same as choosing nothing.
func Terms(title, description string) []string {
	seen := make(map[string]struct{})
	terms := make([]string, 0, 16)
	for _, word := range strings.FieldsFunc(
		strings.ToLower(title+" "+description),
		func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) },
	) {
		if len(word) < 4 || stopWords[word] {
			continue
		}
		if _, repeated := seen[word]; repeated {
			continue
		}
		seen[word] = struct{}{}
		terms = append(terms, word)
		if len(terms) == 24 {
			break
		}
	}
	return terms
}

var stopWords = map[string]bool{
	"this": true, "that": true, "with": true, "from": true, "into": true,
	"when": true, "then": true, "than": true, "have": true, "should": true,
	"must": true, "will": true, "make": true, "made": true, "using": true,
	"about": true, "which": true, "there": true, "their": true, "them": true,
	"also": true, "each": true, "some": true, "more": true, "most": true,
	"issue": true, "task": true, "work": true, "done": true, "want": true,
	"need": true, "code": true, "file": true, "files": true, "user": true,
	"users": true, "application": true, "implement": true, "create": true,
	"build": true, "support": true, "provide": true, "ensure": true,
}

// Choose picks which files to read, best match first.
//
// Orientation files come first whatever the issue says, because an agent that
// does not know what the project is cannot use the rest.
func Choose(entries []Entry, terms []string, budget Budget) []string {
	type scored struct {
		path  string
		size  int64
		score int
	}
	candidates := make([]scored, 0, len(entries))
	for _, entry := range entries {
		if !Interesting(entry.Path) || entry.Size <= 0 {
			continue
		}
		base := strings.ToLower(path.Base(entry.Path))
		score := Rank(entry.Path, terms)
		for _, always := range alwaysRead {
			if base == always && !strings.Contains(entry.Path, "/") {
				score += 100
			}
		}
		if score <= 0 {
			continue
		}
		candidates = append(candidates, scored{entry.Path, entry.Size, score})
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].score != candidates[right].score {
			return candidates[left].score > candidates[right].score
		}
		// Smaller first at equal score: two files that match equally well buy
		// more coverage for the same budget when the smaller one is taken.
		return candidates[left].size < candidates[right].size
	})

	chosen := make([]string, 0, budget.MaxFiles)
	spent := 0
	for _, candidate := range candidates {
		if len(chosen) >= budget.MaxFiles {
			break
		}
		if spent+int(candidate.size) > budget.FileBytes {
			continue
		}
		chosen = append(chosen, candidate.path)
		spent += int(candidate.size)
	}
	return chosen
}

// RenderTree lays the paths out for a prompt, truncating rather than dropping
// the tree entirely when it does not fit.
func RenderTree(entries []Entry, budget Budget) (string, bool) {
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		if Interesting(entry.Path) {
			paths = append(paths, entry.Path)
		}
	}
	sort.Strings(paths)

	var builder strings.Builder
	truncated := false
	for _, candidate := range paths {
		if builder.Len()+len(candidate)+1 > budget.TreeBytes {
			truncated = true
			break
		}
		builder.WriteString(candidate)
		builder.WriteByte('\n')
	}
	return builder.String(), truncated
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
