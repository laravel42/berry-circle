package collaboration

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ReserveRunArtifactParams describes a file a run produced (ADR-0006).
//
// There is no uploader id here: the agent is derived from the run rather than
// supplied, so an artifact cannot be attributed to an agent that did not
// produce it. The issue and workspace come from the run for the same reason.
type ReserveRunArtifactParams struct {
	ID             uuid.UUID
	RunID          uuid.UUID
	FileName       string
	ContentType    string
	SizeBytes      int64
	ChecksumSHA256 [32]byte
	CreatedAt      time.Time
}

// ReserveRunArtifact records a run's output as a pending attachment.
//
// Deliberately not an authorised path: it is reached by the worker promoting a
// finished run, not by a request, so there is no acting user whose membership
// could be checked. The scoping instead comes from the run itself — an artifact
// lands on the issue that run belongs to and nowhere else.
func (repository *Repository) ReserveRunArtifact(
	ctx context.Context,
	params ReserveRunArtifactParams,
) (Attachment, error) {
	if params.RunID == uuid.Nil {
		return Attachment{}, errors.New("run artifact requires a run")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Attachment{}, errors.New("begin run artifact reservation")
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
			return Attachment{}, ErrNotFound
		}
		return Attachment{}, classifyReadError("read run artifact context", err)
	}

	// Workspace-scoped so a key cannot collide across workspaces, and
	// run-scoped so the location states which run produced it — the thing the
	// runtime's agent-keyed directory could not express.
	storageKey := fmt.Sprintf(
		"artifacts/%s/%s/%s",
		workspaceID,
		params.RunID,
		params.ID,
	)

	if _, err := tx.Exec(
		ctx,
		`INSERT INTO attachments (
		    id, issue_id, comment_id, uploader_type, uploader_agent_id,
		    uploader_name, run_id, file_name, content_type, size_bytes,
		    checksum_sha256, storage_key, state, created_at
		 ) VALUES (
		    $1, $2, NULL, 'agent', $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11
		 )`,
		params.ID,
		issueID,
		agentID,
		agentName,
		params.RunID,
		params.FileName,
		params.ContentType,
		params.SizeBytes,
		params.ChecksumSHA256[:],
		storageKey,
		params.CreatedAt.UTC(),
	); err != nil {
		return Attachment{}, classifyWriteError("reserve run artifact", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Attachment{}, errors.New("commit run artifact reservation")
	}

	runID := params.RunID
	return Attachment{
		ID:             params.ID,
		WorkspaceID:    workspaceID,
		IssueID:        issueID,
		Uploader:       &Actor{ID: agentID, Name: agentName},
		UploaderType:   "agent",
		RunID:          &runID,
		FileName:       params.FileName,
		ContentType:    params.ContentType,
		SizeBytes:      params.SizeBytes,
		ChecksumSHA256: params.ChecksumSHA256,
		StorageKey:     storageKey,
		State:          "pending",
		CreatedAt:      params.CreatedAt.UTC(),
	}, nil
}

