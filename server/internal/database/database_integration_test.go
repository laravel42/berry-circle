package database

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestExternalDatabasePing(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := Open(ctx, databaseURL, "berry-server-test")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer pool.Close()
}
