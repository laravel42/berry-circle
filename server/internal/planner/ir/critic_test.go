package ir

import "testing"

func TestParseCriticReplyAcceptsVerdictsAndRefusesShape(t *testing.T) {
	verdict, findings := ParseCriticReply(`Verdict:\n{"verdict":"revise","problems":[{"code":"MISSING_APPROVAL","path":"/issues/3","message":"Deploy needs an approval.","severity":"error"},{"code":"NIT","path":"/goal/title","message":"Shorter title.","severity":"warning"}]}`)
	if !Valid(findings) || verdict.Verdict != VerdictRevise || len(verdict.Problems) != 2 {
		t.Fatalf("verdict = %+v findings = %+v", verdict, findings)
	}
	converted := verdict.Findings()
	if len(converted) != 2 || converted[0].Severity != "error" || converted[1].Severity != "warning" || converted[0].Path != "/issues/3" {
		t.Fatalf("Findings() = %+v", converted)
	}
	if accepted, findings := ParseCriticReply(`{"verdict":"accept","problems":[]}`); !Valid(findings) || accepted.Verdict != VerdictAccept {
		t.Fatalf("accept = %+v %+v", accepted, findings)
	}
	cases := map[string]struct {
		reply string
		code  string
	}{
		"no json":       {reply: "fine", code: CodeCriticJSONInvalid},
		"unknown field": {reply: `{"verdict":"accept","score":1}`, code: CodeCriticSchemaInvalid},
		"bad verdict":   {reply: `{"verdict":"maybe"}`, code: CodeCriticFieldInvalid},
		"bad code":      {reply: `{"verdict":"revise","problems":[{"code":"bad code","path":"","message":"m","severity":"error"}]}`, code: CodeCriticFieldInvalid},
		"bad severity":  {reply: `{"verdict":"revise","problems":[{"code":"CODE","path":"","message":"m","severity":"fatal"}]}`, code: CodeCriticFieldInvalid},
		"no message":    {reply: `{"verdict":"revise","problems":[{"code":"CODE","path":"","message":"","severity":"error"}]}`, code: CodeCriticFieldInvalid},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, findings := ParseCriticReply(tc.reply)
			if !contains(Codes(findings), tc.code) {
				t.Fatalf("findings = %+v, want %s", findings, tc.code)
			}
		})
	}
}
