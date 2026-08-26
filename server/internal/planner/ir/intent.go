package ir

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Codes for a classifier reply that is not an intent analysis.
const (
	CodeIntentJSONInvalid   = "INTENT_JSON_INVALID"
	CodeIntentSchemaInvalid = "INTENT_SCHEMA_INVALID"
	CodeIntentFieldInvalid  = "INTENT_FIELD_INVALID"
)

// Requirement natures (spec §6).
const (
	NatureFiniteWork  = "finite_work"
	NatureEventDriven = "event_driven"
	NatureScheduled   = "scheduled"
	NatureApproval    = "approval"
	NatureUnknown     = "unknown"
)

// MaxRequirements bounds one analysis.
const MaxRequirements = 50

var (
	requirementIDPattern = regexp.MustCompile(`^r[0-9]{1,3}$`)
	ambiguityIDPattern   = regexp.MustCompile(`^q[0-9]{1,3}$`)
)

// IntentAnalysis is the classifier's reading of the prompt: what the person
// wants, which requirements are finite work and which are automation, and
// what is unclear.
type IntentAnalysis struct {
	Goal         string        `json:"goal"`
	Requirements []Requirement `json:"requirements"`
	Ambiguities  []Ambiguity   `json:"ambiguities,omitempty"`
	Language     string        `json:"language,omitempty"`
}

// Requirement is one thing the prompt asks for.
type Requirement struct {
	ID                  string   `json:"id"`
	Description         string   `json:"description"`
	Nature              string   `json:"nature"`
	Entities            []string `json:"entities,omitempty"`
	ExplicitConstraints []string `json:"explicitConstraints,omitempty"`
}

// Ambiguity is something the classifier could not settle. Blocking ones stop
// the plan until answered; the rest become assumptions.
type Ambiguity struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Blocking    bool   `json:"blocking"`
	Question    string `json:"question"`
}

// CheckIntent applies the schema rules an analysis must satisfy.
func CheckIntent(analysis IntentAnalysis) []Finding {
	var findings []Finding
	if length := len(strings.TrimSpace(analysis.Goal)); length < 1 || length > 500 {
		findings = append(findings, finding("/goal", CodeIntentFieldInvalid, "goal is 1 to 500 characters."))
	}
	if len(analysis.Requirements) < 1 || len(analysis.Requirements) > MaxRequirements {
		findings = append(findings, finding("/requirements", CodeIntentFieldInvalid,
			fmt.Sprintf("requirements lists 1 to %d entries.", MaxRequirements)))
	}
	seen := map[string]bool{}
	for index, requirement := range analysis.Requirements {
		path := "/requirements/" + strconv.Itoa(index)
		switch {
		case !requirementIDPattern.MatchString(requirement.ID):
			findings = append(findings, finding(path+"/id", CodeIntentFieldInvalid, "Requirement ids look like r1."))
		case seen[requirement.ID]:
			findings = append(findings, finding(path+"/id", CodeIntentFieldInvalid, fmt.Sprintf("Requirement id %q is used twice.", requirement.ID)))
		default:
			seen[requirement.ID] = true
		}
		if strings.TrimSpace(requirement.Description) == "" {
			findings = append(findings, finding(path+"/description", CodeIntentFieldInvalid, "A requirement needs a description."))
		}
		switch requirement.Nature {
		case NatureFiniteWork, NatureEventDriven, NatureScheduled, NatureApproval, NatureUnknown:
		default:
			findings = append(findings, finding(path+"/nature", CodeIntentFieldInvalid,
				"nature is finite_work, event_driven, scheduled, approval or unknown."))
		}
	}
	for index, ambiguity := range analysis.Ambiguities {
		path := "/ambiguities/" + strconv.Itoa(index)
		switch {
		case !ambiguityIDPattern.MatchString(ambiguity.ID):
			findings = append(findings, finding(path+"/id", CodeIntentFieldInvalid, "Ambiguity ids look like q1."))
		case seen[ambiguity.ID]:
			findings = append(findings, finding(path+"/id", CodeIntentFieldInvalid, fmt.Sprintf("Ambiguity id %q is used twice.", ambiguity.ID)))
		default:
			seen[ambiguity.ID] = true
		}
		if strings.TrimSpace(ambiguity.Question) == "" && strings.TrimSpace(ambiguity.Description) == "" {
			findings = append(findings, finding(path+"/question", CodeIntentFieldInvalid, "An ambiguity asks a question."))
		}
	}
	return findings
}

// ParseIntentReply decodes a classifier reply strictly.
func ParseIntentReply(reply string) (IntentAnalysis, []Finding) {
	raw, ok := extractAnswer(reply)
	if !ok {
		return IntentAnalysis{}, []Finding{finding("", CodeIntentJSONInvalid, "The reply does not contain a JSON object.")}
	}
	var analysis IntentAnalysis
	if err := decodeStrict(raw, &analysis); err != nil {
		return IntentAnalysis{}, []Finding{finding("", CodeIntentSchemaInvalid, DescribeDecodeError(err))}
	}
	return analysis, CheckIntent(analysis)
}

// Blocking returns the ambiguities that must be answered before planning.
func (analysis IntentAnalysis) Blocking() []Ambiguity {
	var out []Ambiguity
	for _, ambiguity := range analysis.Ambiguities {
		if ambiguity.Blocking {
			out = append(out, ambiguity)
		}
	}
	return out
}

// AllUnknown reports whether every requirement has nature unknown, which is
// when an empty plan is not a warning but the honest answer.
func (analysis IntentAnalysis) AllUnknown() bool {
	if len(analysis.Requirements) == 0 {
		return false
	}
	for _, requirement := range analysis.Requirements {
		if requirement.Nature != NatureUnknown {
			return false
		}
	}
	return true
}

// Entities returns the distinct entity terms across requirements, lowercased
// and sorted, which is what the context stage matches issues and tools on.
func (analysis IntentAnalysis) Entities() []string {
	seen := map[string]bool{}
	for _, requirement := range analysis.Requirements {
		for _, entity := range requirement.Entities {
			term := strings.ToLower(strings.TrimSpace(entity))
			if term == "" {
				continue
			}
			seen[term] = true
		}
	}
	out := make([]string, 0, len(seen))
	for term := range seen {
		out = append(out, term)
	}
	sort.Strings(out)
	return out
}
