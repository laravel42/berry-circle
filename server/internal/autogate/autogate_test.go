package autogate

import (
	"context"
	"encoding/json"
	"errors"
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
}

func (store *stubStore) ReviewSubject(context.Context, uuid.UUID) (Subject, error) {
	return store.subject, nil
}

func (store *stubStore) Reviewers(context.Context, uuid.UUID, uuid.UUID) ([]Candidate, error) {
	return store.reviewers, nil
}

func (store *stubStore) RecordVerdict(
	_ context.Context, _ Subject, reviewer Candidate, verdict Verdict, _ uuid.UUID, _ time.Time,
) (bool, error) {
	store.verdicts = append(store.verdicts, verdict)
	store.askedWith = reviewer
	return verdict.Approved && store.moved, nil
}

func (store *stubStore) RecordAsk(_ context.Context, ask Ask) error {
	store.asks = append(store.asks, ask)
	return nil
}

type stubChat struct {
	content string
	err     error
	model   string
}

func (chat *stubChat) CreateChatCompletion(
	_ context.Context, request openfang.ChatCompletionRequest,
) (openfang.ChatCompletionResult, error) {
	chat.model = request.Model
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
	prompt := Prompt(gatedSubject())
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
