package autogate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
		slug    string
		number  int32
	)
	err := store.Pool.QueryRow(
		ctx,
		`SELECT board.workspace_id, issue.id, run.id, run.agent_id,
		        COALESCE(agent.name, ''), upper(board.slug), issue.number,
		        issue.title, issue.description, run.summary,
		        issue.status::text, issue.auto_gate
		   FROM runs AS run
		   JOIN issues AS issue ON issue.id = run.issue_id AND issue.deleted_at IS NULL
		   JOIN boards AS board ON board.id = run.board_id
		   LEFT JOIN agents AS agent ON agent.id = run.agent_id
		  WHERE run.id = $1 AND run.status = 'succeeded'`,
		runID,
	).Scan(&subject.WorkspaceID, &subject.IssueID, &subject.RunID, &subject.AuthorID,
		&subject.AuthorName, &slug, &number, &subject.IssueTitle, &body, &summary,
		&status, &subject.AutoGate)
	if errors.Is(err, pgx.ErrNoRows) {
		return Subject{}, ErrNotGated
	}
	if err != nil {
		return Subject{}, fmt.Errorf("autogate: read review subject: %w", err)
	}
	subject.IssueIdentifier = fmt.Sprintf("%s-%d", slug, number)
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

// RecordVerdict stores the review and closes the issue when it passed.
//
// One transaction: a verdict that says approved while the issue sits in review
// is a lie a person would have to untangle, and the unique constraint on
// run_id makes a retried activity idempotent rather than duplicative.
func (store PostgresStore) RecordVerdict(
	ctx context.Context,
	subject Subject,
	reviewer Candidate,
	verdict Verdict,
	askID uuid.UUID,
	now time.Time,
) (bool, error) {
	tx, err := store.Pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("autogate: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(
		ctx,
		`INSERT INTO issue_auto_reviews (
		    workspace_id, issue_id, run_id, reviewer_id, author_id,
		    approved, reason, ask_id, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT (run_id) DO NOTHING`,
		subject.WorkspaceID, subject.IssueID, subject.RunID, reviewer.ID,
		subject.AuthorID, verdict.Approved, verdict.Reason, askID, now,
	)
	if err != nil {
		return false, fmt.Errorf("autogate: record verdict: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Already reviewed. The activity ran twice; the first verdict stands.
		return false, tx.Commit(ctx)
	}

	moved := false
	if verdict.Approved {
		// Guarded on in_review so a person who moved the issue while the
		// reviewer was thinking keeps their decision.
		closed, err := tx.Exec(
			ctx,
			`UPDATE issues
			    SET status = 'done', updated_at = $2
			  WHERE id = $1 AND status = 'in_review' AND deleted_at IS NULL`,
			subject.IssueID, now,
		)
		if err != nil {
			return false, fmt.Errorf("autogate: close issue: %w", err)
		}
		moved = closed.RowsAffected() == 1
	}
	return moved, tx.Commit(ctx)
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
