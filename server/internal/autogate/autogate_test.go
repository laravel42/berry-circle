package autogate

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

var (
	authorID   = uuid.New()
	reviewerID = uuid.New()
)

type stubStore struct {
	subject   Subject
	reviewers []Candidate
	verdicts  []Verdict
	asks      []Ask
	moved     bool
	askedWith Candidate
	began     int
	abandoned int
	attempt   int
	beginErr  error
}

func (store *stubStore) ReviewSubject(context.Context, uuid.UUID) (Subject, error) {
	return store.subject, nil
}

func (store *stubStore) Reviewers(context.Context, uuid.UUID, uuid.UUID) ([]Candidate, error) {
	return store.reviewers, nil
}

func (store *stubStore) BeginReview(
	_ context.Context, _ Subject, reviewer Candidate, _ time.Time,
) (uuid.UUID, int, error) {
	store.began++
	store.askedWith = reviewer
	if store.beginErr != nil {
		return uuid.Nil, 0, store.beginErr
	}
	attempt := store.attempt
	if attempt == 0 {
		attempt = 1
	}
	return uuid.New(), attempt, nil
}

func (store *stubStore) AbandonReview(_ context.Context, _ uuid.UUID) error {
	store.abandoned++
	return nil
}

func (store *stubStore) RecordVerdict(
	_ context.Context, _ uuid.UUID, _ Subject, verdict Verdict, _ uuid.UUID, attempt int, _ time.Time,
) (string, error) {
	store.verdicts = append(store.verdicts, verdict)
	switch {
	case verdict.Approved:
		return "done", nil
	case attempt < maxAttempts:
		return "todo", nil
	default:
		return "in_review", nil
	}
}

func (store *stubStore) RecordAsk(_ context.Context, ask Ask) error {
	store.asks = append(store.asks, ask)
	return nil
}

type stubChat struct {
	content string
	err     error
	model   string
	prompt  string
}

func (chat *stubChat) CreateChatCompletion(
	_ context.Context, request openfang.ChatCompletionRequest,
) (openfang.ChatCompletionResult, error) {
	chat.model = request.Model
	if len(request.Messages) > 0 {
		chat.prompt = request.Messages[0].Content
	}
	if chat.err != nil {
		return openfang.ChatCompletionResult{}, chat.err
	}
	return openfang.ChatCompletionResult{Content: chat.content}, nil
}

func gatedSubject() Subject {
	return Subject{
		WorkspaceID: uuid.New(), IssueID: uuid.New(), RunID: uuid.New(),
		AuthorID: authorID, AuthorName: "coder", IssueIdentifier: "PLATFORM-9",
		IssueTitle: "Add a health endpoint", Summary: "Added /healthz.",
		AutoGate: true, InReview: true,
	}
}

func service(store Store, chat Completer) *Service {
	return &Service{Store: store, Chat: chat, Clock: time.Now, NewID: uuid.New}
}

func TestAnApprovedIssueCloses(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   gatedSubject(),
		reviewers: []Candidate{{ID: reviewerID, Name: "code-reviewer"}},
		moved:     true,
	}
	chat := &stubChat{content: `{"approved":true,"reason":"The endpoint exists and is tested."}`}

	verdict, err := service(store, chat).Review(context.Background(), store.subject.RunID)
	if err != nil {
		t.Fatalf("Review: %v", err)
	}
	if !verdict.Approved {
		t.Error("want approval")
	}
	if len(store.verdicts) != 1 {
		t.Fatalf("recorded %d verdicts, want 1", len(store.verdicts))
	}
	if chat.model != "code-reviewer" {
		t.Errorf("asked %q, want the reviewer agent", chat.model)
	}
}

// The whole point of a peer review: the author must never be the reviewer.
func TestTheAuthorIsNeverTheReviewer(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   gatedSubject(),
		reviewers: []Candidate{{ID: authorID, Name: "coder"}, {ID: reviewerID, Name: "analyst"}},
	}
	chat := &stubChat{content: `{"approved":true,"reason":"Looks right."}`}

	if _, err := service(store, chat).Review(context.Background(), store.subject.RunID); err != nil {
		t.Fatalf("Review: %v", err)
	}
	if store.askedWith.ID == authorID {
		t.Fatal("the agent that did the work reviewed its own work")
	}
	if chat.model != "analyst" {
		t.Errorf("asked %q, want the peer", chat.model)
	}
}

