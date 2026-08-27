package collaboration

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/identity"
)

// Run artifacts are what an agent produced, kept in run_artifacts rather than
// in attachments (migration 027).
//
// An attachment is a file a person put on an issue and it has a name. Agent
// output is a tree: an agent asked to build an application writes
// src/password/generator.ts and .github/workflows/ci.yml, and the shape is
// part of the work. attachments.file_name forbids a separator, deliberately,
// so storing output there meant flattening the path or dropping everything
// below the top level — Berry did the second, and a run that wrote eleven
// files under src/ read as having produced nothing.

// RunArtifact is one file a run produced, at the path it wrote it.
type RunArtifact struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	RunID       uuid.UUID
	IssueID     uuid.UUID
	Agent       *Actor
	AgentName   string
	// Path is relative to the run's output directory, slash-separated:
	// `src/password/generator.ts`.
	Path           string
	ContentType    string
	SizeBytes      int64
	ChecksumSHA256 [32]byte
	StorageKey     string
	State          string
	CreatedAt      time.Time
	ReadyAt        *time.Time
}

// Name is the file's own name, without its directories. What a download is
// called, and what a tree renders at the leaf.
func (artifact RunArtifact) Name() string {
	if index := strings.LastIndex(artifact.Path, "/"); index >= 0 {
		return artifact.Path[index+1:]
	}
	return artifact.Path
}

// Directory is the path's parent, or "" for a file at the root.
func (artifact RunArtifact) Directory() string {
	if index := strings.LastIndex(artifact.Path, "/"); index > 0 {
		return artifact.Path[:index]
	}
	return ""
}

// ReserveRunArtifactParams describes a file a run produced (ADR-0006).
//
// There is no uploader id here: the agent is derived from the run rather than
// supplied, so an artifact cannot be attributed to an agent that did not
// produce it. The issue and workspace come from the run for the same reason.
type ReserveRunArtifactParams struct {
	ID    uuid.UUID
	RunID uuid.UUID
	// Path is relative to output/, slash-separated. The column refuses a path
	// that is absolute, has a traversal segment or an empty one.
	Path           string
	ContentType    string
	SizeBytes      int64
	ChecksumSHA256 [32]byte
	CreatedAt      time.Time
}

const runArtifactProjection = `
	artifact.id, artifact.workspace_id, artifact.run_id, artifact.issue_id,
	artifact.agent_id, artifact.agent_name, artifact.path, artifact.content_type,
	artifact.size_bytes, artifact.checksum_sha256, artifact.storage_key,
	artifact.state, artifact.created_at, artifact.ready_at`

type runArtifactScanner interface{ Scan(...any) error }

func scanRunArtifact(row runArtifactScanner) (RunArtifact, error) {
	var (
		artifact RunArtifact
		agentID  *uuid.UUID
		checksum []byte
	)
	if err := row.Scan(
		&artifact.ID, &artifact.WorkspaceID, &artifact.RunID, &artifact.IssueID,
		&agentID, &artifact.AgentName, &artifact.Path, &artifact.ContentType,
		&artifact.SizeBytes, &checksum, &artifact.StorageKey,
		&artifact.State, &artifact.CreatedAt, &artifact.ReadyAt,
	); err != nil {
		return RunArtifact{}, err
	}
	if agentID != nil {
		artifact.Agent = &Actor{ID: *agentID, Name: artifact.AgentName}
	}
	copy(artifact.ChecksumSHA256[:], checksum)
	return artifact, nil
}

