package runadmission

import (
	"context"
	"errors"
	"github.com/laravel42/berry-circle/server/internal/artifacts"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

func TestServiceProjectsSuccessfulStream(t *testing.T) {
	previousPropagator := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	defer otel.SetTextMapPropagator(previousPropagator)
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	store.dispatch.TraceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: "finished work"},
			{Type: openfang.EventToolUse, Tool: "tests"},
			{Type: openfang.EventToolResult, Tool: "tests"},
			{
				Type: openfang.EventDone,
				Usage: openfang.Usage{
					InputTokens:  12,
					OutputTokens: 5,
				},
			},
			{Type: openfang.EventPhase, Phase: "done"},
		}},
	}
	comments := &fakeComments{workspaceID: uuid.New()}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case success := <-store.successes:
		if success.Usage.InputTokens != 12 ||
			success.Usage.OutputTokens != 5 ||
			success.Usage.TotalTokens != 17 {
			t.Fatalf("usage = %#v", success.Usage)
		}
		if success.Summary == nil || *success.Summary != "finished work" {
			t.Fatalf("summary = %#v", success.Summary)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
	if runtime.dispatches.Load() != 1 {
		t.Fatalf("dispatches = %d, want 1", runtime.dispatches.Load())
	}
	if got := runtime.dispatchTrace(); !got.IsValid() ||
		got.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Fatalf("dispatch trace = %s", got.TraceID())
	}
	if store.outputCount.Load() != 1 ||
		store.toolStarted.Load() != 1 ||
		store.toolCompleted.Load() != 1 {
		t.Fatalf(
			"projection counts output=%d started=%d completed=%d",
			store.outputCount.Load(),
			store.toolStarted.Load(),
			store.toolCompleted.Load(),
		)
	}
	// The comment is written after success commits, so wait for the worker.
	closeService(t, service)
	if turns := store.providerEventsOfType("turn"); len(turns) != 1 ||
		turns[0].metadata["turn"] != "1" {
		t.Fatalf("turn events = %#v, want one", turns)
	}
	created := comments.snapshot()
	if len(created) != 1 || created[0].Body != "finished work" ||
		created[0].AuthorType != "agent" ||
		created[0].AuthorID != store.dispatch.AgentID ||
		created[0].IssueID != store.dispatch.IssueID {
		t.Fatalf("comments = %#v", created)
	}
}