// A workspace whose only free agent is the author has no peer, so the issue
// keeps waiting for a person rather than closing itself.
func TestWithOnlyTheAuthorFreeNothingIsApproved(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   gatedSubject(),
		reviewers: []Candidate{{ID: authorID, Name: "coder"}},
	}
	_, err := service(store, &stubChat{}).Review(context.Background(), store.subject.RunID)
	if !errors.Is(err, ErrNoReviewer) {
		t.Fatalf("Review error = %v, want ErrNoReviewer", err)
	}
	if len(store.verdicts) != 0 {
		t.Error("a verdict was recorded with no reviewer")
	}
}

func TestAPlanWithoutAutoGateIsLeftAlone(t *testing.T) {
	t.Parallel()
	subject := gatedSubject()
	subject.AutoGate = false
	store := &stubStore{subject: subject, reviewers: []Candidate{{ID: reviewerID, Name: "analyst"}}}

	_, err := service(store, &stubChat{}).Review(context.Background(), subject.RunID)
	if !errors.Is(err, ErrNotGated) {
		t.Fatalf("Review error = %v, want ErrNotGated", err)
	}
}

// A person who moved the issue while the reviewer was thinking keeps their
// decision; the service must not treat a stale in_review as current.
func TestAnIssueNoLongerInReviewIsLeftAlone(t *testing.T) {
	t.Parallel()
	subject := gatedSubject()
	subject.InReview = false
	store := &stubStore{subject: subject, reviewers: []Candidate{{ID: reviewerID, Name: "analyst"}}}

	if _, err := service(store, &stubChat{}).Review(context.Background(), subject.RunID); !errors.Is(err, ErrNotGated) {
		t.Fatalf("Review error = %v, want ErrNotGated", err)
	}
}

// An unreadable answer is not an approval. This is the failure that matters:
// everything else leaves work waiting, this one could close it wrongly.
func TestAnUnreadableVerdictNeverApproves(t *testing.T) {
	t.Parallel()
	for name, content := range map[string]string{
		"prose":       "Looks good to me!",
		"wrong shape": `{"verdict":"ship it"}`,
		"no reason":   `{"approved":true,"reason":"   "}`,
		"empty":       "",
	} {
		t.Run(name, func(t *testing.T) {
			store := &stubStore{
				subject:   gatedSubject(),
				reviewers: []Candidate{{ID: reviewerID, Name: "analyst"}},
			}
			if _, err := service(store, &stubChat{content: content}).Review(
				context.Background(), store.subject.RunID); err == nil {
				t.Fatal("want an error")
			}
			if len(store.verdicts) != 0 {
				t.Errorf("recorded a verdict from %q", content)
			}
			if len(store.asks) != 1 || store.asks[0].Status != "failed" {
				t.Error("the failed call was not recorded in the ask ledger")
			}
		})
	}
}

// A rejection is recorded and the issue stays where it is.
func TestARejectionIsRecordedAndTheIssueStays(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   gatedSubject(),
		reviewers: []Candidate{{ID: reviewerID, Name: "analyst"}},
	}
	chat := &stubChat{content: `{"approved":false,"reason":"It describes the endpoint but never adds it."}`}

	verdict, err := service(store, chat).Review(context.Background(), store.subject.RunID)
	if err != nil {
		t.Fatalf("Review: %v", err)
	}
	if verdict.Approved {
		t.Error("want a rejection")
	}
	if !strings.Contains(store.verdicts[0].Reason, "never adds it") {
		t.Errorf("reason not carried through: %q", store.verdicts[0].Reason)
	}
}

// Spend is visible whether or not the answer was usable.
func TestEveryCallReachesTheAskLedger(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   gatedSubject(),
		reviewers: []Candidate{{ID: reviewerID, Name: "analyst"}},
	}
	chat := &stubChat{err: errors.New("upstream is down")}

	if _, err := service(store, chat).Review(context.Background(), store.subject.RunID); err == nil {
		t.Fatal("want an error")
	}
	if len(store.asks) != 1 {
		t.Fatalf("recorded %d asks, want 1", len(store.asks))
	}
	if store.asks[0].Status != "failed" || store.asks[0].FailureCode == "" {
		t.Errorf("ask recorded as %+v, want a coded failure", store.asks[0])
	}
}

