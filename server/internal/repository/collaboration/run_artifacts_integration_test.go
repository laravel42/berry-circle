package collaboration

import (
	"context"
	"crypto/sha256"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func artifactPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("COLLABORATION_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("COLLABORATION_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

// fixtureRefs are the ids a test needs to reach its artifacts.
type fixtureRefs struct {
	RunID    uuid.UUID
	IssueID  uuid.UUID
	AgentID  uuid.UUID
	UserID   uuid.UUID
	IssueRef string
}

// artifactFixture builds a workspace, board, issue, agent and run for one test.
func artifactFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) fixtureRefs {
	t.Helper()
	user, workspace, board := uuid.New(), uuid.New(), uuid.New()
	issue, agent, run := uuid.New(), uuid.New(), uuid.New()
	slug := "b" + board.String()[:8]

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("fixture: %v", err)
		}
	}
	exec(`INSERT INTO users (id,email,name,role) VALUES ($1,$2,'T','admin')`,
		user, user.String()+"@berry.test")
	exec(`INSERT INTO workspaces (id,name,slug,created_by) VALUES ($1,'W',$2,$3)`,
		workspace, "w"+workspace.String()[:8], user)
	exec(`INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,'admin')`,
		workspace, user)
	exec(`INSERT INTO boards (id,workspace_id,name,slug,created_by) VALUES ($1,$2,'B',$3,$4)`,
		board, workspace, slug, user)
	exec(`INSERT INTO agents (id,workspace_id,openfang_agent_id,name,status)
	      VALUES ($1,$2,gen_random_uuid(),'writer','available')`, agent, workspace)
	exec(`INSERT INTO issues (id,board_id,number,title,status,priority,sort_order,created_by)
	      VALUES ($1,$2,1,'Blog','todo','urgent',1000,$3)`, issue, board, user)
	// completed_at is required for a terminal status, which is the state a
	// promoted artifact belongs to: a run only offers outputs once it is done.
	exec(`INSERT INTO runs (id,issue_id,board_id,agent_id,status,sequence,completed_at)
	      VALUES ($1,$2,$3,$4,'succeeded',1,now())`, run, issue, board, agent)

	return fixtureRefs{
		RunID: run, IssueID: issue, AgentID: agent, UserID: user,
		IssueRef: strings.ToUpper(slug) + "-1",
	}
}

func reserveAndActivate(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	runID uuid.UUID,
	name string,
	body []byte,
	at time.Time,
) Attachment {
	t.Helper()
	artifact, err := repository.ReserveRunArtifact(ctx, ReserveRunArtifactParams{
		ID:             uuid.New(),
		RunID:          runID,
		FileName:       name,
		ContentType:    "text/markdown",
		SizeBytes:      int64(len(body)),
		ChecksumSHA256: sha256.Sum256(body),
		CreatedAt:      at,
	})
	if err != nil {
		t.Fatalf("ReserveRunArtifact(%s): %v", name, err)
	}
	ready, _, err := repository.ActivateRunArtifact(ctx, runID, artifact.ID, uuid.New(), at)
	if err != nil {
		t.Fatalf("ActivateRunArtifact(%s): %v", name, err)
	}
	return ready
}

func TestRunArtifactIsAttributedToTheAgentThatProducedIt(t *testing.T) {
	ctx, pool := artifactPool(t)
	repository := &Repository{Pool: pool}
	fixture := artifactFixture(t, ctx, pool)
	now := time.Now().UTC()

	artifact := reserveAndActivate(
		t, ctx, repository, fixture.RunID, "blog.md", []byte("# AI Agents in 2026\n"), now)

	if artifact.UploaderType != "agent" {
		t.Errorf("uploaderType = %q, want agent", artifact.UploaderType)
	}
	if artifact.Uploader == nil || artifact.Uploader.ID != fixture.AgentID {
		t.Errorf("uploader = %+v, want the run's agent", artifact.Uploader)
	}
	if artifact.Uploader != nil && artifact.Uploader.Name != "writer" {
		t.Errorf("uploader name = %q, want the agent's name", artifact.Uploader.Name)
	}
	if artifact.RunID == nil || *artifact.RunID != fixture.RunID {
		t.Errorf("runId = %v, want %s", artifact.RunID, fixture.RunID)
	}
	if artifact.IssueID != fixture.IssueID {
		t.Errorf("issueId = %s, want the run's issue", artifact.IssueID)
	}
	if artifact.State != "ready" {
		t.Errorf("state = %q, want ready", artifact.State)
	}
	// The key states where the artifact belongs: it cannot collide across
	// workspaces, and it names the run that produced it — the thing the
	// runtime's agent-keyed directory could not express.
	want := "artifacts/" + artifact.WorkspaceID.String() + "/" + fixture.RunID.String() + "/"
	if !strings.HasPrefix(artifact.StorageKey, want) {
		t.Errorf("storageKey = %q, want prefix %q", artifact.StorageKey, want)
	}
}

