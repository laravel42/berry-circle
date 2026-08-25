// Package planning turns a project brief into issues an agent proposed.
//
// One synchronous runtime turn, not a run. A run is durable, streamed and
// reconciled because it represents work an agent does in the world; proposing
// a list of issues is a question with an answer, and modelling it as a run
// would mean a workflow, a dispatch state machine and a projection for
// something the person is waiting on with a button held down.
package planning

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// maxIssues bounds one generation.
//
// A brief that yields fifty issues has not been decomposed, it has been
// restated, and a person cannot review fifty proposals meaningfully. What is
// dropped is reported rather than silently truncated.
const maxIssues = 15

// maxBriefBytes bounds what is sent upstream. Long descriptions are common and
// the tail of one is rarely what defines the work.
const maxBriefBytes = 24 * 1024

// Proposal is one issue an agent suggested.
type Proposal struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"`
	// Agent is the specialist nominated to do it, by name. Empty leaves the
	// issue unassigned for ordinary routing to place.
	Agent string `json:"agent"`
}

// Candidate is an agent the plan may nominate.
type Candidate struct {
	Name         string
	Capabilities []string
}

// Brief is what the agent is asked to decompose.
type Brief struct {
	ProjectName string
	Description string
	Repository  string
	// Existing titles already on the project, so a second generation adds to
	// the work rather than proposing it again.
	Existing []string
	// Candidates the plan may nominate. Supplied rather than invented: an
	// issue assigned to an agent that does not exist is worse than one left
	// for routing, because it looks decided and never runs.
	Candidates []Candidate
}

// Prompt renders the request sent to the agent.
//
// The output contract is stated twice — once as a rule and once as a shape —
// because a model that drifts usually drifts into prose around the JSON rather
// than into different JSON, and the parser can recover from the former.
func Prompt(brief Brief) string {
	var builder strings.Builder
	builder.WriteString("Decompose this project into a small number of concrete issues.\n\n")
	builder.WriteString("Project: ")
	builder.WriteString(brief.ProjectName)
	if brief.Repository != "" {
		builder.WriteString("\nRepository: ")
		builder.WriteString(brief.Repository)
	}
	if description := strings.TrimSpace(brief.Description); description != "" {
		builder.WriteString("\n\nBrief:\n")
		builder.WriteString(truncate(description, maxBriefBytes))
	}
	if len(brief.Existing) > 0 {
		builder.WriteString("\n\nThese issues already exist. Do not repeat them:\n")
		for _, title := range brief.Existing {
			builder.WriteString("- ")
			builder.WriteString(title)
			builder.WriteString("\n")
		}
	}

	if len(brief.Candidates) > 0 {
		builder.WriteString("\n\nAssign each issue to one of these agents, by name:\n")
		for _, candidate := range brief.Candidates {
			builder.WriteString("- ")
			builder.WriteString(candidate.Name)
			if len(candidate.Capabilities) > 0 {
				builder.WriteString(" (")
				builder.WriteString(strings.Join(candidate.Capabilities, ", "))
				builder.WriteString(")")
			}
			builder.WriteString("\n")
		}
	}

	builder.WriteString("\n\nRules:\n")
	builder.WriteString("- Reply with a JSON array and nothing else.\n")
	builder.WriteString(fmt.Sprintf("- At most %d issues. Fewer is better.\n", maxIssues))
	builder.WriteString("- Each issue must be independently deliverable.\n")
	builder.WriteString("- priority is one of: urgent, high, medium, low, none.\n")
	builder.WriteString("- title is one line. description says what done looks like.\n")
	if len(brief.Candidates) > 0 {
		builder.WriteString("- agent is one of the names listed above, whichever suits the work.\n")
	}
	builder.WriteString("\nShape:\n")
	if len(brief.Candidates) > 0 {
		builder.WriteString(
			`[{"title":"...","description":"...","priority":"medium","agent":"coder"}]`)
	} else {
		builder.WriteString(`[{"title":"...","description":"...","priority":"medium"}]`)
	}
	return builder.String()
}

