package orchestration

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EnsureLocalOrchestrators against a real PostgreSQL. The behaviour worth
// testing is the trigger's leftovers: migration 009 inserts the row as
// `unknown` with no model, which is correct when OpenFang provisions it and
// leaves it unrunnable when nobody does.

func localPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("ORCHESTRATION_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("ORCHESTRATION_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

// localWorkspace creates a workspace, which gets its protected Orchestrator by
// trigger, and removes it afterwards.
func localWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	userID := uuid.New()
	suffix := uuid.New().String()[:8]
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO users (id, email, name) VALUES ($1, $2, 'Bootstrap Test')`,
		userID, "bootstrap-"+suffix+"@berry.test",
	); err != nil {
		t.Fatalf("create user: %v", err)
	}
	workspaceID := uuid.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspaces (id, name, slug, settings, created_by)
		 VALUES ($1, $2, $3, '{"issuePrefix":"BST","defaultRole":"member","allowMemberInvites":false}'::jsonb, $4)`,
		workspaceID, "Bootstrap "+suffix, "bootstrap-"+suffix, userID,
	); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	t.Cleanup(func() {
		clean := context.Background()
		// The protected agent refuses deletion, deliberately, so the guard is
		// suspended for this fixture's own teardown and nowhere else.
		_, _ = pool.Exec(clean, `ALTER TABLE agents DISABLE TRIGGER berry_agents_block_protected_delete`)
		_, _ = pool.Exec(clean, `DELETE FROM agents WHERE workspace_id = $1`, workspaceID)
		_, _ = pool.Exec(clean, `ALTER TABLE agents ENABLE TRIGGER berry_agents_block_protected_delete`)
		_, _ = pool.Exec(clean, `DELETE FROM workspace_memberships WHERE workspace_id = $1`, workspaceID)
		_, _ = pool.Exec(clean, `DELETE FROM workspaces WHERE id = $1`, workspaceID)
		_, _ = pool.Exec(clean, `DELETE FROM users WHERE id = $1`, userID)
	})
	return workspaceID
}

func readOrchestrator(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspaceID uuid.UUID) (string, *string, *string) {
	t.Helper()
	var status string
	var provider, model *string
	if err := pool.QueryRow(
		ctx,
		`SELECT status, model_provider, model_name FROM agents
		  WHERE workspace_id = $1 AND protected`,
		workspaceID,
	).Scan(&status, &provider, &model); err != nil {
		t.Fatalf("read orchestrator: %v", err)
	}
	return status, provider, model
}

func TestLocalOrchestratorBecomesRunnable(t *testing.T) {
	ctx, pool := localPool(t)
	workspaceID := localWorkspace(t, ctx, pool)

	// As the trigger leaves it: intake skips any agent that is not available,
	// so this workspace has no fallback at all until something says otherwise.
	status, _, model := readOrchestrator(t, ctx, pool, workspaceID)
	if status != "unknown" || model != nil {
		t.Fatalf("fixture: status = %q model = %v, want unknown and no model", status, model)
	}

	spec := OrchestratorSpec{Provider: "openrouter", Model: "anthropic/claude-sonnet-4.5"}
	if err := EnsureLocalOrchestrators(ctx, pool, spec, slog.Default()); err != nil {
		t.Fatalf("EnsureLocalOrchestrators() error = %v", err)
	}

	status, provider, model := readOrchestrator(t, ctx, pool, workspaceID)
	if status != "available" {
		t.Errorf("status = %q, want available", status)
	}
	if provider == nil || *provider != spec.Provider {
		t.Errorf("provider = %v, want %s", provider, spec.Provider)
	}
	if model == nil || *model != spec.Model {
		t.Errorf("model = %v, want %s", model, spec.Model)
	}
}

func TestLocalOrchestratorKeepsAModelSomebodyChose(t *testing.T) {
	ctx, pool := localPool(t)
	workspaceID := localWorkspace(t, ctx, pool)

	if _, err := pool.Exec(
		ctx,
		`UPDATE agents SET model_provider = 'openrouter', model_name = 'openai/gpt-5'
		  WHERE workspace_id = $1 AND protected`,
		workspaceID,
	); err != nil {
		t.Fatalf("configure orchestrator: %v", err)
	}

	if err := EnsureLocalOrchestrators(
		ctx, pool,
		OrchestratorSpec{Provider: "openrouter", Model: "anthropic/claude-sonnet-4.5"},
		slog.Default(),
	); err != nil {
		t.Fatalf("EnsureLocalOrchestrators() error = %v", err)
	}

	// An operator who configured a model for one workspace chose it, and a
	// boot must not quietly replace it with the deployment default.
	status, _, model := readOrchestrator(t, ctx, pool, workspaceID)
	if model == nil || *model != "openai/gpt-5" {
		t.Errorf("model = %v, want the configured openai/gpt-5", model)
	}
	if status != "available" {
		t.Errorf("status = %q, want available", status)
	}
}

func TestLocalOrchestratorSkippedWithoutAModel(t *testing.T) {
	ctx, pool := localPool(t)
	workspaceID := localWorkspace(t, ctx, pool)

	// Berry does not pick an LLM for an operator. Without one configured the
	// orchestrator stays unrunnable, which is visible, rather than being
	// pointed at a model nobody chose.
	if err := EnsureLocalOrchestrators(ctx, pool, OrchestratorSpec{}, slog.Default()); err != nil {
		t.Fatalf("EnsureLocalOrchestrators() error = %v", err)
	}
	status, _, model := readOrchestrator(t, ctx, pool, workspaceID)
	if status != "unknown" || model != nil {
		t.Errorf("status = %q model = %v, want the row untouched", status, model)
	}
}