// The regression: the pinned upstream sends done after every model turn, so
// a run must only complete when the body ends. Usage is the sum over turns,
// the result is the last turn's text, and the report reaches the issue.
func TestServiceCompletesAtStreamEndAcrossTurns(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	workspaceID := uuid.New()
	comments := &fakeComments{workspaceID: workspaceID}
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: "I'll research this systematically."},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 8701, OutputTokens: 432}},
			{Type: openfang.EventPhase, Phase: "tool_loop"},
			{Type: openfang.EventToolUse, Tool: "web_search"},
			{Type: openfang.EventToolResult, Tool: "web_search"},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 400000, OutputTokens: 6000}},
			{Type: openfang.EventPhase, Phase: "tool_loop"},
			{Type: openfang.EventChunk, Content: "Final report: "},
			{Type: openfang.EventChunk, Content: "three findings."},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 426313, OutputTokens: 7555}},
			{Type: openfang.EventPhase, Phase: "done"},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	subscription, err := hub.Subscribe(context.Background(), workspaceID.String())
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer subscription.Close()

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case success := <-store.successes:
		if success.Usage.InputTokens != 835014 ||
			success.Usage.OutputTokens != 13987 ||
			success.Usage.TotalTokens != 849001 {
			t.Fatalf("usage = %#v, want the sum over three turns", success.Usage)
		}
		if success.Summary == nil || *success.Summary != "Final report: three findings." {
			t.Fatalf("summary = %#v, want the last turn's text", success.Summary)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
	select {
	case failure := <-store.failures:
		t.Fatalf("unexpected failure %#v", failure)
	default:
	}
	closeService(t, service)

	turns := store.providerEventsOfType("turn")
	if len(turns) != 3 ||
		turns[0].metadata["turn"] != "1" ||
		turns[0].metadata["inputTokens"] != "8701" ||
		turns[0].metadata["outputTokens"] != "432" ||
		turns[2].metadata["turn"] != "3" ||
		turns[2].metadata["inputTokens"] != "426313" {
		t.Fatalf("turn events = %#v", turns)
	}
	if store.outputCount.Load() != 3 {
		t.Fatalf("output events = %d, want every chunk", store.outputCount.Load())
	}
	created := comments.snapshot()
	if len(created) != 1 ||
		created[0].AuthorType != "agent" ||
		created[0].AuthorID != store.dispatch.AgentID ||
		created[0].IssueID != store.dispatch.IssueID ||
		created[0].Body != "Final report: three findings." {
		t.Fatalf("comments = %#v", created)
	}
	select {
	case event := <-subscription.Events():
		if event.Type != "comment.created" || event.WorkspaceID != workspaceID.String() {
			t.Fatalf("realtime event = %#v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the comment.created realtime event")
	}
}

func TestServiceFallsBackToLastTurnThatSaidAnything(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	comments := &fakeComments{workspaceID: uuid.New()}
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: "Report body"},
			{Type: openfang.EventPhase, Phase: "done"},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
			// A closing turn that only called a tool: no text of its own.
			{Type: openfang.EventToolUse, Tool: "file_write"},
			{Type: openfang.EventToolResult, Tool: "file_write"},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case success := <-store.successes:
		if success.Summary == nil || *success.Summary != "Report body" {
			t.Fatalf("summary = %#v", success.Summary)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
	closeService(t, service)
	if created := comments.snapshot(); len(created) != 1 || created[0].Body != "Report body" {
		t.Fatalf("comments = %#v", created)
	}
}

// The end of the body is the only completion signal, so text that arrives
// after the last done and is then cut off by EOF is promoted as the result
// and posted: a drop mid-final-turn reads the same as a clean end. This is
// the documented trade-off, pinned so a change to it is deliberate.
func TestServiceKeepsTheSubstantiveTurnOverAClosingRemark(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	comments := &fakeComments{workspaceID: uuid.New()}
	report := strings.Repeat("Finding: a verified submission channel. ", 12)
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: "I'll look into it."},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 5, OutputTokens: 1}},
			{Type: openfang.EventChunk, Content: report},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 50, OutputTokens: 20}},
			// The sign-off after the answer must not replace the answer.
			{Type: openfang.EventChunk, Content: "I'll write that to a file now."},
			{Type: openfang.EventPhase, Phase: "done"},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case success := <-store.successes:
		if success.Summary == nil || *success.Summary != strings.TrimSpace(report) {
			t.Fatalf("summary = %#v, want the substantive turn", success.Summary)
		}
		if success.Usage.InputTokens != 55 || success.Usage.OutputTokens != 21 {
			t.Fatalf("usage = %#v, want the closed turns' usage", success.Usage)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
	closeService(t, service)
	created := comments.snapshot()
	if len(created) != 1 || created[0].Body != strings.TrimSpace(report) {
		t.Fatalf("comments = %#v", created)
	}
}

