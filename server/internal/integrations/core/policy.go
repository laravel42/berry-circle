package core

import (
	"regexp"
	"strings"
)

// Policy is one rule of the destructive-action policy (spec §32): work whose
// description matches the pattern needs a human decision before it starts,
// whether it is an issue an agent would pick up or a workflow step.
//
// The patterns are deliberately coarse. A false positive costs one click on
// an approval; a false negative lets an agent deploy to production without
// anyone looking, which is the thing the policy exists to prevent.
type Policy struct {
	// ID is stable and appears in validator findings and approval titles.
	ID string
	// Description is what a person reads on the approval.
	Description string
	// Pattern is matched case-insensitively against the text of an issue or
	// a step.
	Pattern *regexp.Regexp
	// Risk is the approval risk class the match carries.
	Risk string
}

var defaultPolicies = []Policy{
	{ID: "deploy_production", Description: "Deploys to production", Risk: "high",
		Pattern: regexp.MustCompile(`(?i)\bdeploy(?:s|ed|ing|ment)?\b[^.\n]{0,60}\b(?:prod|production)\b`)},
	{ID: "merge_protected", Description: "Merges into a protected branch", Risk: "high",
		Pattern: regexp.MustCompile(`(?i)\bmerg(?:e|es|ed|ing)\b[^.\n]{0,60}\b(?:main|master|protected)\b`)},
	{ID: "delete_repository_or_data", Description: "Deletes a repository, a database or production data", Risk: "high",
		Pattern: regexp.MustCompile(`(?i)\b(?:delete|drop|destroy|wipe)s?\b[^.\n]{0,40}\b(?:repository|repo|production data|database|db)\b`)},
	{ID: "money_movement", Description: "Charges, pays or refunds money", Risk: "high",
		Pattern: regexp.MustCompile(`(?i)\b(?:charge|charges|charging|payment|payments|refund|refunds|payout|payouts)\b`)},
	{ID: "bulk_messaging", Description: "Sends bulk email or a campaign", Risk: "high",
		Pattern: regexp.MustCompile(`(?i)\b(?:bulk (?:e-?mail|message)s?|campaign|newsletter|mass (?:e-?mail|message)s?)\b`)},
	{ID: "publish", Description: "Publishes something publicly", Risk: "medium",
		Pattern: regexp.MustCompile(`(?i)\bpublish(?:es|ed|ing)?\b`)},
	{ID: "infrastructure", Description: "Changes DNS or infrastructure", Risk: "high",
		Pattern: regexp.MustCompile(`(?i)\b(?:dns|infrastructure|terraform|kubernetes|k8s)\b`)},
}

// DefaultPolicies returns the built-in destructive-action policy. Callers
// receive a copy so nobody can edit the shared table.
func DefaultPolicies() []Policy {
	return append([]Policy(nil), defaultPolicies...)
}

// MatchPolicy reports the first default policy a text matches. The text is
// what a person would read — an issue title and description, a step's
// instruction — never a credential.
func MatchPolicy(text string) (Policy, bool) {
	return MatchPolicies(DefaultPolicies(), text)
}

// MatchPolicies is MatchPolicy over a caller's policy table.
func MatchPolicies(policies []Policy, text string) (Policy, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Policy{}, false
	}
	for _, policy := range policies {
		if policy.Pattern != nil && policy.Pattern.MatchString(text) {
			return policy, true
		}
	}
	return Policy{}, false
}
