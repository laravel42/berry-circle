package seed

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestApplyIsIdempotent(t *testing.T) {
	databaseURL := os.Getenv("BERRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BERRY_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open BERRY_TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping BERRY_TEST_DATABASE_URL: %v", err)
	}

	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	if err := Apply(ctx, pool, now); err != nil {
		t.Fatalf("first Apply() error = %v", err)
	}
	if err := Apply(ctx, pool, now); err != nil {
		t.Fatalf("second Apply() error = %v", err)
	}

	var email string
	if err := pool.QueryRow(
		ctx,
		`SELECT email FROM users WHERE id = $1`,
		UserID,
	).Scan(&email); err != nil {
		t.Fatalf("select seeded user: %v", err)
	}
	if email != UserEmail {
		t.Fatalf("email = %q, want %q", email, UserEmail)
	}

	var issueCount int
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM issues WHERE board_id = $1`,
		BoardID,
	).Scan(&issueCount); err != nil {
		t.Fatalf("count seeded issues: %v", err)
	}
	if issueCount < 3 {
		t.Fatalf("issueCount = %d, want at least 3", issueCount)
	}
}