func TestServiceEndWithoutTerminalPhaseIsIncomplete(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	comments := &fakeComments{workspaceID: uuid.New()}
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: "I'll research this."},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 8858, OutputTokens: 662}},
			{Type: openfang.EventPhase, Phase: "tool_use"},
			{Type: openfang.EventToolUse, Tool: "web_search"},
			{Type: openfang.EventToolResult, Tool: "web_search"},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 114388, OutputTokens: 584}},
			{Type: openfang.EventPhase, Phase: "thinking"},
			// The body ends here: the provider refused the next call and the
			// runtime closed the stream without its terminal phase.
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case failure := <-store.failures:
		if failure.Failure.Code != "RUN_INCOMPLETE" || !failure.Reconcile || failure.Failure.Retryable {
			t.Fatalf("failure = %#v, want RUN_INCOMPLETE flagged for reconciliation", failure)
		}
	case success := <-store.successes:
		t.Fatalf("unexpected success %#v", success)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the failure")
	}
	closeService(t, service)
	usage := store.providerEventsOfType("usage")
	if len(usage) != 1 || usage[0].metadata["inputTokens"] != "123246" ||
		usage[0].metadata["outputTokens"] != "1246" || usage[0].metadata["turns"] != "2" {
		t.Fatalf("usage events = %#v, want the summed tokens kept", usage)
	}
	if created := comments.snapshot(); len(created) != 0 {
		t.Fatalf("comments = %#v, want none for an incomplete run", created)
	}
}

func TestServiceCapturesFileWritesUnderOutputAsArtifacts(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	comments := &fakeComments{workspaceID: uuid.New()}
	sink := &fakeArtifacts{}
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventToolUse, Tool: "file_write"},
			{Type: openfang.EventToolResult, Tool: "file_write",
				Input: []byte(`{"path":"output/report.md","content":"# Report\n\nfourteen channels"}`)},
			{Type: openfang.EventToolUse, Tool: "file_write"},
			{Type: openfang.EventToolResult, Tool: "file_write",
				Input: []byte(`{"path":"notes/scratch.txt","content":"not a deliverable"}`)},
			{Type: openfang.EventToolUse, Tool: "file_write"},
			{Type: openfang.EventToolResult, Tool: "file_write", InputDropped: true},
			{Type: openfang.EventToolUse, Tool: "file_write"},
			{Type: openfang.EventToolResult, Tool: "file_write",
				Input: []byte(`{"path":"output/../secrets.txt","content":"x"}`)},
			{Type: openfang.EventChunk, Content: "Done."},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 10, OutputTokens: 2}},
			{Type: openfang.EventPhase, Phase: "done"},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	service.SetArtifacts(sink)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case <-store.successes:
	case failure := <-store.failures:
		t.Fatalf("unexpected failure %#v", failure)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
	closeService(t, service)
	files := sink.snapshot()
	if len(files) != 1 || files[0].name != "report.md" ||
		string(files[0].content) != "# Report\n\nfourteen channels" ||
		files[0].run != store.dispatch.RunID {
		t.Fatalf("captured files = %#v, want only the file under output/", files)
	}
}

func TestServiceArtifactFailureDoesNotFailRun(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	comments := &fakeComments{workspaceID: uuid.New()}
	sink := &fakeArtifacts{err: errors.New("storage is down")}
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventToolUse, Tool: "file_write"},
			{Type: openfang.EventToolResult, Tool: "file_write",
				Input: []byte(`{"path":"output/a.txt","content":"a"}`)},
			{Type: openfang.EventChunk, Content: "Done."},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
			{Type: openfang.EventPhase, Phase: "done"},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	service.SetArtifacts(sink)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case <-store.successes:
	case failure := <-store.failures:
		t.Fatalf("run failed on an artifact error: %#v", failure)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
}

func TestServiceMapsEOFWithoutAnyDoneToInterrupted(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	comments := &fakeComments{workspaceID: uuid.New()}
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: "partial"},
			{Type: openfang.EventToolUse, Tool: "shell"},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case failure := <-store.failures:
		if failure.Failure.Code != "STREAM_INTERRUPTED" || !failure.Reconcile {
			t.Fatalf("failure = %#v", failure)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for interrupted failure")
	}
	closeService(t, service)
	select {
	case success := <-store.successes:
		t.Fatalf("unexpected success %#v", success)
	default:
	}
	if created := comments.snapshot(); len(created) != 0 {
		t.Fatalf("comments = %#v, want none", created)
	}
}