// The reviewer has to know that approving closes the task, or it reviews as
// though a person will catch anything it misses.
func TestThePromptSaysApprovalIsFinal(t *testing.T) {
	t.Parallel()
	prompt := Prompt(gatedSubject(), nil)
	for _, want := range []string{"Nobody else will look at it first", "PLATFORM-9", "coder", "approved"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt is missing %q", want)
		}
	}
}

func TestTheRecordedAnswerIsTheParsedVerdict(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   gatedSubject(),
		reviewers: []Candidate{{ID: reviewerID, Name: "analyst"}},
	}
	chat := &stubChat{content: "```json\n{\"approved\":true,\"reason\":\"Fine.\"}\n```"}

	if _, err := service(store, chat).Review(context.Background(), store.subject.RunID); err != nil {
		t.Fatalf("Review: %v", err)
	}
	var round Verdict
	if err := json.Unmarshal(store.asks[0].Answer, &round); err != nil {
		t.Fatalf("recorded answer is not a verdict: %v", err)
	}
	if !round.Approved {
		t.Error("a fenced answer was not parsed")
	}
}

type stubFiles struct{ bodies map[string]string }

func (files stubFiles) Open(_ context.Context, key string) (io.ReadCloser, error) {
	body, ok := files.bodies[key]
	if !ok {
		return nil, errors.New("no such object")
	}
	return io.NopCloser(strings.NewReader(body)), nil
}

func subjectWithFiles() Subject {
	subject := gatedSubject()
	subject.Artifacts = []ArtifactFile{
		{Path: "src/vite.config.ts", ContentType: "text/plain", SizeBytes: 40, StorageKey: "k1"},
		{Path: "public/logo.png", ContentType: "application/octet-stream", SizeBytes: 900, StorageKey: "k2"},
	}
	return subject
}

// The reviewer is sandboxed to its own workspace and cannot read the author's.
// Given only file names it went looking, found its own empty output/, and
// rejected work that was actually done — so the files come to it.
func TestTheReviewerIsShownTheFilesNotJustTheirNames(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   subjectWithFiles(),
		reviewers: []Candidate{{ID: reviewerID, Name: "code-reviewer"}},
	}
	chat := &stubChat{content: `{"approved":true,"reason":"The config is present and correct."}`}
	reviewer := service(store, chat)
	reviewer.Files = stubFiles{bodies: map[string]string{"k1": "export default defineConfig({})"}}

	if _, err := reviewer.Review(context.Background(), store.subject.RunID); err != nil {
		t.Fatalf("Review: %v", err)
	}
	if !strings.Contains(chat.prompt, "export default defineConfig({})") {
		t.Errorf("the file's contents never reached the reviewer:\n%s", chat.prompt)
	}
	// A binary is still evidence that the file was produced, which is the
	// claim most often in dispute.
	if !strings.Contains(chat.prompt, "logo.png") {
		t.Error("an unreadable artifact was dropped instead of being named")
	}
}

// The instruction that stops the failure we actually saw.
func TestTheReviewerIsToldItCannotCheckTheFilesystem(t *testing.T) {
	t.Parallel()
	prompt := Prompt(subjectWithFiles(), []Evidence{{Name: "a.ts", Body: "x"}})
	for _, want := range []string{
		"cannot inspect the author's workspace",
		"Your own workspace is not theirs",
		"Do not use file tools",
		"Do not reject because you could not verify something",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt is missing the guard %q:\n%s", want, prompt)
		}
	}
}

// A task that legitimately produced nothing must still be reviewable.
func TestATaskWithNoFilesSaysSoPlainly(t *testing.T) {
	t.Parallel()
	prompt := Prompt(gatedSubject(), nil)
	if !strings.Contains(prompt, "produced no files") {
		t.Errorf("a file-less task did not say so:\n%s", prompt)
	}
}

