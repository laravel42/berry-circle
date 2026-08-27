package autogate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/issueid"
)

// PostgresStore is the product state a review reads and writes.
type PostgresStore struct {
	Pool *pgxpool.Pool
}

// ReviewSubject describes the run's issue.
func (store PostgresStore) ReviewSubject(ctx context.Context, runID uuid.UUID) (Subject, error) {
	var (
		subject Subject
		body    *string
		summary *string
		status  string
		prefix  string
		number  int32
	)
	err := store.Pool.QueryRow(
		ctx,
		`SELECT board.workspace_id, issue.id, run.id, run.agent_id,
		        COALESCE(agent.name, ''),
		        -- The identifier a person sees is the workspace's issue prefix,
		        -- not the board slug: BER-74, not PLATFORM-74. The reviewer is
		        -- told which task it is judging and the verdict is logged under
		        -- it; both have to name the task the way Berry does.
		        COALESCE(workspace.settings->>'issuePrefix', 'WS'), issue.number,
		        issue.title, issue.description, run.summary,
		        issue.status::text, issue.auto_gate
		   FROM runs AS run
		   JOIN issues AS issue ON issue.id = run.issue_id AND issue.deleted_at IS NULL
		   JOIN boards AS board ON board.id = run.board_id
		   JOIN workspaces AS workspace ON workspace.id = board.workspace_id
		   LEFT JOIN agents AS agent ON agent.id = run.agent_id
		  WHERE run.id = $1 AND run.status = 'succeeded'`,
		runID,
	).Scan(&subject.WorkspaceID, &subject.IssueID, &subject.RunID, &subject.AuthorID,
		&subject.AuthorName, &prefix, &number, &subject.IssueTitle, &body, &summary,
		&status, &subject.AutoGate)
	if errors.Is(err, pgx.ErrNoRows) {
		return Subject{}, ErrNotGated
	}
	if err != nil {
		return Subject{}, fmt.Errorf("autogate: read review subject: %w", err)
	}
	subject.IssueIdentifier = issueid.Format(prefix, number)
	subject.InReview = status == "in_review"
	if body != nil {
		subject.IssueBody = *body
	}
	if summary != nil {
		subject.Summary = *summary
	}

	rows, err := store.Pool.Query(
		ctx,
		`SELECT path, content_type, size_bytes, storage_key FROM run_artifacts
		  WHERE run_id = $1 AND state = 'ready'
		  ORDER BY path ASC LIMIT 20`,
		runID,
	)
	if err != nil {
		// The verdict is about the work, and the files are the evidence for it.
		// Losing them is worse review, not no review — though a reviewer shown
		// nothing will usually, and correctly, decline to approve.
		return subject, nil
	}
	defer rows.Close()
	for rows.Next() {
		var file ArtifactFile
		if err := rows.Scan(&file.Path, &file.ContentType, &file.SizeBytes, &file.StorageKey); err == nil {
			subject.Artifacts = append(subject.Artifacts, file)
		}
	}
	return subject, nil
}

// Reviewers lists agents that could review, never including the author.
//
// Idle rather than merely available: an agent already running something would
// answer this while it works, and the review is a judgement, not a queue item.
func (store PostgresStore) Reviewers(
	ctx context.Context,
	workspaceID, authorID uuid.UUID,
) ([]Candidate, error) {
	rows, err := store.Pool.Query(
		ctx,
		`SELECT agent.id, agent.name,
		        COALESCE(agent.model_provider, ''), COALESCE(agent.model_name, '')
		   FROM agents AS agent
		  WHERE agent.workspace_id = $1
		    AND agent.id <> $2
		    AND agent.archived_at IS NULL
		    AND NOT agent.protected
		    AND agent.status IN ('available', 'busy')
		    AND NOT EXISTS (
		        SELECT 1 FROM runs
		         WHERE runs.agent_id = agent.id
		           AND runs.status IN ('queued', 'running')
		    )
		  ORDER BY agent.name`,
		workspaceID, authorID,
	)
	if err != nil {
		return nil, fmt.Errorf("autogate: list reviewers: %w", err)
	}
	defer rows.Close()
	var found []Candidate
	for rows.Next() {
		var candidate Candidate
		if err := rows.Scan(&candidate.ID, &candidate.Name,
			&candidate.ModelProvider, &candidate.ModelName); err != nil {
			return nil, fmt.Errorf("autogate: scan reviewer: %w", err)
		}
		found = append(found, candidate)
	}
	return found, rows.Err()
}