func TestServiceCommentFailureDoesNotFailRun(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	comments := &fakeComments{err: errors.New("comments unavailable")}
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: "done work"},
			{Type: openfang.EventPhase, Phase: "done"},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case success := <-store.successes:
		if success.Summary == nil || *success.Summary != "done work" {
			t.Fatalf("summary = %#v", success.Summary)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
	closeService(t, service)
	if created := comments.snapshot(); len(created) != 1 {
		t.Fatalf("comment attempts = %d, want 1", len(created))
	}
	select {
	case failure := <-store.failures:
		t.Fatalf("comment failure reached the run: %#v", failure)
	default:
	}
}

// Cancel sets cancel_requested, stops the agent, and only then marks the run
// cancelled. The stop ends the body cleanly, so the stream reaches its clean
// end first; the ledger refuses the success and the run must be left to
// Cancel: no failure recorded, no partial report posted.
func TestServiceLeavesRunToCancelWhenCancellationIsInProgress(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	store.completeErr = runs.ErrRunCancelling
	comments := &fakeComments{workspaceID: uuid.New()}
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: "partial report"},
			{Type: openfang.EventPhase, Phase: "done"},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case <-store.successes:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the success attempt")
	}
	closeService(t, service)
	select {
	case failure := <-store.failures:
		t.Fatalf("cancellation in progress was recorded as a failure: %#v", failure)
	default:
	}
	if created := comments.snapshot(); len(created) != 0 {
		t.Fatalf("comments = %#v, want none while cancelling", created)
	}
}

func TestServiceSkipsCommentWhenRunSaidNothing(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	comments := &fakeComments{workspaceID: uuid.New()}
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventToolUse, Tool: "file_write"},
			{Type: openfang.EventToolResult, Tool: "file_write"},
			{Type: openfang.EventPhase, Phase: "done"},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case success := <-store.successes:
		if success.Summary != nil {
			t.Fatalf("summary = %q, want none", *success.Summary)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
	closeService(t, service)
	if created := comments.snapshot(); len(created) != 0 {
		t.Fatalf("comments = %#v, want none", created)
	}
}

func TestServiceBoundsSummaryButPostsWholeResult(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	comments := &fakeComments{workspaceID: uuid.New()}
	// Two bytes per rune, so a naive byte cut would split a character.
	text := strings.Repeat("é", 4000)
	runtime := &fakeRuntime{
		stream: &fakeStream{events: []openfang.StreamEvent{
			{Type: openfang.EventChunk, Content: text},
			{Type: openfang.EventPhase, Phase: "done"},
			{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 1, OutputTokens: 1}},
		}},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, comments)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case success := <-store.successes:
		if success.Summary == nil || len(*success.Summary) > maxSummaryBytes ||
			!utf8.ValidString(*success.Summary) ||
			!strings.HasPrefix(text, *success.Summary) {
			t.Fatalf("summary is not a bounded prefix of the result")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for success")
	}
	closeService(t, service)
	if created := comments.snapshot(); len(created) != 1 || created[0].Body != text {
		t.Fatal("comment body is not the whole result")
	}
}

func TestCommentBodyTruncatesOnRuneBoundaryWithNote(t *testing.T) {
	t.Parallel()
	text := boundedText{max: commentBodyBytes}
	text.Append(strings.Repeat("é", commentBodyBytes))
	value, cut := text.Text()
	if !cut || len(value) > commentBodyBytes || !utf8.ValidString(value) {
		t.Fatalf("bounded text len=%d cut=%v valid=%v", len(value), cut, utf8.ValidString(value))
	}
	body := commentBody(value, cut)
	if len(body) > commentBodyBytes || !utf8.ValidString(body) ||
		!strings.HasSuffix(body, truncationNote) {
		t.Fatalf("comment body len=%d valid=%v", len(body), utf8.ValidString(body))
	}
	if commentBody("fine", false) != "fine" {
		t.Fatal("an uncut result must pass through untouched")
	}
}

