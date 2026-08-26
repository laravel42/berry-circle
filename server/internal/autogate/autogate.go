// Package autogate lets an issue reach done on an agent's review rather than
// a person's.
//
// Berry's default is that an agent's work stops at in_review and waits for
// somebody. AutoGate replaces that wait with a peer review: a second agent —
// never the one that did the work — reads what was produced and either
// approves it or says why not. It is opt-in per plan, because the gate it
// removes is the only point at which a human sees agent output before it
// counts as finished.
//
// The review is an ask, not a run. A run would create a second run on the
// issue, reassign it, open its own pull request and trigger its own review;
// an ask is one bounded question with a recorded cost and no side effects.
package autogate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// maxWorkBytes bounds what the reviewer is shown of the work.
const maxWorkBytes = 16 * 1024

// Candidate is an agent that could review.
type Candidate struct {
	ID            uuid.UUID
	Name          string
	ModelProvider string
	ModelName     string
}

// Subject is the finished work awaiting a verdict.
type Subject struct {
	WorkspaceID     uuid.UUID
	IssueID         uuid.UUID
	RunID           uuid.UUID
	AuthorID        uuid.UUID
	AuthorName      string
	IssueIdentifier string
	IssueTitle      string
	IssueBody       string
	Summary         string
	Artifacts       []string
	AutoGate        bool
	InReview        bool
}

// Verdict is what the reviewer answered.
type Verdict struct {
	Approved bool   `json:"approved"`
	Reason   string `json:"reason"`
}

// Ask is one recorded question to an agent, for the ledger.
type Ask struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	AgentID       uuid.UUID
	Status        string
	PromptBytes   int
	Answer        json.RawMessage
	FailureCode   string
	Failure       string
	ModelProvider string
	ModelName     string
	InputTokens   int64
	OutputTokens  int64
	UpstreamID    string
	CreatedAt     time.Time
	CompletedAt   time.Time
}

// Store is the product state a review reads and writes.
type Store interface {
	// ReviewSubject describes the run's issue, or reports AutoGate off.
	ReviewSubject(ctx context.Context, runID uuid.UUID) (Subject, error)
	// Reviewers lists agents that could review, excluding the author.
	Reviewers(ctx context.Context, workspaceID, authorID uuid.UUID) ([]Candidate, error)
	// RecordVerdict stores the review and, when approved, closes the issue.
	// Returns whether the issue moved.
	RecordVerdict(ctx context.Context, subject Subject, reviewer Candidate,
		verdict Verdict, askID uuid.UUID, now time.Time) (bool, error)
	// RecordAsk puts the call in the ask ledger, whatever its outcome.
	RecordAsk(ctx context.Context, ask Ask) error
}

// Completer is the one runtime call a review makes.
type Completer interface {
	CreateChatCompletion(context.Context, openfang.ChatCompletionRequest) (openfang.ChatCompletionResult, error)
}

// Service performs one auto review.
type Service struct {
	Store Store
	// Chat is the runtime's OpenAI-compatible route, with the reviewer agent
	// as the model — the same seam an agent ask uses.
	Chat   Completer
	Clock  func() time.Time
	NewID  func() uuid.UUID
	Logger *slog.Logger
}

// ErrNotGated means the run's issue does not auto-gate. Not a failure.
var ErrNotGated = errors.New("autogate: the issue is not auto-gated")

// ErrNoReviewer means no peer was free to review, so the issue keeps waiting
// for a person. Deliberately not an error the caller retries: an approval
// nobody was available to give is the human gate working as designed.
var ErrNoReviewer = errors.New("autogate: no peer agent was available to review")

// Review asks a peer to judge a finished run and closes the issue if it passes.
func (service *Service) Review(ctx context.Context, runID uuid.UUID) (Verdict, error) {
	if service == nil || service.Store == nil || service.Chat == nil {
		return Verdict{}, errors.New("autogate: not configured")
	}
	subject, err := service.Store.ReviewSubject(ctx, runID)
	if err != nil {
		return Verdict{}, err
	}
	if !subject.AutoGate || !subject.InReview {
		return Verdict{}, ErrNotGated
	}

	reviewers, err := service.Store.Reviewers(ctx, subject.WorkspaceID, subject.AuthorID)
	if err != nil {
		return Verdict{}, err
	}
	reviewer, ok := pick(reviewers, subject.AuthorID)
	if !ok {
		return Verdict{}, ErrNoReviewer
	}

	prompt := Prompt(subject)
	ask := Ask{
		ID: service.newID(), WorkspaceID: subject.WorkspaceID, AgentID: reviewer.ID,
		PromptBytes: len(prompt), ModelProvider: reviewer.ModelProvider,
		ModelName: reviewer.ModelName, CreatedAt: service.now(),
	}

	result, err := service.Chat.CreateChatCompletion(ctx, openfang.ChatCompletionRequest{
		Model:          reviewer.Name,
		Messages:       []openfang.ChatMessage{{Role: "user", Content: prompt}},
		ResponseFormat: openfang.ChatResponseFormatJSONObject,
	})
	ask.CompletedAt = service.now()
	if err != nil {
		ask.Status, ask.FailureCode, ask.Failure = "failed", "REVIEW_CALL_FAILED", "The reviewer did not answer."
		service.record(ctx, ask)
		return Verdict{}, fmt.Errorf("autogate: reviewer call failed: %w", err)
	}
	ask.InputTokens, ask.OutputTokens = int64(result.Usage.InputTokens), int64(result.Usage.OutputTokens)
	ask.UpstreamID = result.RequestID

	verdict, decodeErr := decode(result.Content)
	if decodeErr != nil {
		// An unreadable verdict is not a rejection and certainly not an
		// approval. The issue stays in review for a person, which is exactly
		// where it would have been without AutoGate.
		ask.Status, ask.FailureCode, ask.Failure = "failed", "VERDICT_INVALID", decodeErr.Error()
		service.record(ctx, ask)
		return Verdict{}, fmt.Errorf("autogate: %w", decodeErr)
	}
	answer, _ := json.Marshal(verdict)
	ask.Status, ask.Answer = "succeeded", answer
	service.record(ctx, ask)

	moved, err := service.Store.RecordVerdict(ctx, subject, reviewer, verdict, ask.ID, service.now())
	if err != nil {
		return verdict, err
	}
	if service.Logger != nil {
		service.Logger.Info("auto review recorded",
			"issue", subject.IssueIdentifier, "reviewer", reviewer.Name,
			"author", subject.AuthorName, "approved", verdict.Approved, "movedToDone", moved)
	}
	return verdict, nil
}

