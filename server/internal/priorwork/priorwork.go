// Package priorwork gives an agent what the work before it produced.
//
// Berry's agents cannot hand each other files. OpenFang scopes every file
// tool to the agent's own workspace directory, its file API accepts only a
// whitelist of identity documents, and the worker mounts the runtime volume
// read-only on purpose. So the handoff travels the way repository context
// already does: Berry reads the artifacts of the runs this issue depends on
// and puts them in the next agent's prompt.
//
// What crosses is text. An agent that produced a diagram or an archive has
// produced something the next agent could not have read anyway — that stays
// an artifact on the issue, where a person can open it.
package priorwork

import (
	"context"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Budget bounds what one handoff may cost the prompt.
//
// The dispatch message is capped at 64 KiB and already carries the issue, its
// description and the repository. Prior work is one input among those, not the
// whole message: an issue with six dependencies must not push the repository
// out of the prompt to make room for them.
type Budget struct {
	MaxFiles     int
	MaxFileBytes int
	MaxTotal     int
}

// DefaultBudget is what dispatch uses.
var DefaultBudget = Budget{MaxFiles: 6, MaxFileBytes: 8 * 1024, MaxTotal: 24 * 1024}

// Artifact is one file an earlier run produced.
type Artifact struct {
	IssueIdentifier string
	IssueTitle      string
	AgentName       string
	FileName        string
	ContentType     string
	SizeBytes       int64
	StorageKey      string
}

// Source lists the artifacts of the runs an issue depends on, newest first.
type Source interface {
	DependencyArtifacts(ctx context.Context, issueID uuid.UUID, limit int) ([]Artifact, error)
}

// Reader opens a stored artifact.
type Reader interface {
	Open(ctx context.Context, storageKey string) (io.ReadCloser, error)
}

// Builder renders the handoff section of a dispatch prompt.
type Builder struct {
	Source Source
	Reader Reader
	Budget Budget
}

// Build returns the prompt section, or "" when there is nothing to hand over.
//
// Best effort throughout, like the repository builder: an issue whose
// dependencies cannot be read is dispatched with a worse-informed agent rather
// than not at all. A blocked handoff is a weaker prompt, not a failed run.
func (builder Builder) Build(ctx context.Context, issueID uuid.UUID) string {
	if builder.Source == nil || builder.Reader == nil || issueID == uuid.Nil {
		return ""
	}
	budget := builder.Budget
	if budget.MaxFiles <= 0 {
		budget = DefaultBudget
	}

	// Over-fetch: the newest artifacts may all be unreadable binaries, and
	// stopping at MaxFiles candidates would hand over nothing when readable
	// text sat just behind them.
	artifacts, err := builder.Source.DependencyArtifacts(ctx, issueID, budget.MaxFiles*4)
	if err != nil || len(artifacts) == 0 {
		return ""
	}

	var (
		section strings.Builder
		taken   int
		spent   int
	)
	for _, artifact := range artifacts {
		if taken >= budget.MaxFiles || spent >= budget.MaxTotal {
			break
		}
		if !readableAsText(artifact) {
			continue
		}
		body, ok := builder.read(ctx, artifact, budget.MaxFileBytes)
		if !ok {
			continue
		}
		if spent+len(body) > budget.MaxTotal {
			continue
		}
		section.WriteString("\n--- ")
		section.WriteString(artifact.FileName)
		section.WriteString(" (from ")
		section.WriteString(artifact.IssueIdentifier)
		if artifact.AgentName != "" {
			section.WriteString(", written by ")
			section.WriteString(artifact.AgentName)
		}
		section.WriteString(") ---\n")
		section.WriteString(body)
		if !strings.HasSuffix(body, "\n") {
			section.WriteString("\n")
		}
		taken++
		spent += len(body)
	}
	if taken == 0 {
		return ""
	}

	var out strings.Builder
	out.WriteString("\n\nWork this task depends on\n")
	out.WriteString("These files were produced by the tasks that had to finish before this one. ")
	out.WriteString("They are the current state of that work — build on them rather than redoing them, ")
	out.WriteString("and follow any decision or convention they establish.\n")
	out.WriteString(section.String())
	if skipped := len(artifacts) - taken; skipped > 0 {
		out.WriteString(fmt.Sprintf(
			"\n(%d further file%s from those tasks are attached to their issues but not shown here.)\n",
			skipped, plural(skipped)))
	}
	return out.String()
}

func (builder Builder) read(ctx context.Context, artifact Artifact, limit int) (string, bool) {
	handle, err := builder.Reader.Open(ctx, artifact.StorageKey)
	if err != nil {
		return "", false
	}
	defer handle.Close()
	// One byte past the limit distinguishes "exactly fits" from "was cut".
	raw, err := io.ReadAll(io.LimitReader(handle, int64(limit)+1))
	if err != nil || len(raw) == 0 {
		return "", false
	}
	truncated := len(raw) > limit
	if truncated {
		raw = raw[:limit]
	}
	body := string(raw)
	for !utf8.ValidString(body) && len(body) > 0 {
		body = body[:len(body)-1]
	}
	// A file that is not text after all — the content type lied, or it is a
	// binary the promoter typed generously. Passing it through would spend the
	// budget on bytes the model cannot use.
	if body == "" || strings.ContainsRune(body, 0) {
		return "", false
	}
	if truncated {
		body += "\n[…file continues; open the artifact on " + artifact.IssueIdentifier + " for the rest]"
	}
	return body, true
}

// readableAsText decides from the artifact row alone, before paying to fetch.
//
// The promoter deliberately never types agent output as anything renderable,
// so a text file arrives as text/plain and everything else as an opaque
// stream. Extensions are the better signal here, and a missing one is treated
// as text because plain notes routinely have none.
func readableAsText(artifact Artifact) bool {
	if artifact.SizeBytes <= 0 {
		return false
	}
	if strings.HasPrefix(artifact.ContentType, "text/") {
		return true
	}
	name := strings.ToLower(artifact.FileName)
	dot := strings.LastIndex(name, ".")
	if dot < 0 {
		return true
	}
	switch name[dot+1:] {
	case "md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "sql",
		"go", "ts", "tsx", "js", "jsx", "py", "rs", "rb", "java", "kt", "swift",
		"c", "h", "cpp", "hpp", "cs", "sh", "html", "css", "xml", "env", "ini",
		"conf", "cfg", "gradle", "proto", "graphql", "tf", "dockerfile":
		return true
	}
	return false
}

func plural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}