func TestBuildMessageTellsTheAgentHowToReport(t *testing.T) {
	t.Parallel()
	dispatch := runs.Dispatch{IssueIdentifier: "BERRY-1", IssueTitle: "Research"}
	message := buildMessage(dispatch)
	if !strings.Contains(message, "Reporting your result") ||
		!strings.Contains(message, "output/") ||
		strings.Contains(message, "Delivering your work") {
		t.Fatalf("message without repository = %q", message)
	}
	dispatch.Repository = "acme/app"
	message = buildMessage(dispatch)
	reporting := strings.Index(message, "Reporting your result")
	delivering := strings.Index(message, "Delivering your work")
	if reporting < 0 || delivering < 0 || reporting > delivering {
		t.Fatalf("message with repository = %q", message)
	}
}

// The cap cuts from the tail, and the contracts are the tail: a description
// near its 100,000-character limit must lose its own end, not the contracts.
func TestBuildMessageKeepsContractsUnderLongDescription(t *testing.T) {
	t.Parallel()
	description := strings.Repeat("x", 100000)
	dispatch := runs.Dispatch{
		IssueIdentifier:  "BERRY-1",
		IssueTitle:       "Long one",
		IssueDescription: &description,
		Repository:       "acme/app",
	}
	message := buildMessage(dispatch)
	if len(message) > maxPromptBytes {
		t.Fatalf("message length = %d, over %d", len(message), maxPromptBytes)
	}
	if !strings.HasSuffix(message, deliveryContract("acme/app")) ||
		!strings.Contains(message, "Reporting your result") {
		t.Fatalf("message tail = %q", message[len(message)-400:])
	}
	if !strings.Contains(message, "Description:\nxxxx") {
		t.Fatalf("description missing from message head = %q", message[:120])
	}
}

