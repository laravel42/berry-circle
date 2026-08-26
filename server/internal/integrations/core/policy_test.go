package core

import "testing"

// The policy is what turns "deploy to production" into a gated issue; a text
// that only mentions deploying a preview must not trip it.
func TestMatchPolicyRecognisesDestructiveWorkAndIgnoresTheRest(t *testing.T) {
	cases := []struct {
		text string
		want string
	}{
		{"Deploy the landing page to production", "deploy_production"},
		{"Merge the release branch into main", "merge_protected"},
		{"Delete the staging database", "delete_repository_or_data"},
		{"Refund the customer", "money_movement"},
		{"Send the monthly newsletter", "bulk_messaging"},
		{"Publish the blog post", "publish"},
		{"Update the DNS records", "infrastructure"},
		{"Deploy a preview environment", ""},
		{"Write unit tests for the parser", ""},
		{"", ""},
	}
	for _, testCase := range cases {
		policy, matched := MatchPolicy(testCase.text)
		if matched != (testCase.want != "") || policy.ID != testCase.want {
			t.Errorf("MatchPolicy(%q) = %q, %v; want %q", testCase.text, policy.ID, matched, testCase.want)
		}
	}
}
