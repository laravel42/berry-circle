package priorwork

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type stubSource struct {
	artifacts []Artifact
	err       error
	askedFor  int
}

func (source *stubSource) DependencyArtifacts(
	_ context.Context, _ uuid.UUID, limit int,
) ([]Artifact, error) {
	source.askedFor = limit
	return source.artifacts, source.err
}

type stubReader struct {
	bodies map[string]string
	opened []string
}

func (reader *stubReader) Open(_ context.Context, key string) (io.ReadCloser, error) {
	reader.opened = append(reader.opened, key)
	body, ok := reader.bodies[key]
	if !ok {
		return nil, errors.New("no such object")
	}
	return io.NopCloser(strings.NewReader(body)), nil
}

func build(source Source, reader Reader, budget Budget) string {
	return Builder{Source: source, Reader: reader, Budget: budget}.Build(
		context.Background(), uuid.New())
}

func TestTheHandoffCarriesWhatTheBlockingTaskWrote(t *testing.T) {
	t.Parallel()
	source := &stubSource{artifacts: []Artifact{{
		IssueIdentifier: "PLATFORM-12", IssueTitle: "Design the schema", AgentName: "architect",
		FileName: "schema.md", ContentType: "text/plain", SizeBytes: 20, StorageKey: "k1",
	}}}
	reader := &stubReader{bodies: map[string]string{"k1": "users table is uuid-keyed"}}

	out := build(source, reader, DefaultBudget)
	if !strings.Contains(out, "users table is uuid-keyed") {
		t.Fatalf("handoff omitted the file contents:\n%s", out)
	}
	for _, want := range []string{"schema.md", "PLATFORM-12", "architect"} {
		if !strings.Contains(out, want) {
			t.Errorf("handoff does not attribute %q:\n%s", want, out)
		}
	}
}

// An agent with nothing before it must not be told about an empty handoff:
// a section header with no files reads as "your dependencies produced
// nothing", which is a different claim from "you have no dependencies".
func TestNothingToHandOverRendersNothing(t *testing.T) {
	t.Parallel()
	if out := build(&stubSource{}, &stubReader{}, DefaultBudget); out != "" {
		t.Errorf("empty handoff rendered %q", out)
	}
}

// A binary is skipped before it is fetched: the model cannot read it, and
// paying storage for bytes that will be discarded is waste.
func TestBinaryArtifactsAreNeverFetched(t *testing.T) {
	t.Parallel()
	source := &stubSource{artifacts: []Artifact{
		{IssueIdentifier: "P-1", FileName: "diagram.png", ContentType: "application/octet-stream",
			SizeBytes: 900, StorageKey: "binary"},
		{IssueIdentifier: "P-1", FileName: "notes.md", ContentType: "text/plain",
			SizeBytes: 5, StorageKey: "text"},
	}}
	reader := &stubReader{bodies: map[string]string{"binary": "\x89PNG", "text": "hello"}}

	out := build(source, reader, DefaultBudget)
	for _, key := range reader.opened {
		if key == "binary" {
			t.Error("a binary artifact was fetched from storage")
		}
	}
	if !strings.Contains(out, "hello") {
		t.Errorf("the readable file was dropped along with the binary:\n%s", out)
	}
}

// A file whose content type lied still must not reach the prompt.
func TestBytesThatAreNotTextAreDroppedAfterReading(t *testing.T) {
	t.Parallel()
	source := &stubSource{artifacts: []Artifact{{
		IssueIdentifier: "P-2", FileName: "notes.txt", ContentType: "text/plain",
		SizeBytes: 4, StorageKey: "k",
	}}}
	reader := &stubReader{bodies: map[string]string{"k": "a\x00b"}}
	if out := build(source, reader, DefaultBudget); out != "" {
		t.Errorf("NUL-bearing content reached the prompt:\n%s", out)
	}
}

// The prompt is 64 KiB total and already carries the issue and the
// repository. A dependency that wrote a large file must be cut, not allowed
// to crowd everything else out.
func TestALargeFileIsCutAndSaysWhereTheRestIs(t *testing.T) {
	t.Parallel()
	source := &stubSource{artifacts: []Artifact{{
		IssueIdentifier: "P-3", FileName: "long.md", ContentType: "text/plain",
		SizeBytes: 100_000, StorageKey: "k",
	}}}
	reader := &stubReader{bodies: map[string]string{"k": strings.Repeat("x", 100_000)}}

	out := build(source, reader, Budget{MaxFiles: 4, MaxFileBytes: 512, MaxTotal: 4096})
	if len(out) > 2000 {
		t.Errorf("cut file still rendered %d bytes", len(out))
	}
	if !strings.Contains(out, "file continues") {
		t.Errorf("a cut file did not say it was cut:\n%s", out)
	}
	if !strings.Contains(out, "P-3") {
		t.Error("a cut file must name the issue holding the rest")
	}
}

func TestTheFileCountIsBounded(t *testing.T) {
	t.Parallel()
	var many []Artifact
	bodies := map[string]string{}
	for index := 0; index < 20; index++ {
		key := string(rune('a' + index))
		many = append(many, Artifact{
			IssueIdentifier: "P-4", FileName: key + ".md", ContentType: "text/plain",
			SizeBytes: 4, StorageKey: key,
		})
		bodies[key] = "body"
	}
	source := &stubSource{artifacts: many}

	out := build(source, &stubReader{bodies: bodies}, Budget{MaxFiles: 3, MaxFileBytes: 512, MaxTotal: 4096})
	if got := strings.Count(out, "--- "); got != 3 {
		t.Errorf("rendered %d files, want 3", got)
	}
	if !strings.Contains(out, "further file") {
		t.Errorf("dropped files were not accounted for:\n%s", out)
	}
}

// A storage outage costs the run its handoff, not its dispatch.
func TestAnUnreadableStoreLeavesTheRunDispatchable(t *testing.T) {
	t.Parallel()
	source := &stubSource{artifacts: []Artifact{{
		IssueIdentifier: "P-5", FileName: "a.md", ContentType: "text/plain",
		SizeBytes: 4, StorageKey: "missing",
	}}}
	if out := build(source, &stubReader{bodies: map[string]string{}}, DefaultBudget); out != "" {
		t.Errorf("want an empty handoff, got %q", out)
	}
}

func TestAFailingSourceIsSilent(t *testing.T) {
	t.Parallel()
	source := &stubSource{err: errors.New("database is down")}
	if out := build(source, &stubReader{}, DefaultBudget); out != "" {
		t.Errorf("want an empty handoff, got %q", out)
	}
}