// ErrNoProposals means the agent answered without a usable list.
var ErrNoProposals = errors.New("planning: the agent proposed no issues")

// Parse extracts proposals from an agent's reply.
//
// Tolerant of what models actually return: a fenced block, a sentence before
// the array, a trailing explanation. Not tolerant of a different shape — an
// object where an array was asked for is a failure to report, not a format to
// guess at, because guessing produces issues nobody proposed.
func Parse(reply string) ([]Proposal, error) {
	raw := strings.TrimSpace(reply)
	if raw == "" {
		return nil, ErrNoProposals
	}
	if fenced := betweenFences(raw); fenced != "" {
		raw = fenced
	}
	start := strings.Index(raw, "[")
	end := strings.LastIndex(raw, "]")
	if start < 0 || end <= start {
		return nil, ErrNoProposals
	}
	// Prose before the array is fine; an object around it is not. A reply like
	// {"issues":[...]} contains a perfectly parseable array, and reaching into
	// it would mean accepting a shape that was not asked for — which is how a
	// parser starts inventing issues from whatever nesting a model chose.
	if strings.ContainsAny(raw[:start], "{") {
		return nil, ErrNoProposals
	}

	var parsed []Proposal
	if err := json.Unmarshal([]byte(raw[start:end+1]), &parsed); err != nil {
		return nil, fmt.Errorf("planning: reply was not a JSON array: %w", err)
	}

	proposals := make([]Proposal, 0, len(parsed))
	seen := make(map[string]struct{}, len(parsed))
	for _, proposal := range parsed {
		title := collapse(proposal.Title)
		if title == "" {
			continue
		}
		// A model asked for distinct issues still repeats itself; two issues
		// with one title are one issue and a duplicate.
		key := strings.ToLower(title)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}

		proposals = append(proposals, Proposal{
			Title:       truncate(title, 500),
			Description: truncate(strings.TrimSpace(proposal.Description), 20000),
			Priority:    normalizePriority(proposal.Priority),
			Agent:       collapse(proposal.Agent),
		})
		if len(proposals) == maxIssues {
			break
		}
	}
	if len(proposals) == 0 {
		return nil, ErrNoProposals
	}
	return proposals, nil
}

// normalizePriority maps whatever the model said onto Berry's values.
//
// An unrecognised priority becomes none rather than a guess: a proposal
// arriving as "critical" is more likely a vocabulary mismatch than a judgement
// worth preserving, and none is the value a person will notice and set.
func normalizePriority(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "urgent", "critical", "p0":
		return "urgent"
	case "high", "p1":
		return "high"
	case "medium", "normal", "p2":
		return "medium"
	case "low", "p3", "minor":
		return "low"
	default:
		return "none"
	}
}

func betweenFences(text string) string {
	start := strings.Index(text, "```")
	if start < 0 {
		return ""
	}
	rest := text[start+3:]
	if newline := strings.IndexByte(rest, '\n'); newline >= 0 {
		rest = rest[newline+1:]
	}
	if end := strings.Index(rest, "```"); end >= 0 {
		return strings.TrimSpace(rest[:end])
	}
	return ""
}

func collapse(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func truncate(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	trimmed := value[:maxBytes]
	for len(trimmed) > 0 && !utf8.ValidString(trimmed) {
		trimmed = trimmed[:len(trimmed)-1]
	}
	return trimmed
}

// Generate asks the agent and returns what it proposed.
type Runtime interface {
	Ask(ctx context.Context, prompt string) (string, error)
}

// Generate runs one turn and parses the answer.
func Generate(ctx context.Context, runtime Runtime, brief Brief) ([]Proposal, error) {
	if runtime == nil {
		return nil, errors.New("planning: no runtime configured")
	}
	reply, err := runtime.Ask(ctx, Prompt(brief))
	if err != nil {
		return nil, err
	}
	return Parse(reply)
}
