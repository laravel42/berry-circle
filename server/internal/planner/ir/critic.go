package ir

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/laravel42/berry-circle/server/internal/automation"
)

// Codes for a critic reply that is not a verdict.
const (
	CodeCriticJSONInvalid   = "CRITIC_JSON_INVALID"
	CodeCriticSchemaInvalid = "CRITIC_SCHEMA_INVALID"
	CodeCriticFieldInvalid  = "CRITIC_FIELD_INVALID"
)

// Critic verdicts.
const (
	VerdictAccept = "accept"
	VerdictRevise = "revise"
)

// MaxCriticProblems bounds a verdict.
const MaxCriticProblems = 50

var problemCodePattern = regexp.MustCompile(`^[A-Z_]{3,60}$`)

// CriticVerdict is the critic's review of a valid plan.
type CriticVerdict struct {
	Verdict  string          `json:"verdict"`
	Problems []CriticProblem `json:"problems,omitempty"`
}

// CriticProblem is one thing the critic wants changed. Severity error asks
// for a revision; a warning is surfaced to the person as is.
type CriticProblem struct {
	Code     string `json:"code"`
	Path     string `json:"path"`
	Message  string `json:"message"`
	Severity string `json:"severity"`
}

// CheckCritic applies the verdict schema.
func CheckCritic(verdict CriticVerdict) []Finding {
	var findings []Finding
	switch verdict.Verdict {
	case VerdictAccept, VerdictRevise:
	default:
		findings = append(findings, finding("/verdict", CodeCriticFieldInvalid, "verdict is accept or revise."))
	}
	if len(verdict.Problems) > MaxCriticProblems {
		findings = append(findings, finding("/problems", CodeCriticFieldInvalid,
			fmt.Sprintf("problems lists at most %d entries.", MaxCriticProblems)))
	}
	for index, problem := range verdict.Problems {
		path := "/problems/" + strconv.Itoa(index)
		if !problemCodePattern.MatchString(problem.Code) {
			findings = append(findings, finding(path+"/code", CodeCriticFieldInvalid, "Problem codes are SCREAMING_SNAKE_CASE."))
		}
		if strings.TrimSpace(problem.Message) == "" {
			findings = append(findings, finding(path+"/message", CodeCriticFieldInvalid, "A problem carries a message."))
		}
		switch problem.Severity {
		case string(automation.SeverityError), string(automation.SeverityWarning):
		default:
			findings = append(findings, finding(path+"/severity", CodeCriticFieldInvalid, "severity is error or warning."))
		}
	}
	return findings
}

// ParseCriticReply decodes a critic reply strictly.
func ParseCriticReply(reply string) (CriticVerdict, []Finding) {
	raw, ok := extractAnswer(reply)
	if !ok {
		return CriticVerdict{}, []Finding{finding("", CodeCriticJSONInvalid, "The reply does not contain a JSON object.")}
	}
	var verdict CriticVerdict
	if err := decodeStrict(raw, &verdict); err != nil {
		return CriticVerdict{}, []Finding{finding("", CodeCriticSchemaInvalid, DescribeDecodeError(err))}
	}
	return verdict, CheckCritic(verdict)
}

// Findings converts the critic's problems into validator-shaped findings so
// a revision round can hand them to the repair role like any other error.
func (verdict CriticVerdict) Findings() []Finding {
	out := make([]Finding, 0, len(verdict.Problems))
	for _, problem := range verdict.Problems {
		severity := automation.Severity(problem.Severity)
		if severity != automation.SeverityWarning {
			severity = automation.SeverityError
		}
		out = append(out, Finding{Path: problem.Path, Code: problem.Code, Message: problem.Message, Severity: severity})
	}
	return out
}
