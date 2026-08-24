package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalPutOpenAndAtomicReplacement(t *testing.T) {
	t.Parallel()

	local, err := NewLocal(t.TempDir(), 1024)
	if err != nil {
		t.Fatalf("NewLocal() error = %v", err)
	}
	ctx := context.Background()
	if _, err := local.Put(ctx, "workspace/object.txt", strings.NewReader("first")); err != nil {
		t.Fatalf("Put(first) error = %v", err)
	}
	object, err := local.Put(ctx, "workspace/object.txt", strings.NewReader("second"))
	if err != nil {
		t.Fatalf("Put(second) error = %v", err)
	}
	if object.Size != int64(len("second")) {
		t.Errorf("Object.Size = %d, want %d", object.Size, len("second"))
	}
	file, err := local.Open(ctx, "workspace/object.txt")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer file.Close()
	body, err := io.ReadAll(file)
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if string(body) != "second" {
		t.Fatalf("stored body = %q, want second", body)
	}
}

func TestLocalRejectsTraversalAndOversizedObjects(t *testing.T) {
	t.Parallel()

	local, err := NewLocal(t.TempDir(), 4)
	if err != nil {
		t.Fatalf("NewLocal() error = %v", err)
	}
	for _, key := range []string{"../escape", "/absolute", "a/../../escape", `a\escape`, "a//b"} {
		if _, err := local.Put(context.Background(), key, strings.NewReader("x")); err == nil {
			t.Errorf("Put(%q) accepted an unsafe key", key)
		}
	}
	if _, err := local.Put(
		context.Background(),
		"too-large",
		strings.NewReader("12345"),
	); err == nil {
		t.Fatal("Put() accepted an oversized object")
	}
}

func TestLocalRejectsSymlinkComponents(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	local, err := NewLocal(root, 1024)
	if err != nil {
		t.Fatalf("NewLocal() error = %v", err)
	}
	if _, err := local.Put(
		context.Background(),
		"linked/escape",
		strings.NewReader("unsafe"),
	); err == nil {
		t.Fatal("Put() followed a symlink component")
	}
	if _, err := os.Stat(filepath.Join(outside, "escape")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("outside object exists or stat failed unexpectedly: %v", err)
	}
}

func TestFactoryDefaultsToLocalAndValidatesS3(t *testing.T) {
	t.Parallel()

	backend, err := New(Config{LocalRoot: t.TempDir(), MaxBytes: 1024})
	if err != nil {
		t.Fatalf("New(default) error = %v", err)
	}
	if _, ok := backend.(*Local); !ok {
		t.Fatalf("New(default) type = %T, want *Local", backend)
	}
	_, err = New(Config{Backend: "s3", MaxBytes: 1024})
	if err == nil || !strings.Contains(err.Error(), "S3_BUCKET") {
		t.Fatalf("New(incomplete s3) error = %v, want S3_BUCKET validation", err)
	}
}