// ReserveRunArtifact records a run's output as a pending artifact.
//
// Deliberately not an authorised path: it is reached by the worker promoting a
// finished run, not by a request, so there is no acting user whose membership
// could be checked. The scoping instead comes from the run itself — an artifact
// lands on the issue that run belongs to and nowhere else.
func (repository *Repository) ReserveRunArtifact(
	ctx context.Context,
	params ReserveRunArtifactParams,
) (RunArtifact, error) {
	if params.RunID == uuid.Nil {
		return RunArtifact{}, errors.New("run artifact requires a run")
	}
	if strings.TrimSpace(params.Path) == "" {
		return RunArtifact{}, errors.New("run artifact requires a path")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return RunArtifact{}, errors.New("begin run artifact reservation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var (
		issueID     uuid.UUID
		workspaceID uuid.UUID
		agentID     uuid.UUID
		agentName   string
	)
	if err := tx.QueryRow(
		ctx,
		`SELECT run.issue_id, board.workspace_id, run.agent_id, agent.name
		   FROM runs AS run
		   JOIN issues AS issue ON issue.id = run.issue_id
		   JOIN boards AS board ON board.id = issue.board_id
		   JOIN agents AS agent ON agent.id = run.agent_id
		  WHERE run.id = $1
		  FOR KEY SHARE OF run, issue, board, agent`,
		params.RunID,
	).Scan(&issueID, &workspaceID, &agentID, &agentName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RunArtifact{}, ErrNotFound
		}
		return RunArtifact{}, classifyReadError("read run artifact context", err)
	}

	// Workspace-scoped so a key cannot collide across workspaces, and
	// run-scoped so the location states which run produced it — the thing the
	// runtime's agent-keyed directory could not express. Keyed by id rather
	// than by path so a path with awkward characters never reaches the store.
	storageKey := fmt.Sprintf("artifacts/%s/%s/%s", workspaceID, params.RunID, params.ID)

	if _, err := tx.Exec(
		ctx,
		`INSERT INTO run_artifacts (
		    id, workspace_id, run_id, issue_id, agent_id, agent_name, path,
		    content_type, size_bytes, checksum_sha256, storage_key, state, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)`,
		params.ID, workspaceID, params.RunID, issueID, agentID, agentName, params.Path,
		params.ContentType, params.SizeBytes, params.ChecksumSHA256[:], storageKey,
		params.CreatedAt.UTC(),
	); err != nil {
		return RunArtifact{}, classifyWriteError("reserve run artifact", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return RunArtifact{}, errors.New("commit run artifact reservation")
	}

	return RunArtifact{
		ID: params.ID, WorkspaceID: workspaceID, RunID: params.RunID, IssueID: issueID,
		Agent: &Actor{ID: agentID, Name: agentName}, AgentName: agentName,
		Path: params.Path, ContentType: params.ContentType, SizeBytes: params.SizeBytes,
		ChecksumSHA256: params.ChecksumSHA256, StorageKey: storageKey,
		State: "pending", CreatedAt: params.CreatedAt.UTC(),
	}, nil
}

// ListRunArtifacts returns the ready artifacts a run produced, in path order.
//
// Path order rather than creation order, because the result is rendered as a
// tree and a tree is read alphabetically: files in one directory belong beside
// each other whatever order the promoter happened to write them in.
func (repository *Repository) ListRunArtifacts(
	ctx context.Context,
	runID uuid.UUID,
	after *RunArtifactCursor,
	limit int,
) ([]RunArtifact, error) {
	if limit < 1 || limit > 500 {
		limit = 200
	}
	afterEnabled := after != nil
	var afterPath any
	if after != nil {
		afterPath = after.Path
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+runArtifactProjection+`
		   FROM run_artifacts AS artifact
		  WHERE artifact.run_id = $1
		    AND artifact.state = 'ready'
		    AND (NOT $2::boolean OR artifact.path > $3::text)
		  ORDER BY artifact.path ASC
		  LIMIT $4`,
		runID, afterEnabled, afterPath, limit,
	)
	if err != nil {
		return nil, attachmentOperationError("list run artifacts", err)
	}
	defer rows.Close()
	return collectRunArtifacts(rows, limit)
}

// RunArtifactCursor pages a tree. The path is the sort key, so it is the
// cursor: creation time says nothing about where a file sits in the tree.
type RunArtifactCursor struct {
	Path string
}

// ListIssueArtifacts returns everything every run on an issue produced.
//
// Newest run first, then path, so the most recent attempt reads as the current
// state of the work and earlier attempts remain below it.
func (repository *Repository) ListIssueArtifacts(
	ctx context.Context,
	issueID uuid.UUID,
	limit int,
) ([]RunArtifact, error) {
	if limit < 1 || limit > 500 {
		limit = 200
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+runArtifactProjection+`
		   FROM run_artifacts AS artifact
		   JOIN runs AS run ON run.id = artifact.run_id
		  WHERE artifact.issue_id = $1 AND artifact.state = 'ready'
		  ORDER BY run.created_at DESC, artifact.path ASC
		  LIMIT $2`,
		issueID, limit,
	)
	if err != nil {
		return nil, attachmentOperationError("list issue artifacts", err)
	}
	defer rows.Close()
	return collectRunArtifacts(rows, limit)
}

// ListIssueArtifactsFor is the authorised issue-scoped listing.
//
// The unauthorised ListIssueArtifacts exists for the worker, which has no
// acting user; this is the one a request reaches, and it resolves the human
// reference (PLATFORM-49) the same way the attachment listing does.
func (repository *Repository) ListIssueArtifactsFor(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	limit int,
) ([]RunArtifact, error) {
	access, err := authorizeIssueReference(
		ctx, repository.Pool, actorID, issueReference,
		identity.PermissionProductRead, false,
	)
	if err != nil {
		return nil, err
	}
	return repository.ListIssueArtifacts(ctx, access.IssueID, limit)
}

// GetRunArtifact reads one artifact by id, for a download.
func (repository *Repository) GetRunArtifact(
	ctx context.Context,
	artifactID uuid.UUID,
) (RunArtifact, error) {
	artifact, err := scanRunArtifact(repository.Pool.QueryRow(
		ctx,
		`SELECT `+runArtifactProjection+`
		   FROM run_artifacts AS artifact
		  WHERE artifact.id = $1 AND artifact.state = 'ready'`,
		artifactID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return RunArtifact{}, ErrNotFound
	}
	if err != nil {
		return RunArtifact{}, classifyReadError("read run artifact", err)
	}
	return artifact, nil
}

func collectRunArtifacts(rows pgx.Rows, limit int) ([]RunArtifact, error) {
	artifacts := make([]RunArtifact, 0, limit)
	for rows.Next() {
		artifact, err := scanRunArtifact(rows)
		if err != nil {
			return nil, attachmentOperationError("scan run artifact", err)
		}
		artifacts = append(artifacts, artifact)
	}
	if err := rows.Err(); err != nil {
		return nil, attachmentOperationError("list run artifacts", err)
	}
	return artifacts, nil
}

// ActivateRunArtifact makes a promoted artifact visible.
//
// The user-facing activation authorises against the caller's membership; there
// is no caller here, so the artifact is instead identified by the run that owns
// it. Requiring both ids means a stray artifact id cannot be activated through
// this path — it must belong to the run being promoted.
func (repository *Repository) ActivateRunArtifact(
	ctx context.Context,
	runID, artifactID, eventID uuid.UUID,
	readyAt time.Time,
) (RunArtifact, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return RunArtifact{}, Event{}, errors.New("begin run artifact activation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var boardID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		// Deliberately not filtered on issue.deleted_at: this resolves the
		// board for an upload that already succeeded. Refusing here because
		// the issue was deleted mid-promotion would strand a pending row that
		// promises bytes the store already holds, and the artifact is hidden
		// with its issue regardless.
		`UPDATE run_artifacts AS artifact
		    SET state = 'ready', ready_at = $3
		   FROM issues AS issue
		  WHERE artifact.id = $1
		    AND artifact.run_id = $2
		    AND artifact.state = 'pending'
		    AND issue.id = artifact.issue_id
		 RETURNING issue.board_id`,
		artifactID, runID, readyAt.UTC(),
	).Scan(&boardID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Either it was already activated or it is not this run's to
			// activate. Both are refusals rather than faults: promotion retries.
			return RunArtifact{}, Event{}, ErrNotFound
		}
		return RunArtifact{}, Event{}, classifyWriteError("activate run artifact", err)
	}

	artifact, err := scanRunArtifact(tx.QueryRow(
		ctx,
		`SELECT `+runArtifactProjection+`
		   FROM run_artifacts AS artifact WHERE artifact.id = $1`,
		artifactID,
	))
	if err != nil {
		return RunArtifact{}, Event{}, classifyReadError("read activated run artifact", err)
	}

	event, err := makeEvent(
		eventID, artifact.WorkspaceID, boardID,
		"artifact.created", "artifact", artifact.ID,
		artifactEventPayload{
			Artifact: runArtifactEventPayload(artifact),
			RunID:    runID,
			IssueID:  artifact.IssueID,
		},
		readyAt,
	)
	if err != nil {
		return RunArtifact{}, Event{}, err
	}
	if err := insertOutboxEvent(ctx, tx, event); err != nil {
		return RunArtifact{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RunArtifact{}, Event{}, errors.New("commit run artifact activation")
	}
	return artifact, event, nil
}

// artifactEventPayload names the run and issue beside the artifact so a
// workflow trigger filter can read them without decoding the resource.
type artifactEventPayload struct {
	Artifact any       `json:"artifact"`
	RunID    uuid.UUID `json:"runId"`
	IssueID  uuid.UUID `json:"issueId"`
}

func runArtifactEventPayload(artifact RunArtifact) map[string]any {
	return map[string]any{
		"id":          artifact.ID,
		"path":        artifact.Path,
		"name":        artifact.Name(),
		"contentType": artifact.ContentType,
		"sizeBytes":   artifact.SizeBytes,
		"agentName":   artifact.AgentName,
	}
}

// AbortRunArtifact removes a reservation whose upload failed.
func (repository *Repository) AbortRunArtifact(
	ctx context.Context,
	runID, artifactID uuid.UUID,
) error {
	if _, err := repository.Pool.Exec(
		ctx,
		`DELETE FROM run_artifacts
		  WHERE id = $1 AND run_id = $2 AND state = 'pending'`,
		artifactID, runID,
	); err != nil {
		return classifyWriteError("abort run artifact", err)
	}
	return nil
}

// AutoReview is one peer agent's verdict on a run (migration 026).
type AutoReview struct {
	ID       uuid.UUID
	RunID    uuid.UUID
	Reviewer string
	Author   string
	// Approved and Reason are absent while the review is running: the row is
	// reserved when the reviewer is picked, so that it can be shown, and
	// completed when the reviewer answers.
	Approved  *bool
	Reason    string
	Attempt   int
	StartedAt time.Time
	DecidedAt *time.Time
	CreatedAt time.Time
}

// InProgress reports a review that has started and not yet answered.
func (review AutoReview) InProgress() bool { return review.Approved == nil }

// ListIssueAutoReviews returns the verdicts on an issue, newest first.
//
// A rejected review left the task sitting in review with nothing to read: the
// verdict was recorded and the reason written, and no surface showed either,
// so an issue an agent had declined to approve looked exactly like one nobody
// had looked at yet.
func (repository *Repository) ListIssueAutoReviews(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	limit int,
) ([]AutoReview, error) {
	if limit < 1 || limit > 100 {
		limit = 20
	}
	access, err := authorizeIssueReference(
		ctx, repository.Pool, actorID, issueReference,
		identity.PermissionProductRead, false,
	)
	if err != nil {
		return nil, err
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT review.id, review.run_id,
		        COALESCE(reviewer.name, 'an agent'),
		        COALESCE(author.name, 'an agent'),
		        review.approved, COALESCE(review.reason, ''), review.attempt,
		        review.started_at, review.decided_at, review.created_at
		   FROM issue_auto_reviews AS review
		   LEFT JOIN agents AS reviewer ON reviewer.id = review.reviewer_id
		   LEFT JOIN agents AS author ON author.id = review.author_id
		  WHERE review.issue_id = $1
		  ORDER BY review.started_at DESC
		  LIMIT $2`,
		access.IssueID, limit,
	)
	if err != nil {
		return nil, classifyReadError("list auto reviews", err)
	}
	defer rows.Close()
	found := make([]AutoReview, 0, limit)
	for rows.Next() {
		var review AutoReview
		if err := rows.Scan(&review.ID, &review.RunID, &review.Reviewer,
			&review.Author, &review.Approved, &review.Reason, &review.Attempt,
			&review.StartedAt, &review.DecidedAt, &review.CreatedAt); err != nil {
			return nil, classifyReadError("scan auto review", err)
		}
		found = append(found, review)
	}
	return found, rows.Err()
}