func TestServiceMapsEOFBeforeDoneToInterruptedWithoutRedispatch(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	runtime := &fakeRuntime{
		stream: &fakeStream{
			events: []openfang.StreamEvent{{
				Type:    openfang.EventChunk,
				Content: "partial",
			}},
			finalErr: &openfang.StreamError{Kind: openfang.StreamInterrupted},
		},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, nil)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	if err := service.Queue(store.dispatch.RunID); err != nil {
		t.Fatalf("Queue() error = %v", err)
	}
	select {
	case failure := <-store.failures:
		if failure.Failure.Code != "STREAM_INTERRUPTED" || !failure.Reconcile {
			t.Fatalf("failure = %#v", failure)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for interrupted failure")
	}
	if runtime.dispatches.Load() != 1 {
		t.Fatalf("dispatches = %d, want 1", runtime.dispatches.Load())
	}
}

func TestServiceCancellationCallsStopOnce(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := newServiceStore()
	store.cancelClaim = runs.CancellationClaim{
		Run: runs.Run{
			ID:              store.dispatch.RunID,
			BoardID:         store.dispatch.BoardID,
			IssueID:         store.dispatch.IssueID,
			Status:          runs.StatusRunning,
			DispatchState:   runs.DispatchStreaming,
			UpstreamAgentID: store.dispatch.UpstreamAgentID,
		},
		UpstreamAgentID: store.dispatch.UpstreamAgentID,
		ShouldStop:      true,
	}
	runtime := &fakeRuntime{
		stopResponse: openfang.StopResponse{
			Status:    "ok",
			Message:   "Run cancelled",
			RequestID: "upstream-stop",
		},
	}
	service, cancel, hub := newTestService(t, store, runtime, now, nil)
	defer cancel()
	defer hub.Close()
	defer closeService(t, service)

	userID := uuid.New()
	first, err := service.Cancel(context.Background(), store.dispatch.RunID, userID)
	if err != nil {
		t.Fatalf("first Cancel() error = %v", err)
	}
	if first.Status != runs.StatusCancelled {
		t.Fatalf("first status = %s", first.Status)
	}
	second, err := service.Cancel(context.Background(), store.dispatch.RunID, userID)
	if err != nil {
		t.Fatalf("second Cancel() error = %v", err)
	}
	if second.Status != runs.StatusCancelled {
		t.Fatalf("second status = %s", second.Status)
	}
	if runtime.stops.Load() != 1 {
		t.Fatalf("stop calls = %d, want 1", runtime.stops.Load())
	}
}

func newTestService(
	t *testing.T,
	store *serviceStore,
	runtime *fakeRuntime,
	now time.Time,
	comments CommentStore,
) (*Service, context.CancelFunc, *realtime.Hub) {
	t.Helper()
	hub, err := realtime.NewHub(8)
	if err != nil {
		t.Fatalf("NewHub() error = %v", err)
	}
	workerContext, cancel := context.WithCancel(context.Background())
	service, err := New(Options{
		Store:         store,
		OpenFang:      runtime,
		Broadcaster:   hub,
		Clock:         func() time.Time { return now },
		NewID:         uuid.New,
		WorkerContext: workerContext,
		Workers:       1,
		QueueSize:     4,
		Comments:      comments,
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		cancel()
		_ = hub.Close()
		t.Fatalf("New() error = %v", err)
	}
	return service, cancel, hub
}

func closeService(t *testing.T, service *Service) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := service.Close(ctx); err != nil {
		t.Errorf("Close() error = %v", err)
	}
}

type fakeRuntime struct {
	stream       openfang.EventStream
	dispatchErr  error
	stopResponse openfang.StopResponse
	stopErr      error
	dispatches   atomic.Int32
	stops        atomic.Int32
	traceMu      sync.Mutex
	traceContext trace.SpanContext
}

func (runtime *fakeRuntime) ListAgents(context.Context) ([]openfang.AgentSummary, error) {
	return nil, nil
}

func (runtime *fakeRuntime) GetAgent(
	context.Context,
	uuid.UUID,
) (openfang.AgentDetail, error) {
	return openfang.AgentDetail{}, nil
}

func (runtime *fakeRuntime) DispatchMessage(
	ctx context.Context,
	_ uuid.UUID,
	_ openfang.MessageRequest,
) (openfang.EventStream, error) {
	runtime.dispatches.Add(1)
	runtime.traceMu.Lock()
	runtime.traceContext = trace.SpanContextFromContext(ctx)
	runtime.traceMu.Unlock()
	return runtime.stream, runtime.dispatchErr
}

func (runtime *fakeRuntime) dispatchTrace() trace.SpanContext {
	runtime.traceMu.Lock()
	defer runtime.traceMu.Unlock()
	return runtime.traceContext
}

func (runtime *fakeRuntime) StopAgent(
	context.Context,
	uuid.UUID,
) (openfang.StopResponse, error) {
	runtime.stops.Add(1)
	return runtime.stopResponse, runtime.stopErr
}

type fakeStream struct {
	mu       sync.Mutex
	events   []openfang.StreamEvent
	index    int
	finalErr error
}

func (stream *fakeStream) Next() (openfang.StreamEvent, error) {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.index < len(stream.events) {
		event := stream.events[stream.index]
		stream.index++
		return event, nil
	}
	if stream.finalErr != nil {
		return openfang.StreamEvent{}, stream.finalErr
	}
	return openfang.StreamEvent{}, io.EOF
}

func (*fakeStream) RequestID() string { return "upstream-dispatch" }
func (*fakeStream) Close() error      { return nil }

// fakeComments records what a run tried to post and can refuse it.
type fakeComments struct {
	mu          sync.Mutex
	workspaceID uuid.UUID
	err         error
	created     []core.CreateCommentParams
}

func (comments *fakeComments) CreateComment(
	_ context.Context,
	params core.CreateCommentParams,
	eventID uuid.UUID,
) (core.Comment, core.CommentMutationEvent, error) {
	comments.mu.Lock()
	defer comments.mu.Unlock()
	comments.created = append(comments.created, params)
	if comments.err != nil {
		return core.Comment{}, core.CommentMutationEvent{}, comments.err
	}
	return core.Comment{
			ID:      params.ID,
			IssueID: params.IssueID,
			Body:    params.Body,
			Author:  core.ActorRef{Type: params.AuthorType, ID: params.AuthorID},
		}, core.CommentMutationEvent{
			ID:          eventID,
			WorkspaceID: comments.workspaceID,
			Type:        "comment.created",
			Payload:     []byte(`{}`),
			OccurredAt:  params.CreatedAt,
		}, nil
}

func (comments *fakeComments) snapshot() []core.CreateCommentParams {
	comments.mu.Lock()
	defer comments.mu.Unlock()
	return append([]core.CreateCommentParams(nil), comments.created...)
}

// fakeArtifacts records what a run tried to attach and can refuse it.
type fakeArtifacts struct {
	mu    sync.Mutex
	err   error
	files []capturedFile
}

type capturedFile struct {
	run     uuid.UUID
	name    string
	content []byte
}

func (sink *fakeArtifacts) PromoteContent(
	_ context.Context,
	run artifacts.RunContext,
	name string,
	content []byte,
) error {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if sink.err != nil {
		return sink.err
	}
	sink.files = append(sink.files, capturedFile{run: run.RunID, name: name, content: append([]byte(nil), content...)})
	return nil
}

func (sink *fakeArtifacts) snapshot() []capturedFile {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	return append([]capturedFile(nil), sink.files...)
}

type providerEvent struct {
	eventType string
	metadata  map[string]string
}

type serviceStore struct {
	dispatch  runs.Dispatch
	failures  chan runs.FailParams
	successes chan runs.SuccessParams
	// completeErr is what CompleteSuccess answers after recording the attempt.
	completeErr    error
	cancelClaim    runs.CancellationClaim
	cancelled      bool
	mu             sync.Mutex
	providerEvents []providerEvent
	outputCount    atomic.Int32
	toolStarted    atomic.Int32
	toolCompleted  atomic.Int32
}

func (store *serviceStore) providerEventsOfType(eventType string) []providerEvent {
	store.mu.Lock()
	defer store.mu.Unlock()
	var matched []providerEvent
	for _, event := range store.providerEvents {
		if event.eventType == eventType {
			matched = append(matched, event)
		}
	}
	return matched
}

func newServiceStore() *serviceStore {
	return &serviceStore{
		dispatch: runs.Dispatch{
			RunID:           uuid.New(),
			IssueID:         uuid.New(),
			BoardID:         uuid.New(),
			AgentID:         uuid.New(),
			UpstreamAgentID: uuid.New(),
			IssueIdentifier: "BERRY-1",
			IssueTitle:      "Finish work",
			RequestID:       "req_dispatch_test",
		},
		failures:  make(chan runs.FailParams, 4),
		successes: make(chan runs.SuccessParams, 4),
	}
}

func (*serviceStore) Admit(
	context.Context,
	runs.AdmitParams,
) (runs.Run, error) {
	return runs.Run{}, errors.New("unexpected Admit call")
}

func (*serviceStore) Get(context.Context, uuid.UUID) (runs.Run, error) {
	return runs.Run{}, errors.New("unexpected Get call")
}

func (store *serviceStore) ClaimDispatch(
	context.Context,
	uuid.UUID,
	time.Time,
) (runs.Dispatch, error) {
	return store.dispatch, nil
}

func (store *serviceStore) MarkRunning(
	_ context.Context,
	runID, eventID uuid.UUID,
	_ string,
	now time.Time,
) (runs.Run, runs.Event, error) {
	return store.runningRun(runID, now), store.event(eventID, runID, "run.started", 1, now), nil
}

func (store *serviceStore) AppendOutput(
	_ context.Context,
	runID, eventID uuid.UUID,
	_, _ string,
	now time.Time,
) (runs.Event, error) {
	store.outputCount.Add(1)
	return store.event(eventID, runID, "run.output.delta", 2, now), nil
}

func (store *serviceStore) AppendToolStarted(
	_ context.Context,
	runID, eventID uuid.UUID,
	_, _ string,
	now time.Time,
) (runs.Event, error) {
	store.toolStarted.Add(1)
	return store.event(eventID, runID, "run.tool.started", 3, now), nil
}

func (store *serviceStore) AppendToolCompleted(
	_ context.Context,
	runID, eventID uuid.UUID,
	_ string,
	_ bool,
	now time.Time,
) (runs.Event, error) {
	store.toolCompleted.Add(1)
	return store.event(eventID, runID, "run.tool.completed", 4, now), nil
}

func (store *serviceStore) RecordProviderEvent(
	_ context.Context,
	_ uuid.UUID,
	_ uuid.UUID,
	eventType string,
	metadata map[string]string,
	_ time.Time,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.providerEvents = append(store.providerEvents, providerEvent{
		eventType: eventType,
		metadata:  metadata,
	})
	return nil
}

func (store *serviceStore) CompleteSuccess(
	_ context.Context,
	params runs.SuccessParams,
) (runs.Run, []runs.Event, error) {
	store.successes <- params
	if store.completeErr != nil {
		return runs.Run{}, nil, store.completeErr
	}
	run := store.runningRun(params.RunID, params.CompletedAt)
	run.Status = runs.StatusSucceeded
	return run, []runs.Event{
		store.event(params.UsageEventID, params.RunID, "run.usage.updated", 5, params.CompletedAt),
		store.event(params.CompletedEventID, params.RunID, "run.completed", 6, params.CompletedAt),
	}, nil
}

func (store *serviceStore) Fail(
	_ context.Context,
	params runs.FailParams,
) (runs.Run, runs.Event, error) {
	store.failures <- params
	run := store.runningRun(params.RunID, params.FailedAt)
	run.Status = runs.StatusFailed
	return run, store.event(params.EventID, params.RunID, "run.failed", 5, params.FailedAt), nil
}

func (store *serviceStore) RequestCancellation(
	context.Context,
	runs.CancelParams,
) (runs.CancellationClaim, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.cancelled {
		run := store.cancelClaim.Run
		run.Status = runs.StatusCancelled
		run.DispatchState = runs.DispatchCancelled
		return runs.CancellationClaim{Run: run}, nil
	}
	return store.cancelClaim, nil
}

func (store *serviceStore) MarkCancelled(
	_ context.Context,
	runID, eventID uuid.UUID,
	_ string,
	now time.Time,
) (runs.Run, runs.Event, error) {
	store.mu.Lock()
	store.cancelled = true
	store.mu.Unlock()
	run := store.cancelClaim.Run
	run.ID = runID
	run.Status = runs.StatusCancelled
	run.DispatchState = runs.DispatchCancelled
	return run, store.event(eventID, runID, "run.cancelled", 5, now), nil
}

func (*serviceStore) MarkCancellationUnconfirmed(
	context.Context,
	uuid.UUID,
	time.Time,
) error {
	return nil
}

func (store *serviceStore) runningRun(runID uuid.UUID, now time.Time) runs.Run {
	return runs.Run{
		ID:              runID,
		IssueID:         store.dispatch.IssueID,
		BoardID:         store.dispatch.BoardID,
		AgentID:         store.dispatch.AgentID,
		UpstreamAgentID: store.dispatch.UpstreamAgentID,
		Status:          runs.StatusRunning,
		DispatchState:   runs.DispatchStreaming,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
}

func (store *serviceStore) event(
	eventID, runID uuid.UUID,
	eventType string,
	sequence int64,
	now time.Time,
) runs.Event {
	run := runID
	seq := sequence
	return runs.Event{
		ID:          eventID,
		Type:        eventType,
		OccurredAt:  now,
		WorkspaceID: store.dispatch.WorkspaceID,
		BoardID:     store.dispatch.BoardID,
		IssueID:     store.dispatch.IssueID,
		RunID:       &run,
		Sequence:    &seq,
		Payload:     []byte(`{}`),
	}
}
