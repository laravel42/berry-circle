// Package intake selects work that is ready to be handed to an agent.
//
// Berry's continuous intake loop pulls issues in `todo` whose assigned agent is
// available, and hands each one to the durable run orchestration. This package
// owns only the *selection*: the authoritative claim is
// `runs.Repository.Admit`, which locks the issue, rejects a second active run,
// and commits the queued ledger in one transaction.
//
// That split is deliberate. Selection is optimistic and may race — two workers
// can propose the same issue. Admission is authoritative and settles the race
// by returning `*runs.ActiveRunError`, which the caller treats as "someone got
// there first", not as a failure. Trying to make selection itself atomic would
// duplicate the guard that already exists one layer down.
package intake

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository reads intake candidates from the authoritative product tables.
type Repository struct {
	Pool *pgxpool.Pool
}

// New validates the authoritative PostgreSQL dependency.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("intake repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

// Candidate is one issue that is ready to be dispatched to a named agent.
// Every field is a Berry identifier; no upstream agent id appears here, so a
// candidate can be logged without leaking the OpenFang identity space.
type Candidate struct {
	IssueID     uuid.UUID
	WorkspaceID uuid.UUID
	BoardID     uuid.UUID
	AgentID     uuid.UUID
	IssueNumber int32
	IssueTitle  string
	// ViaOrchestrator marks a candidate the built-in orchestrator picked up
	// because its workspace has defined no other agent. Recorded so operators
	// can tell fallback dispatch from a deliberate assignment.
	ViaOrchestrator bool
}