// BeginReview reserves the review before the model is called.
//
// The unique index on run_id makes this the concurrency guard too: a second
// activity attempt for the same run finds the row already there and reuses it
// rather than opening a competing review.
func (store PostgresStore) BeginReview(
	ctx context.Context,
	subject Subject,
	reviewer Candidate,
	now time.Time,
) (uuid.UUID, int, error) {
	// Attempts are counted per issue, not per run: a rejected task is worked
	// again as a new run, and it is the task that must stop going round.
	var attempt int
	if err := store.Pool.QueryRow(
		ctx,
		`SELECT COALESCE(MAX(attempt), 0) + 1 FROM issue_auto_reviews WHERE issue_id = $1`,
		subject.IssueID,
	).Scan(&attempt); err != nil {
		return uuid.Nil, 0, fmt.Errorf("autogate: count attempts: %w", err)
	}

	var (
		reviewID uuid.UUID
		stored   int
	)
	if err := store.Pool.QueryRow(
		ctx,
		`INSERT INTO issue_auto_reviews (
		    workspace_id, issue_id, run_id, reviewer_id, author_id,
		    attempt, started_at, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
		 ON CONFLICT (run_id) DO UPDATE
		    SET reviewer_id = EXCLUDED.reviewer_id
		  WHERE issue_auto_reviews.approved IS NULL
		 RETURNING id, attempt`,
		subject.WorkspaceID, subject.IssueID, subject.RunID, reviewer.ID,
		subject.AuthorID, attempt, now,
	).Scan(&reviewID, &stored); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The conflicting row is already decided: this run was reviewed.
			return uuid.Nil, 0, ErrNotGated
		}
		return uuid.Nil, 0, fmt.Errorf("autogate: begin review: %w", err)
	}
	return reviewID, stored, nil
}

// AbandonReview releases a reservation whose call produced no verdict.
func (store PostgresStore) AbandonReview(ctx context.Context, reviewID uuid.UUID) error {
	if _, err := store.Pool.Exec(
		ctx,
		`DELETE FROM issue_auto_reviews WHERE id = $1 AND approved IS NULL`,
		reviewID,
	); err != nil {
		return fmt.Errorf("autogate: abandon review: %w", err)
	}
	return nil
}

// RecordVerdict completes the reserved review and moves the issue.
//
// Approved closes it. Rejected sends it back to todo to be worked again, which
// is what makes the loop autonomous — intake picks up a todo issue with no
// active run. After maxAttempts it stays in review instead: an agent that has
// failed its reviewer three times is not going to succeed on the fourth, and
// each round costs two model calls.
//
// One transaction, because a verdict that says rejected while the issue sits
// somewhere else is a contradiction a person has to untangle.
func (store PostgresStore) RecordVerdict(
	ctx context.Context,
	reviewID uuid.UUID,
	subject Subject,
	verdict Verdict,
	askID uuid.UUID,
	attempt int,
	now time.Time,
) (string, error) {
	tx, err := store.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("autogate: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(
		ctx,
		`UPDATE issue_auto_reviews
		    SET approved = $2, reason = $3, ask_id = $4, decided_at = $5
		  WHERE id = $1 AND approved IS NULL`,
		reviewID, verdict.Approved, verdict.Reason, askID, now,
	)
	if err != nil {
		return "", fmt.Errorf("autogate: record verdict: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Already decided. The activity ran twice; the first verdict stands.
		return "", tx.Commit(ctx)
	}

	// Guarded on in_review throughout, so a person who moved the issue while
	// the reviewer was thinking keeps their decision.
	next := "in_review"
	switch {
	case verdict.Approved:
		next = "done"
	case attempt < maxAttempts:
		next = "todo"
	}
	if next != "in_review" {
		moved, err := tx.Exec(
			ctx,
			`UPDATE issues
			    SET status = $2::issue_status, active_run_id = NULL, updated_at = $3
			  WHERE id = $1 AND status = 'in_review' AND deleted_at IS NULL`,
			subject.IssueID, next, now,
		)
		if err != nil {
			return "", fmt.Errorf("autogate: move issue to %s: %w", next, err)
		}
		if moved.RowsAffected() == 0 {
			next = "in_review"
		}
	}
	return next, tx.Commit(ctx)
}

// RecordAsk puts the call in the ask ledger so the spend is visible.
func (store PostgresStore) RecordAsk(ctx context.Context, ask Ask) error {
	_, err := store.Pool.Exec(
		ctx,
		`INSERT INTO agent_asks (
		    id, workspace_id, agent_id, status, prompt_bytes, answer,
		    failure_code, failure_message, model_provider, model_name,
		    input_tokens, output_tokens, upstream_request_id,
		    created_at, completed_at
		 ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		ask.ID, ask.WorkspaceID, ask.AgentID, ask.Status, ask.PromptBytes,
		nullableJSON(ask.Answer), nullable(ask.FailureCode), nullable(ask.Failure),
		nullable(ask.ModelProvider), nullable(ask.ModelName),
		ask.InputTokens, ask.OutputTokens, nullable(ask.UpstreamID),
		ask.CreatedAt, ask.CompletedAt,
	)
	if err != nil {
		return fmt.Errorf("autogate: record ask: %w", err)
	}
	return nil
}

func nullable(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func nullableJSON(value []byte) *string {
	if len(value) == 0 {
		return nil
	}
	text := string(value)
	return &text
}

var _ Store = PostgresStore{}
