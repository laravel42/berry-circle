package cache

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"
)

func TestNewKeyUsesVersionedBerryNamespace(t *testing.T) {
	t.Parallel()

	key, err := NewKey("issues", "workspace-1", "board-1")
	if err != nil {
		t.Fatalf("NewKey() error = %v", err)
	}
	if key != "berry:issues:v1:workspace-1:board-1" {
		t.Fatalf("key = %q, want versioned Berry namespace", key)
	}
	if _, err := NewKey("issues", "../escape"); err == nil {
		t.Fatal("NewKey() accepted an unsafe component")
	}
}

type failingStore struct{}

func (failingStore) Get(context.Context, Key) ([]byte, error) {
	return nil, errors.New("unavailable")
}

func (failingStore) Set(context.Context, Key, []byte, time.Duration) error {
	return errors.New("unavailable")
}

func (failingStore) Delete(context.Context, Key) error {
	return errors.New("unavailable")
}

func TestFailOpenConvertsOptionalFailuresToMisses(t *testing.T) {
	t.Parallel()

	cache := FailOpen{
		Backend: failingStore{},
		Enabled: true,
		Logger:  slog.New(slog.DiscardHandler),
	}
	key, _ := NewKey("issues", "workspace-1")
	if _, err := cache.Get(context.Background(), key); !errors.Is(err, ErrMiss) {
		t.Fatalf("Get() error = %v, want ErrMiss", err)
	}
	if err := cache.Set(context.Background(), key, []byte("value"), time.Minute); err != nil {
		t.Fatalf("Set() error = %v, want fail-open nil", err)
	}
	if err := cache.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete() error = %v, want fail-open nil", err)
	}
}
