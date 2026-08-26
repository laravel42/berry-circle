package approvals

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/identity"
)

type fixture struct {
	pool        *pgxpool.Pool
	now         time.Time
	userID      uuid.UUID
	workspaceID uuid.UUID
	boardID     uuid.UUID
	issueID     uuid.UUID
}

func seed(t *testing.T, ctx context.Context) (*Repository, fixture) {
	t.Helper()
	databaseURL := os.Getenv("BERRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BERRY_TEST_DATABASE_URL is not configured")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open BERRY_TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	seeded := fixture{
		pool: pool, now: time.Date(2026, time.August, 25, 15, 0, 0, 0, time.UTC),
		userID: uuid.New(), workspaceID: uuid.New(), boardID: uuid.New(), issueID: uuid.New(),
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, seeded.workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, seeded.userID)
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, 'Approvals', 'member', $3, $3)`,
		seeded.userID, fmt.Sprintf("%s@berry.test", seeded.userID), seeded.now)
	exec(`INSERT INTO workspaces (id, name, slug, created_by, created_at, updated_at) VALUES ($1, 'Approvals', $2, $3, $4, $4)`,
		seeded.workspaceID, "appr-"+seeded.workspaceID.String()[:8], seeded.userID, seeded.now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'admin', $3, $3)`,
		seeded.workspaceID, seeded.userID, seeded.now)
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by, created_at, updated_at) VALUES ($1, $2, 'Approvals', $3, $4, $5, $5)`,
		seeded.boardID, seeded.workspaceID, "b"+seeded.boardID.String()[:8], seeded.userID, seeded.now)
	exec(`INSERT INTO issues (id, board_id, number, title, status, priority, sort_order, created_by, created_at, updated_at)
	      VALUES ($1, $2, 1, 'Gated', 'backlog', 'none', 0, $3, $4, $4)`,
		seeded.issueID, seeded.boardID, seeded.userID, seeded.now)
	repository, err := New(pool)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return repository, seeded
}

func sqlState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

// The point of an issue_start gate: while it is pending the database refuses
// todo; approving it is the only thing that releases the issue, and the
// release is one transaction with the decision and both facts.
func TestIssueStartGateBlocksUntilApprovedThenReleasesTheIssue(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	approval, requested, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Kind: KindIssueStart, Title: "Start Gated",
		IssueID: &seeded.issueID, RequestedFromRole: "admin", RequestedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if requested.Type != "approval.requested" || requested.BoardID != seeded.boardID || requested.IssueID != seeded.issueID {
		t.Fatalf("requested event scope = %+v", requested)
	}
	if approval.Issue == nil || approval.Issue.Identifier == "" || approval.Issue.Title != "Gated" {
		t.Fatalf("approval does not name its issue: %+v", approval)
	}
	_, err = seeded.pool.Exec(ctx, `UPDATE issues SET status = 'todo' WHERE id = $1`, seeded.issueID)
	if sqlState(err) != "23001" {
		t.Fatalf("raw todo with a pending gate: %v", err)
	}
	latest, err := repository.LatestForIssue(ctx, seeded.issueID, KindIssueStart)
	if err != nil || latest.ID != approval.ID {
		t.Fatalf("LatestForIssue() = %+v, %v", latest, err)
	}

	resolved, events, err := repository.Resolve(ctx, approval.ID, Resolution{
		Decision: DecisionApproved, Note: "go", ActorID: seeded.userID, Now: seeded.now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if resolved.Status != StatusApproved || resolved.ResolvedBy == nil || *resolved.ResolvedBy != seeded.userID {
		t.Fatalf("resolved = %+v", resolved)
	}
	types := make([]string, 0, len(events))
	for _, event := range events {
		types = append(types, event.Type)
	}
	if len(events) != 2 || events[0].Type != "approval.approved" || events[1].Type != "issue.updated" {
		t.Fatalf("events = %v, want approval.approved then issue.updated", types)
	}
	var status string
	if err := seeded.pool.QueryRow(ctx, `SELECT status::text FROM issues WHERE id = $1`, seeded.issueID).Scan(&status); err != nil || status != "todo" {
		t.Fatalf("issue status after approval = %q (err %v), want todo", status, err)
	}
	if _, _, err := repository.Resolve(ctx, approval.ID, Resolution{
		Decision: DecisionRejected, ActorID: seeded.userID, Now: seeded.now.Add(2 * time.Minute),
	}); !errors.Is(err, ErrAlreadyResolved) {
		t.Fatalf("second Resolve() = %v, want ErrAlreadyResolved", err)
	}
}

// A rejection releases nothing, and one issue holds at most one pending gate.
func TestRejectionKeepsTheIssueGatedAndOnePendingGatePerIssue(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	approval, _, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Kind: KindIssueStart, Title: "Start Gated",
		IssueID: &seeded.issueID, RequestedFromUserID: &seeded.userID, RequestedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, _, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Kind: KindIssueStart, Title: "Again",
		IssueID: &seeded.issueID, RequestedFromRole: "admin", RequestedAt: seeded.now,
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("second pending gate = %v, want ErrConflict", err)
	}
	if _, events, err := repository.Resolve(ctx, approval.ID, Resolution{
		Decision: DecisionRejected, ActorID: seeded.userID, Now: seeded.now.Add(time.Minute),
	}); err != nil || len(events) != 1 || events[0].Type != "approval.rejected" {
		t.Fatalf("Resolve(rejected) = %v events, %v", len(events), err)
	}
	var status string
	if err := seeded.pool.QueryRow(ctx, `SELECT status::text FROM issues WHERE id = $1`, seeded.issueID).Scan(&status); err != nil || status != "backlog" {
		t.Fatalf("issue status after rejection = %q (err %v), want backlog", status, err)
	}
	_, err = seeded.pool.Exec(ctx, `UPDATE issues SET status = 'todo' WHERE id = $1`, seeded.issueID)
	if sqlState(err) != "23001" {
		t.Fatalf("a rejected gate still blocks todo, got %v", err)
	}
}

// Expiry closes overdue approvals and emits the fact a waiting step needs;
// approvals without a deadline wait forever.
func TestExpiryClosesOverdueApprovalsOnly(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	deadline := seeded.now.Add(time.Hour)
	overdue, _, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Kind: KindAutomationStep, Title: "Deploy?",
		RequestedFromRole: "member", RequestedAt: seeded.now, ExpiresAt: &deadline,
	})
	if err != nil {
		t.Fatalf("Create(overdue) error = %v", err)
	}
	forever, _, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Kind: KindPlan, Title: "Start plan",
		RequestedFromRole: "admin", RequestedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("Create(forever) error = %v", err)
	}
	expired, events, err := repository.ExpireDue(ctx, seeded.now.Add(2*time.Hour), 50, nil)
	if err != nil {
		t.Fatalf("ExpireDue() error = %v", err)
	}
	found := false
	for index, approval := range expired {
		if approval.ID == overdue.ID {
			found = true
			if approval.Status != StatusExpired || events[index].Type != "approval.expired" {
				t.Fatalf("expired approval = %+v event = %+v", approval, events[index])
			}
		}
		if approval.ID == forever.ID {
			t.Fatal("an approval without a deadline was expired")
		}
	}
	if !found {
		t.Fatal("the overdue approval was not expired")
	}
	if current, err := repository.Get(ctx, forever.ID); err != nil || current.Status != StatusPending {
		t.Fatalf("forever approval = %+v, %v", current, err)
	}
}

// A member sees what is addressed to them or to members; an admin also sees
// what is addressed to admins; nobody sees another person's approvals.
func TestPendingForFollowsTheAddresseeAndRoleRank(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	otherUser := uuid.New()
	if _, err := seeded.pool.Exec(ctx,
		`INSERT INTO users (id, email, name, role) VALUES ($1, $2, 'Other', 'member')`, otherUser, fmt.Sprintf("%s@berry.test", otherUser)); err != nil {
		t.Fatalf("seed other user: %v", err)
	}
	t.Cleanup(func() { _, _ = seeded.pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, otherUser) })
	create := func(title, role string, user *uuid.UUID) {
		t.Helper()
		if _, _, err := repository.Create(ctx, CreateParams{
			ID: uuid.New(), WorkspaceID: seeded.workspaceID, Kind: KindAutomationStep, Title: title,
			RequestedFromRole: role, RequestedFromUserID: user, RequestedAt: seeded.now,
		}); err != nil {
			t.Fatalf("Create(%s) error = %v", title, err)
		}
	}
	create("mine", "", &seeded.userID)
	create("theirs", "", &otherUser)
	create("members", "member", nil)
	create("admins", "admin", nil)
	titles := func(role identity.Role) map[string]bool {
		t.Helper()
		pending, err := repository.PendingFor(ctx, seeded.workspaceID, seeded.userID, role, 20)
		if err != nil {
			t.Fatalf("PendingFor(%s) error = %v", role, err)
		}
		seen := map[string]bool{}
		for _, approval := range pending {
			seen[approval.Title] = true
		}
		return seen
	}
	asMember := titles(identity.RoleMember)
	if !asMember["mine"] || !asMember["members"] || asMember["admins"] || asMember["theirs"] {
		t.Fatalf("member sees %v", asMember)
	}
	asAdmin := titles(identity.RoleAdmin)
	if !asAdmin["mine"] || !asAdmin["members"] || !asAdmin["admins"] || asAdmin["theirs"] {
		t.Fatalf("admin sees %v", asAdmin)
	}
	listed, err := repository.List(ctx, seeded.workspaceID, ListFilter{Status: StatusPending, Kind: KindAutomationStep}, nil, 10)
	if err != nil || len(listed) != 4 {
		t.Fatalf("List() = %d approvals, %v", len(listed), err)
	}
}
