package cache

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestExternalValkeyPing(t *testing.T) {
	if os.Getenv("VALKEY_ENABLED") != "true" {
		t.Skip("VALKEY_ENABLED is not true")
	}
	valkeyURL := os.Getenv("VALKEY_URL")
	if valkeyURL == "" {
		t.Skip("VALKEY_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := Open(ctx, valkeyURL)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer client.Close()
}
