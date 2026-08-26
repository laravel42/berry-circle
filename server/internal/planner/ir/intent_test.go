package ir

import (
	"testing"
)

const validIntent = `{"goal":"Launch a donation site","requirements":[
 {"id":"r1","description":"Build the landing page","nature":"finite_work","entities":["Landing Page","stripe"],"explicitConstraints":[]},
 {"id":"r2","description":"Store donors after payment","nature":"event_driven","entities":["stripe","google_sheets"],"explicitConstraints":["after successful donations"]},
 {"id":"r3","description":"Ask before deploying","nature":"approval","entities":["deployment"],"explicitConstraints":[]}],
 "ambiguities":[{"id":"q1","description":"Assume the existing Vercel project","blocking":false,"question":"Where should the site deploy?"}],"language":"en"}`

func TestParseIntentReplyAcceptsTheGoldenAnalysisAndDerivesEntities(t *testing.T) {
	analysis, findings := ParseIntentReply("```json\n" + validIntent + "\n```")
	if !Valid(findings) {
		t.Fatalf("findings = %+v", findings)
	}
	if len(analysis.Requirements) != 3 || len(analysis.Blocking()) != 0 || analysis.AllUnknown() {
		t.Fatalf("analysis = %+v", analysis)
	}
	entities := analysis.Entities()
	want := []string{"deployment", "google_sheets", "landing page", "stripe"}
	if len(entities) != len(want) {
		t.Fatalf("Entities() = %v, want %v", entities, want)
	}
	for index := range want {
		if entities[index] != want[index] {
			t.Fatalf("Entities() = %v, want %v", entities, want)
		}
	}
}

func TestCheckIntentNamesEveryRule(t *testing.T) {
	cases := map[string]struct {
		reply string
		code  string
		path  string
	}{
		"no json":            {reply: "no", code: CodeIntentJSONInvalid},
		"unknown field":      {reply: `{"goal":"g","requirements":[],"plan":{}}`, code: CodeIntentSchemaInvalid},
		"empty goal":         {reply: `{"goal":"","requirements":[{"id":"r1","description":"d","nature":"unknown"}]}`, code: CodeIntentFieldInvalid, path: "/goal"},
		"no requirements":    {reply: `{"goal":"g","requirements":[]}`, code: CodeIntentFieldInvalid, path: "/requirements"},
		"bad requirement id": {reply: `{"goal":"g","requirements":[{"id":"req-1","description":"d","nature":"unknown"}]}`, code: CodeIntentFieldInvalid, path: "/requirements/0/id"},
		"duplicate id":       {reply: `{"goal":"g","requirements":[{"id":"r1","description":"d","nature":"unknown"},{"id":"r1","description":"d","nature":"unknown"}]}`, code: CodeIntentFieldInvalid, path: "/requirements/1/id"},
		"bad nature":         {reply: `{"goal":"g","requirements":[{"id":"r1","description":"d","nature":"chore"}]}`, code: CodeIntentFieldInvalid, path: "/requirements/0/nature"},
		"empty description":  {reply: `{"goal":"g","requirements":[{"id":"r1","description":" ","nature":"unknown"}]}`, code: CodeIntentFieldInvalid, path: "/requirements/0/description"},
		"bad ambiguity id":   {reply: `{"goal":"g","requirements":[{"id":"r1","description":"d","nature":"unknown"}],"ambiguities":[{"id":"amb","description":"d","blocking":true,"question":"q"}]}`, code: CodeIntentFieldInvalid, path: "/ambiguities/0/id"},
		"no question":        {reply: `{"goal":"g","requirements":[{"id":"r1","description":"d","nature":"unknown"}],"ambiguities":[{"id":"q1","description":"","blocking":true,"question":""}]}`, code: CodeIntentFieldInvalid, path: "/ambiguities/0/question"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, findings := ParseIntentReply(tc.reply)
			found := false
			for _, item := range findings {
				if item.Code == tc.code && (tc.path == "" || item.Path == tc.path) {
					found = true
				}
			}
			if !found {
				t.Fatalf("findings = %+v, want %s at %q", findings, tc.code, tc.path)
			}
		})
	}
	analysis, findings := ParseIntentReply(`{"goal":"g","requirements":[{"id":"r1","description":"d","nature":"unknown"}],"ambiguities":[{"id":"q1","description":"d","blocking":true,"question":"Which vendor?"}]}`)
	if !Valid(findings) || len(analysis.Blocking()) != 1 || !analysis.AllUnknown() {
		t.Fatalf("blocking analysis = %+v %+v", analysis, findings)
	}
}
