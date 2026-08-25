// Package issueid formats and parses Berry's human issue identifiers.
//
// An identifier is PREFIX-N: PREFIX is the first three ASCII alphanumeric
// characters of the workspace name (falling back to the slug), and N is the
// sequential issue number on its board.
package issueid

import (
	"strconv"
	"strings"
)

// PrefixFromName returns the three-character issue prefix for a workspace.
// Letters and digits from the display name are kept, uppercased, and truncated
// to three characters. A prefix must start with a letter and be at least two
// characters; otherwise the slug is tried, then "WS".
func PrefixFromName(name, slug string) string {
	if prefix, ok := prefixFrom(name); ok {
		return prefix
	}
	if prefix, ok := prefixFrom(slug); ok {
		return prefix
	}
	return "WS"
}

func prefixFrom(value string) (string, bool) {
	var builder strings.Builder
	for _, r := range strings.ToUpper(value) {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
			continue
		}
		builder.WriteRune(r)
		if builder.Len() == 3 {
			break
		}
	}
	prefix := builder.String()
	if len(prefix) < 2 || prefix[0] < 'A' || prefix[0] > 'Z' {
		return "", false
	}
	return prefix, true
}

// Format returns the immutable public identifier PREFIX-N.
func Format(prefix string, number int32) string {
	return strings.ToUpper(strings.TrimSpace(prefix)) + "-" + strconv.FormatInt(int64(number), 10)
}

// Parse splits a PREFIX-N reference. The prefix is the substring before the
// final hyphen so a prefix may itself contain hyphens.
func Parse(reference string) (prefix string, number int32, ok bool) {
	index := strings.LastIndex(reference, "-")
	if index < 1 || index == len(reference)-1 {
		return "", 0, false
	}
	parsed, err := strconv.ParseInt(reference[index+1:], 10, 32)
	if err != nil || parsed < 1 {
		return "", 0, false
	}
	prefix = reference[:index]
	if strings.TrimSpace(prefix) != prefix || prefix == "" {
		return "", 0, false
	}
	return prefix, int32(parsed), true
}