// The failure that rejected a finished project: 22 files were stored, the
// contents budget printed 8, and the reviewer concluded the other 14 did not
// exist — naming vite.config.ts as missing while it sat in the store.
func TestEveryFileIsListedEvenWhenOnlySomeAreShown(t *testing.T) {
	t.Parallel()
	subject := gatedSubject()
	for _, path := range []string{
		"package.json", "vite.config.ts", "tsconfig.json",
		"src/main.tsx", "src/lib/generator.ts",
	} {
		subject.Artifacts = append(subject.Artifacts, ArtifactFile{
			Path: path, ContentType: "text/plain", SizeBytes: 100, StorageKey: path,
		})
	}
	// Only the first file's contents were affordable.
	prompt := Prompt(subject, []Evidence{{Name: "package.json", Body: "{}"}})

	for _, path := range []string{"vite.config.ts", "tsconfig.json", "src/main.tsx", "src/lib/generator.ts"} {
		if !strings.Contains(prompt, path) {
			t.Errorf("a stored file is absent from the manifest: %s", path)
		}
	}
	if !strings.Contains(prompt, "1 of those 5 files") {
		t.Errorf("the prompt does not say the contents were cut:\n%s", prompt)
	}
	if !strings.Contains(prompt, "never reject a file for being absent when it is in the list") {
		t.Error("the reviewer is not told an unprinted file still exists")
	}
}

// A rejection sends the task back to be worked again — that is what makes the
// loop autonomous. Without it a rejected task sat in review forever, which is
// the state AutoGate exists to avoid.
func TestARejectedTaskGoesBackToBeWorkedAgain(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   gatedSubject(),
		reviewers: []Candidate{{ID: reviewerID, Name: "code-reviewer"}},
		attempt:   1,
	}
	chat := &stubChat{content: `{"approved":false,"reason":"The config file is missing."}`}

	if _, err := service(store, chat).Review(context.Background(), store.subject.RunID); err != nil {
		t.Fatalf("Review: %v", err)
	}
	status, _ := store.RecordVerdict(context.Background(), uuid.New(), store.subject,
		Verdict{Approved: false, Reason: "x"}, uuid.New(), 1, time.Now())
	if status != "todo" {
		t.Errorf("a rejected first attempt ended in %q, want todo", status)
	}
}

// And stops going back. An agent that has failed its reviewer three times will
// not succeed on the fourth, and each round costs two model calls.
func TestReworkStopsAfterTheAttemptsAreUsed(t *testing.T) {
	t.Parallel()
	store := &stubStore{}
	status, _ := store.RecordVerdict(context.Background(), uuid.New(), gatedSubject(),
		Verdict{Approved: false, Reason: "still wrong"}, uuid.New(), maxAttempts, time.Now())
	if status != "in_review" {
		t.Errorf("the last attempt ended in %q, want it left for a person", status)
	}
}

// The reviewer is answerable while the call is still running, which is the
// whole point of reserving the row first.
func TestTheReviewIsReservedBeforeTheModelIsCalled(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   gatedSubject(),
		reviewers: []Candidate{{ID: reviewerID, Name: "code-reviewer"}},
	}
	chat := &stubChat{content: `{"approved":true,"reason":"Fine."}`}

	if _, err := service(store, chat).Review(context.Background(), store.subject.RunID); err != nil {
		t.Fatalf("Review: %v", err)
	}
	if store.began != 1 {
		t.Errorf("BeginReview called %d times, want 1", store.began)
	}
	if store.abandoned != 0 {
		t.Error("a successful review released its reservation")
	}
}

// A call that never answers must not leave the task showing a reviewer that
// is not reviewing it.
func TestAFailedCallReleasesTheReservation(t *testing.T) {
	t.Parallel()
	store := &stubStore{
		subject:   gatedSubject(),
		reviewers: []Candidate{{ID: reviewerID, Name: "code-reviewer"}},
	}
	chat := &stubChat{err: errors.New("upstream is down")}

	if _, err := service(store, chat).Review(context.Background(), store.subject.RunID); err == nil {
		t.Fatal("want an error")
	}
	if store.abandoned != 1 {
		t.Errorf("abandoned %d reservations, want 1", store.abandoned)
	}
}