// pick chooses the reviewer.
//
// A reviewer named for the job is preferred when the workspace has one, but
// the only rule that matters is that it is not the author: an agent approving
// its own work is not a review, it is a formality with a cost.
func pick(candidates []Candidate, authorID uuid.UUID) (Candidate, bool) {
	var fallback Candidate
	var found bool
	for _, candidate := range candidates {
		if candidate.ID == authorID {
			continue
		}
		if strings.Contains(strings.ToLower(candidate.Name), "review") {
			return candidate, true
		}
		if !found {
			fallback, found = candidate, true
		}
	}
	return fallback, found
}

// Prompt is what the reviewer is asked. Exported so a test can read it.
func Prompt(subject Subject) string {
	var builder strings.Builder
	builder.WriteString("You are reviewing another agent's finished work before it is marked done. ")
	builder.WriteString("Nobody else will look at it first: if you approve, the task closes.\n\n")
	builder.WriteString("Task ")
	builder.WriteString(subject.IssueIdentifier)
	builder.WriteString(": ")
	builder.WriteString(subject.IssueTitle)
	if subject.IssueBody != "" {
		builder.WriteString("\n\nWhat was asked:\n")
		builder.WriteString(clamp(subject.IssueBody, maxWorkBytes/2))
	}
	if subject.AuthorName != "" {
		builder.WriteString("\n\nWorked by: ")
		builder.WriteString(subject.AuthorName)
	}
	if subject.Summary != "" {
		builder.WriteString("\n\nWhat the agent reported:\n")
		builder.WriteString(clamp(subject.Summary, maxWorkBytes))
	}
	if len(subject.Artifacts) > 0 {
		builder.WriteString("\n\nFiles it produced:\n")
		for _, name := range subject.Artifacts {
			builder.WriteString("- ")
			builder.WriteString(name)
			builder.WriteString("\n")
		}
	}
	builder.WriteString("\nApprove only if the work actually does what was asked. ")
	builder.WriteString("Reject when it is incomplete, when it describes what it would do instead of doing it, ")
	builder.WriteString("when it produced no evidence of the work, or when it contradicts the task. ")
	builder.WriteString("Say plainly what is missing — your reason is posted on the task for whoever picks it up.\n\n")
	builder.WriteString(`Answer with a single JSON object and nothing else: {"approved": boolean, "reason": string}`)
	return builder.String()
}

func decode(content string) (Verdict, error) {
	trimmed := strings.TrimSpace(content)
	start, end := strings.Index(trimmed, "{"), strings.LastIndex(trimmed, "}")
	if start < 0 || end <= start {
		return Verdict{}, errors.New("the reviewer did not answer with a JSON object")
	}
	var verdict Verdict
	if err := json.Unmarshal([]byte(trimmed[start:end+1]), &verdict); err != nil {
		return Verdict{}, errors.New("the reviewer's answer is not the expected shape")
	}
	verdict.Reason = clamp(strings.TrimSpace(verdict.Reason), 4000)
	if verdict.Reason == "" {
		// A verdict with no reason is unreviewable by the person who later
		// asks why this closed, so it is refused in both directions.
		return Verdict{}, errors.New("the reviewer gave a verdict with no reason")
	}
	return verdict, nil
}

func clamp(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := value[:limit]
	for len(cut) > 0 && !utf8Valid(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + "\n[…truncated]"
}

func utf8Valid(value string) bool {
	for _, letter := range value {
		if letter == '�' {
			return false
		}
	}
	return true
}

func (service *Service) record(ctx context.Context, ask Ask) {
	if err := service.Store.RecordAsk(ctx, ask); err != nil && service.Logger != nil {
		service.Logger.Warn("auto review ask not recorded", "askId", ask.ID, "error", err)
	}
}

func (service *Service) now() time.Time {
	if service.Clock != nil {
		return service.Clock().UTC()
	}
	return time.Now().UTC()
}

func (service *Service) newID() uuid.UUID {
	if service.NewID != nil {
		return service.NewID()
	}
	return uuid.New()
}
