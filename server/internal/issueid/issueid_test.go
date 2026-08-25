package issueid

import "testing"

func TestPrefixFromName(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		slug string
		want string
	}{
		{name: "Berry", slug: "berry", want: "BER"},
		{name: "Platform", slug: "platform", want: "PLA"},
		{name: "Acme Corp", slug: "acme-corp", want: "ACM"},
		{name: "ab", slug: "ab", want: "AB"},
		{name: "a", slug: "alpha", want: "ALP"},
		{name: "!!!", slug: "ops", want: "OPS"},
		{name: "42 Labs", slug: "ops-lab", want: "OPS"},
		{name: "!!!", slug: "x", want: "WS"},
	}
	for _, test := range cases {
		got := PrefixFromName(test.name, test.slug)
		if got != test.want {
			t.Errorf(
				"PrefixFromName(%q, %q) = %q, want %q",
				test.name,
				test.slug,
				got,
				test.want,
			)
		}
	}
}

func TestFormatAndParse(t *testing.T) {
	t.Parallel()

	identifier := Format("ber", 5)
	if identifier != "BER-5" {
		t.Fatalf("Format = %q, want BER-5", identifier)
	}
	prefix, number, ok := Parse(identifier)
	if !ok || prefix != "BER" || number != 5 {
		t.Fatalf("Parse(%q) = %q, %d, %v", identifier, prefix, number, ok)
	}
	if _, _, ok := Parse("BER"); ok {
		t.Fatal("Parse(BER) unexpectedly succeeded")
	}
	if _, _, ok := Parse("BER-0"); ok {
		t.Fatal("Parse(BER-0) unexpectedly succeeded")
	}
}