// ActiveRuns counts runs that have not reached a terminal state. The intake
// loop uses this as a spend ceiling: every admitted run costs provider tokens,
// so the cap bounds concurrent cost, not just throughput.
func (repository *Repository) ActiveRuns(ctx context.Context) (int, error) {
	if repository == nil || repository.Pool == nil {
		return 0, errors.New("intake repository is not configured")
	}
	var count int
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT count(*) FROM runs WHERE status IN ('queued', 'running')`,
	).Scan(&count); err != nil {
		return 0, errors.New("count active runs")
	}
	return count, nil
}

// Candidates returns up to limit issues that are ready for agent dispatch.
//
// An issue qualifies when all of the following hold:
//
//   - it is in `todo` — `backlog` is not yet committed work, and anything
//     further along is either running, awaiting human review, or closed;
//   - it has no active run. `issues.active_run_id` is the durable one-writer
//     guard, so this is what keeps intake from starting a second editor;
//   - it is assigned to an agent whose status is `available`, or its
//     workspace has defined no agent of its own and the built-in orchestrator
//     takes it as fallback.
//
// Intake never invents an assignment when a workspace has real agents to
// choose from: picking which of several agents should do unassigned work is a
// product decision, not a scheduler decision. The orchestrator fallback is
// narrower than that — it applies only when there is nothing to choose between,
// so a fresh deployment can execute an issue with no setup.
//
// Ordering is oldest-first by creation so the backlog drains fairly and a
// single starved issue cannot be overtaken indefinitely.
//
// `FOR UPDATE ... SKIP LOCKED` on the issue rows keeps two concurrent intake
// ticks from proposing the same issue in the common case. It is an efficiency
// measure, not the correctness boundary — `Admit` remains that.
func (repository *Repository) Candidates(
	ctx context.Context,
	limit int,
) ([]Candidate, error) {
	if repository == nil || repository.Pool == nil {
		return nil, errors.New("intake repository is not configured")
	}
	if limit < 1 || limit > 500 {
		return nil, errors.New("intake candidate limit is invalid")
	}
	rows, err := repository.Pool.Query(
		ctx,
		`WITH ready AS (
		    SELECT issue.id, issue.board_id, issue.number, issue.title,
		           issue.assignee_type::text AS assignee_type,
		           issue.assignee_id,
		           board.workspace_id,
		           issue.created_at
		      FROM issues AS issue
		      JOIN boards AS board ON board.id = issue.board_id
		     WHERE issue.status = 'todo'
		       AND issue.active_run_id IS NULL
		     ORDER BY issue.created_at ASC, issue.id ASC
		     FOR UPDATE OF issue SKIP LOCKED
		     LIMIT $1
		 ),
		 -- A workspace "has its own agents" when it has any usable agent that
		 -- is not the built-in orchestrator. While that is true the fallback
		 -- stays off, so adding one real agent immediately stops the
		 -- orchestrator from claiming unassigned work.
		 owned AS (
		    SELECT DISTINCT workspace_id
		      FROM agents
		     WHERE NOT protected
		       AND archived_at IS NULL
		       AND workspace_id IS NOT NULL
		 )
		 SELECT ready.id, ready.workspace_id, ready.board_id,
		        agent.id, ready.number, ready.title, agent.protected
		   FROM ready
		   JOIN agents AS agent
		     ON agent.archived_at IS NULL
		    AND agent.status = 'available'
		    AND (agent.board_id IS NULL OR agent.board_id = ready.board_id)
		    AND (
		          (
		            ready.assignee_type = 'agent'
		            AND agent.id = ready.assignee_id
		          )
		       OR (
		            ready.assignee_id IS NULL
		            AND agent.protected
		            AND agent.workspace_id = ready.workspace_id
		            AND ready.workspace_id NOT IN (SELECT workspace_id FROM owned)
		          )
		        )
		  ORDER BY ready.created_at ASC, ready.id ASC`,
		limit,
	)
	if err != nil {
		return nil, errors.New("select intake candidates")
	}
	defer rows.Close()

	candidates := make([]Candidate, 0, limit)
	for rows.Next() {
		var candidate Candidate
		if err := rows.Scan(
			&candidate.IssueID,
			&candidate.WorkspaceID,
			&candidate.BoardID,
			&candidate.AgentID,
			&candidate.IssueNumber,
			&candidate.IssueTitle,
			&candidate.ViaOrchestrator,
		); err != nil {
			return nil, errors.New("scan intake candidate")
		}
		candidates = append(candidates, candidate)
	}
	if rows.Err() != nil {
		return nil, errors.New("read intake candidates")
	}
	return candidates, nil
}

// MarkInProgress advances an issue to `in_progress` once its run is admitted.
//
// The documented lifecycle is backlog → todo → in_progress → in_review → done,
// but nothing on the run path writes `in_progress` today: `Admit` only sets
// `active_run_id`, and `CompleteSuccess` jumps straight to `in_review`. Intake
// is the component that starts the work, so it is the honest place to record
// that the work started — without it a board shows an issue as `todo` while an
// agent is actively editing.
//
// The update is guarded on `active_run_id` so it can only ever apply to the
// run that intake just admitted, and it is safe to repeat. A failure here is
// not fatal to the run: the run is already durable, and the worst case is a
// stale board cell that the next terminal transition corrects.
//
// Note the deliberate asymmetry: a run that fails leaves its issue in
// `in_progress` with no active run, which surfaces to a human rather than
// silently returning to the intake pool. Automatic retry is a product decision
// (see the group failure policy question in the Temporal plan), not a default.
func (repository *Repository) MarkInProgress(
	ctx context.Context,
	issueID, runID uuid.UUID,
) error {
	if repository == nil || repository.Pool == nil {
		return errors.New("intake repository is not configured")
	}
	if issueID == uuid.Nil || runID == uuid.Nil {
		return errors.New("intake progress parameters are invalid")
	}
	if _, err := repository.Pool.Exec(
		ctx,
		`UPDATE issues
		    SET status = 'in_progress', updated_at = now()
		  WHERE id = $1 AND active_run_id = $2 AND status = 'todo'`,
		issueID,
		runID,
	); err != nil {
		return errors.New("advance issue to in_progress")
	}
	return nil
}
