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
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openrouter"
)

// Bounds on what the reviewer is shown.
const (
	maxWorkBytes = 16 * 1024
	// maxFileBytes and maxFiles bound the evidence. A reviewer given the whole
	// output of a large run reads none of it carefully.
	maxFileBytes  = 8 * 1024
	maxFiles      = 20
	maxTotalFiles = 96 * 1024
)

// Candidate is an agent that could review.
type Candidate struct {
	ID            uuid.UUID
	Name          string
	ModelProvider string
	ModelName     string
	// Instructions is the reviewer's own system prompt. OpenFang applied it
	// upstream when the call named an agent; a direct call names a model, so
	// Berry has to send it or the reviewer loses the character it was given.
	Instructions string
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
	Artifacts       []ArtifactFile
	AutoGate        bool
	InReview        bool
}

// ArtifactFile is one file the run produced, as the store knows it.
type ArtifactFile struct {
	// Path is where the agent wrote it, relative to output/. The reviewer is
	// judging a deliverable, and src/lib/generator.ts says more about it than
	// generator.ts does.
	Path        string
	ContentType string
	SizeBytes   int64
	StorageKey  string
}

// Evidence is one artifact with as much of its content as the reviewer sees.
type Evidence struct {
	Name string
	Body string
	// Unreadable marks a file that exists but could not be shown — a binary,
	// or one storage would not return. It is still evidence that the file was
	// produced, which is the claim most often in question.
	Unreadable bool
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

// maxAttempts bounds the rework loop.
//
// A rejection sends the task back to be worked again, which is the point — but
// an agent that cannot satisfy its reviewer will not start to on the sixth
// attempt, and each round costs two model calls. After this many the task
// stays in review for a person, which is where AutoGate started.
const maxAttempts = 3

// Store is the product state a review reads and writes.
type Store interface {
	// ReviewSubject describes the run's issue, or reports AutoGate off.
	ReviewSubject(ctx context.Context, runID uuid.UUID) (Subject, error)
	// Reviewers lists agents that could review, excluding the author.
	Reviewers(ctx context.Context, workspaceID, authorID uuid.UUID) ([]Candidate, error)
	// BeginReview reserves the review before the model is called, so the
	// reviewer is answerable while the call is still running. Returns the
	// review's id and which attempt at this task it is.
	BeginReview(ctx context.Context, subject Subject, reviewer Candidate,
		now time.Time) (uuid.UUID, int, error)
	// RecordVerdict completes the reserved review. An approved task closes; a
	// rejected one returns to todo to be worked again, unless it has used its
	// attempts. Returns the status the issue ended in.
	RecordVerdict(ctx context.Context, reviewID uuid.UUID, subject Subject,
		verdict Verdict, askID uuid.UUID, attempt int, now time.Time) (string, error)
	// AbandonReview releases a reservation whose call never produced a
	// verdict, so the next attempt is not blocked by it.
	AbandonReview(ctx context.Context, reviewID uuid.UUID) error
	// RecordAsk puts the call in the ask ledger, whatever its outcome.
	RecordAsk(ctx context.Context, ask Ask) error
}

// Files opens a stored artifact so the reviewer can read it.
type Files interface {
	Open(ctx context.Context, storageKey string) (io.ReadCloser, error)
}

// Completer is the one model call a review makes.
type Completer interface {
	CreateChatCompletion(context.Context, openrouter.ChatCompletionRequest) (openrouter.ChatCompletionResult, error)
}

// Service performs one auto review.
type Service struct {
	Store Store
	// Chat completes one question against the reviewer's own model. It used
	// to be the runtime's OpenAI-compatible route, named by agent; OpenFang
	// resolved the agent to a provider and model and forwarded the call, and
	// Berry already knows both, so the hop bought nothing.
	Chat Completer
	// Files reads the artifacts the run produced. Without it the reviewer sees
	// only their names, which it has no way to verify.
	Files  Files
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

	// Reserved before the call, not after: for the length of the call — and
	// for as long as a failed call left no row at all — a task under review
	// looked exactly like a task nobody had reached.
	reviewID, attempt, err := service.Store.BeginReview(ctx, subject, reviewer, service.now())
	if err != nil {
		return Verdict{}, err
	}

	prompt := Prompt(subject, service.evidence(ctx, subject))
	ask := Ask{
		ID: service.newID(), WorkspaceID: subject.WorkspaceID, AgentID: reviewer.ID,
		PromptBytes: len(prompt), ModelProvider: reviewer.ModelProvider,
		ModelName: reviewer.ModelName, CreatedAt: service.now(),
	}

	messages := make([]openrouter.ChatMessage, 0, 2)
	if instructions := strings.TrimSpace(reviewer.Instructions); instructions != "" {
		messages = append(messages, openrouter.ChatMessage{Role: "system", Content: instructions})
	}
	messages = append(messages, openrouter.ChatMessage{Role: "user", Content: prompt})

	result, err := service.Chat.CreateChatCompletion(ctx, openrouter.ChatCompletionRequest{
		Model:    reviewer.ModelName,
		Messages: messages,
		// A hint, not a guarantee — decode() finds the object inside whatever
		// prose or fencing the model wraps it in.
		ResponseFormat: openrouter.ChatResponseFormatJSONObject,
	})
	ask.CompletedAt = service.now()
	if err != nil {
		ask.Status, ask.FailureCode, ask.Failure = "failed", "REVIEW_CALL_FAILED", "The reviewer did not answer."
		service.record(ctx, ask)
		service.abandon(ctx, reviewID)
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
		service.abandon(ctx, reviewID)
		return Verdict{}, fmt.Errorf("autogate: %w", decodeErr)
	}
	answer, _ := json.Marshal(verdict)
	ask.Status, ask.Answer = "succeeded", answer
	service.record(ctx, ask)

	status, err := service.Store.RecordVerdict(
		ctx, reviewID, subject, verdict, ask.ID, attempt, service.now())
	if err != nil {
		return verdict, err
	}
	if service.Logger != nil {
		service.Logger.Info("auto review recorded",
			"issue", subject.IssueIdentifier, "reviewer", reviewer.Name,
			"author", subject.AuthorName, "approved", verdict.Approved,
			"attempt", attempt, "issueStatus", status)
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

// evidence reads what the run produced, for the prompt.
//
// The reviewer is an agent with file tools, and OpenFang scopes those to the
// reviewer's own workspace — not the author's. Left to verify a claim itself
// it reads its own empty output/ directory and reports, accurately and
// uselessly, that there is no evidence. So the evidence comes to it.
func (service *Service) evidence(ctx context.Context, subject Subject) []Evidence {
	found := make([]Evidence, 0, len(subject.Artifacts))
	spent := 0
	for _, artifact := range subject.Artifacts {
		if len(found) >= maxFiles || spent >= maxTotalFiles {
			break
		}
		if service.Files == nil {
			found = append(found, Evidence{Name: artifact.Path, Unreadable: true})
			continue
		}
		body, ok := service.read(ctx, artifact)
		if !ok {
			found = append(found, Evidence{Name: artifact.Path, Unreadable: true})
			continue
		}
		found = append(found, Evidence{Name: artifact.Path, Body: body})
		spent += len(body)
	}
	return found
}

func (service *Service) read(ctx context.Context, artifact ArtifactFile) (string, bool) {
	handle, err := service.Files.Open(ctx, artifact.StorageKey)
	if err != nil {
		return "", false
	}
	defer handle.Close()
	raw, err := io.ReadAll(io.LimitReader(handle, maxFileBytes+1))
	if err != nil || len(raw) == 0 {
		return "", false
	}
	truncated := len(raw) > maxFileBytes
	if truncated {
		raw = raw[:maxFileBytes]
	}
	body := string(raw)
	for !utf8.ValidString(body) && len(body) > 0 {
		body = body[:len(body)-1]
	}
	if body == "" || strings.ContainsRune(body, 0) {
		return "", false
	}
	if truncated {
		body += "\n[…file continues]"
	}
	return body, true
}

// Prompt is what the reviewer is asked. Exported so a test can read it.
func Prompt(subject Subject, evidence []Evidence) string {
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
		// The complete manifest first, and always complete. A reviewer shown a
		// truncated list reads the absence of a file as the absence of the
		// work: it rejected a finished project for missing a vite.config.ts
		// that was sitting in the store, unshown because the contents budget
		// ran out eight files earlier. Names are cheap; contents are not.
		builder.WriteString("\n\nFiles it produced — all ")
		builder.WriteString(strconv.Itoa(len(subject.Artifacts)))
		builder.WriteString(" of them, already stored on the task:\n")
		for _, artifact := range subject.Artifacts {
			builder.WriteString("- ")
			builder.WriteString(artifact.Path)
			builder.WriteString(" (")
			builder.WriteString(strconv.FormatInt(artifact.SizeBytes, 10))
			builder.WriteString(" bytes)\n")
		}
	} else {
		builder.WriteString("\n\nThis task produced no files.")
	}

	if len(evidence) > 0 {
		if shown := len(evidence); shown < len(subject.Artifacts) {
			builder.WriteString("\nThe contents of ")
			builder.WriteString(strconv.Itoa(shown))
			builder.WriteString(" of those ")
			builder.WriteString(strconv.Itoa(len(subject.Artifacts)))
			builder.WriteString(" files follow. The rest exist and were stored; ")
			builder.WriteString("there was not room to print them here.\n")
		} else {
			builder.WriteString("\nTheir contents follow.\n")
		}
		for _, file := range evidence {
			builder.WriteString("\n--- ")
			builder.WriteString(file.Name)
			if file.Unreadable {
				builder.WriteString(" (this file exists but is not text, so its contents are not shown) ---\n")
				continue
			}
			builder.WriteString(" ---\n")
			builder.WriteString(file.Body)
			if !strings.HasSuffix(file.Body, "\n") {
				builder.WriteString("\n")
			}
		}
	}

	// Said before the instruction, because the failure it prevents is the
	// reviewer trying to check the claim itself.
	builder.WriteString("\n\nYou cannot inspect the author's workspace, its repository, or any filesystem. ")
	builder.WriteString("Your own workspace is not theirs — whatever it contains, including an empty output/ ")
	builder.WriteString("directory, tells you nothing about this task. Every file in the list above exists ")
	builder.WriteString("and is stored, whether or not its contents were printed and whether or not you can ")
	builder.WriteString("find it yourself. Do not use file tools; judge what you have been given.\n\n")
	builder.WriteString("Approve when what you were given does what the task asked. ")
	builder.WriteString("Reject when the work is incomplete, when it describes what it would do instead of ")
	builder.WriteString("doing it, when the files contradict the task, or when the task needed a deliverable ")
	builder.WriteString("and none was produced. Do not reject because you could not verify something ")
	builder.WriteString("yourself, and never reject a file for being absent when it is in the list above ")
	builder.WriteString("— an unprinted file is one there was no room for, not one that is missing. ")
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

// abandon releases a reservation whose call produced no verdict. Best effort:
// a stranded reservation costs the next attempt its row, not the task.
func (service *Service) abandon(ctx context.Context, reviewID uuid.UUID) {
	if err := service.Store.AbandonReview(ctx, reviewID); err != nil && service.Logger != nil {
		service.Logger.Warn("auto review reservation not released",
			"reviewId", reviewID, "error", err)
	}
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