// ListRunArtifacts returns the ready artifacts a run produced, oldest first.
//
// The question ADR-0006 exists to make answerable, and the reason run_id has a
// partial index rather than being derived by joining every attachment on the
// issue.
func (repository *Repository) ListRunArtifacts(
	ctx context.Context,
	runID uuid.UUID,
	after *AttachmentCursor,
	limit int,
) ([]Attachment, error) {
	if limit < 1 || limit > 200 {
		limit = 50
	}
	afterEnabled := after != nil
	var afterTime any
	var afterID any
	if after != nil {
		afterTime = after.CreatedAt
		afterID = after.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+attachmentProjection+`
		   FROM attachments AS attachment
		   JOIN issues AS issue ON issue.id = attachment.issue_id
		   JOIN boards AS board ON board.id = issue.board_id
		   `+attachmentUploaderJoins+`
		  WHERE attachment.run_id = $1
		    AND attachment.state = 'ready'
		    AND (NOT $2::boolean OR
		         (attachment.created_at, attachment.id) > ($3::timestamptz, $4::uuid))
		  ORDER BY attachment.created_at ASC, attachment.id ASC
		  LIMIT $5`,
		runID, afterEnabled, afterTime, afterID, limit,
	)
	if err != nil {
		return nil, attachmentOperationError("list run artifacts", err)
	}
	defer rows.Close()

	artifacts := make([]Attachment, 0, limit)
	for rows.Next() {
		artifact, err := scanAttachment(rows)
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
// it. Requiring both ids means a stray attachment id cannot be activated
// through this path — it must belong to the run being promoted.
func (repository *Repository) ActivateRunArtifact(
	ctx context.Context,
	runID, attachmentID, eventID uuid.UUID,
	readyAt time.Time,
) (Attachment, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Attachment{}, Event{}, errors.New("begin run artifact activation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var workspaceID, boardID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		// Deliberately not filtered on issue.deleted_at: this resolves the
		// workspace for an upload that already succeeded. Refusing here because
		// the issue was deleted mid-promotion would strand a pending row that
		// promises bytes the store already holds, and the artifact is hidden
		// with its issue regardless.
		`UPDATE attachments AS attachment
		    SET state = 'ready', ready_at = $3
		   FROM issues AS issue, boards AS board
		  WHERE attachment.id = $1
		    AND attachment.run_id = $2
		    AND attachment.state = 'pending'
		    AND issue.id = attachment.issue_id
		    AND board.id = issue.board_id
		 RETURNING board.workspace_id, board.id`,
		attachmentID, runID, readyAt.UTC(),
	).Scan(&workspaceID, &boardID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Either it was already activated or it is not this run's to
			// activate. Both are refusals rather than faults: promotion retries.
			return Attachment{}, Event{}, ErrNotFound
		}
		return Attachment{}, Event{}, classifyWriteError("activate run artifact", err)
	}

	artifact, err := scanAttachment(tx.QueryRow(
		ctx,
		`SELECT `+attachmentProjection+`
		   FROM attachments AS attachment
		   JOIN issues AS issue ON issue.id = attachment.issue_id
		   JOIN boards AS board ON board.id = issue.board_id
		   `+attachmentUploaderJoins+`
		  WHERE attachment.id = $1`,
		attachmentID,
	))
	if err != nil {
		return Attachment{}, Event{}, classifyReadError("read activated run artifact", err)
	}

	event, err := makeEvent(
		eventID,
		workspaceID,
		boardID,
		"attachment.created",
		"attachment",
		artifact.ID,
		attachmentEventPayload(artifact),
		readyAt,
	)
	if err != nil {
		return Attachment{}, Event{}, err
	}
	if err := insertOutboxEvent(ctx, tx, event); err != nil {
		return Attachment{}, Event{}, err
	}
	// The same fact under the name workflows subscribe to: a run produced a
	// deliverable. attachment.created stays for the issue views; the artifact
	// aggregate is what a berry.artifact_created trigger names. The id is
	// derived from the attachment event's so a replay cannot mint two
	// different second ids for one activation.
	artifactEvent, err := makeEvent(
		uuid.NewSHA1(eventID, []byte("artifact.created")),
		workspaceID,
		boardID,
		"artifact.created",
		"artifact",
		artifact.ID,
		artifactEventPayload{Artifact: attachmentEventPayload(artifact), RunID: runID, IssueID: artifact.IssueID},
		readyAt.Add(time.Microsecond),
	)
	if err != nil {
		return Attachment{}, Event{}, err
	}
	if err := insertOutboxEvent(ctx, tx, artifactEvent); err != nil {
		return Attachment{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Attachment{}, Event{}, errors.New("commit run artifact activation")
	}
	return artifact, event, nil
}

// artifactEventPayload names the run and issue beside the attachment so a
// workflow trigger filter can read them without decoding the resource.
type artifactEventPayload struct {
	Artifact any       `json:"artifact"`
	RunID    uuid.UUID `json:"runId"`
	IssueID  uuid.UUID `json:"issueId"`
}

// AbortRunArtifact removes a reservation whose upload failed.
func (repository *Repository) AbortRunArtifact(
	ctx context.Context,
	runID, attachmentID uuid.UUID,
) error {
	if _, err := repository.Pool.Exec(
		ctx,
		`DELETE FROM attachments
		  WHERE id = $1 AND run_id = $2 AND state = 'pending'`,
		attachmentID, runID,
	); err != nil {
		return classifyWriteError("abort run artifact", err)
	}
	return nil
}