func TestListRunArtifactsAnswersWhatThisRunProduced(t *testing.T) {
	ctx, pool := artifactPool(t)
	repository := &Repository{Pool: pool}
	fixture := artifactFixture(t, ctx, pool)
	other := artifactFixture(t, ctx, pool)
	now := time.Now().UTC()

	reserveAndActivate(t, ctx, repository, fixture.RunID, "first.md", []byte("one"), now)
	reserveAndActivate(t, ctx, repository, fixture.RunID, "second.md", []byte("two"), now.Add(time.Second))
	reserveAndActivate(t, ctx, repository, other.RunID, "elsewhere.md", []byte("three"), now)

	artifacts, err := repository.ListRunArtifacts(ctx, fixture.RunID, nil, 50)
	if err != nil {
		t.Fatalf("ListRunArtifacts: %v", err)
	}
	if len(artifacts) != 2 {
		t.Fatalf("returned %d artifacts, want 2", len(artifacts))
	}
	if artifacts[0].FileName != "first.md" || artifacts[1].FileName != "second.md" {
		t.Errorf("order = %q, %q; want oldest first", artifacts[0].FileName, artifacts[1].FileName)
	}
	for _, artifact := range artifacts {
		if artifact.FileName == "elsewhere.md" {
			t.Fatal("another run's artifact leaked into this run's list")
		}
	}
}

func TestRunArtifactsAppearAmongTheIssuesAttachments(t *testing.T) {
	ctx, pool := artifactPool(t)
	repository := &Repository{Pool: pool}
	fixture := artifactFixture(t, ctx, pool)
	now := time.Now().UTC()

	reserveAndActivate(t, ctx, repository, fixture.RunID, "report.md", []byte("body"), now)

	// One store and one ledger: an agent's output is listed by the same query
	// that lists a person's upload, which is the point of extending attachments
	// rather than building a parallel table.
	attachments, err := repository.ListIssueAttachments(
		ctx, fixture.UserID, fixture.IssueRef, nil, nil, 50)
	if err != nil {
		t.Fatalf("ListIssueAttachments: %v", err)
	}
	if len(attachments) != 1 {
		t.Fatalf("issue listed %d attachments, want the run's artifact", len(attachments))
	}
	if attachments[0].UploaderType != "agent" {
		t.Errorf("uploaderType = %q, want the agent kind preserved", attachments[0].UploaderType)
	}
	if attachments[0].Uploader == nil || attachments[0].Uploader.Name != "writer" {
		t.Errorf("uploader = %+v, want the agent resolved by name", attachments[0].Uploader)
	}
}

func TestActivatingAnArtifactRequiresItsOwnRun(t *testing.T) {
	ctx, pool := artifactPool(t)
	repository := &Repository{Pool: pool}
	fixture := artifactFixture(t, ctx, pool)
	other := artifactFixture(t, ctx, pool)
	now := time.Now().UTC()

	artifact, err := repository.ReserveRunArtifact(ctx, ReserveRunArtifactParams{
		ID: uuid.New(), RunID: fixture.RunID, FileName: "x.md",
		ContentType: "text/markdown", SizeBytes: 1,
		ChecksumSHA256: sha256.Sum256([]byte("x")), CreatedAt: now,
	})
	if err != nil {
		t.Fatalf("ReserveRunArtifact: %v", err)
	}

	// A different run must not be able to publish it.
	if _, _, err := repository.ActivateRunArtifact(
		ctx, other.RunID, artifact.ID, uuid.New(), now); err == nil {
		t.Fatal("another run activated an artifact that was not its own")
	}
	if _, _, err := repository.ActivateRunArtifact(
		ctx, fixture.RunID, artifact.ID, uuid.New(), now); err != nil {
		t.Fatalf("owning run could not activate: %v", err)
	}
	// Activation happens once: a retry after success must not re-publish.
	if _, _, err := repository.ActivateRunArtifact(
		ctx, fixture.RunID, artifact.ID, uuid.New(), now); err == nil {
		t.Fatal("a second activation succeeded")
	}
}

func TestAbortedArtifactNeverBecomesVisible(t *testing.T) {
	ctx, pool := artifactPool(t)
	repository := &Repository{Pool: pool}
	fixture := artifactFixture(t, ctx, pool)
	now := time.Now().UTC()

	artifact, err := repository.ReserveRunArtifact(ctx, ReserveRunArtifactParams{
		ID: uuid.New(), RunID: fixture.RunID, FileName: "half.md",
		ContentType: "text/markdown", SizeBytes: 9,
		ChecksumSHA256: sha256.Sum256([]byte("half")), CreatedAt: now,
	})
	if err != nil {
		t.Fatalf("ReserveRunArtifact: %v", err)
	}
	if err := repository.AbortRunArtifact(ctx, fixture.RunID, artifact.ID); err != nil {
		t.Fatalf("AbortRunArtifact: %v", err)
	}

	artifacts, err := repository.ListRunArtifacts(ctx, fixture.RunID, nil, 50)
	if err != nil {
		t.Fatalf("ListRunArtifacts: %v", err)
	}
	if len(artifacts) != 0 {
		t.Fatalf("an aborted upload is listed: %+v", artifacts)
	}
}
