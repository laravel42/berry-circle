package artifacts

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/storage"
)

var runStart = time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)

// fakeStore records what the promoter asked persistence to do.
type fakeStore struct {
	reserved   []collaboration.ReserveRunArtifactParams
	activated  []uuid.UUID
	aborted    []uuid.UUID
	existing   []collaboration.Attachment
	reserveErr error
}

func (store *fakeStore) ReserveRunArtifact(
	_ context.Context, params collaboration.ReserveRunArtifactParams,
) (collaboration.Attachment, error) {
	if store.reserveErr != nil {
		return collaboration.Attachment{}, store.reserveErr
	}
	store.reserved = append(store.reserved, params)
	return collaboration.Attachment{
		ID:         params.ID,
		FileName:   params.FileName,
		StorageKey: "artifacts/ws/run/" + params.ID.String(),
	}, nil
}

func (store *fakeStore) ActivateRunArtifact(
	_ context.Context, _ uuid.UUID, attachmentID uuid.UUID, _ uuid.UUID, _ time.Time,
) (collaboration.Attachment, collaboration.Event, error) {
	store.activated = append(store.activated, attachmentID)
	return collaboration.Attachment{ID: attachmentID}, collaboration.Event{}, nil
}

func (store *fakeStore) AbortRunArtifact(_ context.Context, _ uuid.UUID, attachmentID uuid.UUID) error {
	store.aborted = append(store.aborted, attachmentID)
	return nil
}

func (store *fakeStore) ListRunArtifacts(
	context.Context, uuid.UUID, *collaboration.AttachmentCursor, int,
) ([]collaboration.Attachment, error) {
	return store.existing, nil
}

// fakeStorage captures object writes.
type fakeStorage struct {
	objects map[string][]byte
	putErr  error
}

func newFakeStorage() *fakeStorage {
	return &fakeStorage{objects: map[string][]byte{}}
}

func (backend *fakeStorage) Put(_ context.Context, key string, body io.Reader) (storage.Object, error) {
	if backend.putErr != nil {
		return storage.Object{}, backend.putErr
	}
	buffer, err := io.ReadAll(body)
	if err != nil {
		return storage.Object{}, err
	}
	backend.objects[key] = buffer
	return storage.Object{Key: key, Size: int64(len(buffer))}, nil
}

func (backend *fakeStorage) Open(context.Context, string) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(nil)), nil
}

func (backend *fakeStorage) Delete(context.Context, string) error { return nil }

// workspace builds a runtime volume containing one agent's output directory.
func workspace(t *testing.T, agent string, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	output := filepath.Join(root, agent, outputDirectory)
	if err := os.MkdirAll(output, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for name, body := range files {
		path := filepath.Join(output, name)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		if err := os.Chtimes(path, runStart.Add(time.Minute), runStart.Add(time.Minute)); err != nil {
			t.Fatalf("chtimes %s: %v", name, err)
		}
	}
	return root
}

func newPromoter(root string, store Store, backend storage.Backend) *Promoter {
	return &Promoter{
		Root: root, Store: store, Storage: backend,
		MaxBytes: 1 << 20,
		Clock:    func() time.Time { return runStart },
		NewID:    uuid.New,
	}
}

func runContext(agent string) RunContext {
	return RunContext{
		RunID:       uuid.New(),
		AgentSlug:   agent,
		StartedAt:   runStart,
		CompletedAt: runStart.Add(5 * time.Minute),
	}
}

func TestPromoteCopiesOutputIntoTheStore(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{
		"blog.md":   "# AI Agents in 2026",
		"notes.txt": "sources",
	})
	store, backend := &fakeStore{}, newFakeStorage()
	promoter := newPromoter(root, store, backend)

	result, err := promoter.Promote(context.Background(), runContext("writer"))
	if err != nil {
		t.Fatalf("Promote: %v", err)
	}
	if len(result.Promoted) != 2 {
		t.Fatalf("promoted %v, want both files", result.Promoted)
	}
	if len(store.reserved) != 2 || len(store.activated) != 2 {
		t.Fatalf("reserved %d, activated %d; want 2 and 2",
			len(store.reserved), len(store.activated))
	}
	if len(backend.objects) != 2 {
		t.Fatalf("stored %d objects, want 2", len(backend.objects))
	}
	// The bytes must be the file's, not an empty stream: the checksum pass
	// reads the handle to the end, so a missing rewind would store nothing.
	for key, body := range backend.objects {
		if len(body) == 0 {
			t.Errorf("object %s was stored empty", key)
		}
	}
	for _, params := range store.reserved {
		if params.SizeBytes == 0 {
			t.Errorf("%s reserved with a zero size", params.FileName)
		}
		if params.ChecksumSHA256 == [32]byte{} {
			t.Errorf("%s reserved without a checksum", params.FileName)
		}
	}
}

func TestPromoteIgnoresFilesOutsideTheRunWindow(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{"current.md": "now"})
	// A file an earlier run left behind. Promoting it would re-attach previous
	// output to every subsequent run on the same agent.
	stale := filepath.Join(root, "writer", outputDirectory, "old.md")
	if err := os.WriteFile(stale, []byte("previous run"), 0o644); err != nil {
		t.Fatalf("write stale: %v", err)
	}
	old := runStart.Add(-48 * time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	store := &fakeStore{}
	promoter := newPromoter(root, store, newFakeStorage())
	result, err := promoter.Promote(context.Background(), runContext("writer"))
	if err != nil {
		t.Fatalf("Promote: %v", err)
	}
	if len(result.Promoted) != 1 || result.Promoted[0] != "current.md" {
		t.Fatalf("promoted %v, want only current.md", result.Promoted)
	}
}

func TestPromoteSkipsWhatItAlreadyPublished(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{"blog.md": "body"})
	store := &fakeStore{existing: []collaboration.Attachment{{FileName: "blog.md"}}}
	promoter := newPromoter(root, store, newFakeStorage())

	// A retried workflow must not attach the same deliverable twice.
	result, err := promoter.Promote(context.Background(), runContext("writer"))
	if err != nil {
		t.Fatalf("Promote: %v", err)
	}
	if len(result.Promoted) != 0 || len(store.reserved) != 0 {
		t.Fatalf("re-promoted an existing artifact: %v", result.Promoted)
	}
}

func TestPromoteSkipsOversizedFilesWithoutAbandoningTheRest(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{
		"small.md": "ok",
		"huge.md":  strings.Repeat("x", 4096),
	})
	store := &fakeStore{}
	promoter := newPromoter(root, store, newFakeStorage())
	promoter.MaxBytes = 100

	result, err := promoter.Promote(context.Background(), runContext("writer"))
	if err != nil {
		t.Fatalf("Promote: %v", err)
	}
	if len(result.Promoted) != 1 || result.Promoted[0] != "small.md" {
		t.Fatalf("promoted %v, want the small file only", result.Promoted)
	}
	if len(result.Skipped) != 1 || result.Skipped[0] != "huge.md" {
		t.Fatalf("skipped %v, want the oversized file reported", result.Skipped)
	}
}

func TestFailedUploadRemovesItsReservation(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{"blog.md": "body"})
	store := &fakeStore{}
	backend := newFakeStorage()
	backend.putErr = errors.New("object storage unavailable")
	promoter := newPromoter(root, store, backend)

	result, err := promoter.Promote(context.Background(), runContext("writer"))
	if err != nil {
		t.Fatalf("Promote: %v", err)
	}
	if len(result.Promoted) != 0 {
		t.Fatalf("promoted %v despite a storage failure", result.Promoted)
	}
	// A pending row that will never receive bytes must not survive: it would
	// promise an attachment the store cannot serve.
	if len(store.aborted) != 1 {
		t.Fatalf("aborted %d reservations, want 1", len(store.aborted))
	}
	if len(store.activated) != 0 {
		t.Fatal("a failed upload was activated")
	}
}

func TestPromoteIgnoresDirectoriesDotfilesAndEmptyFiles(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{
		"real.md":  "body",
		".hidden":  "secret",
		"empty.md": "",
	})
	nested := filepath.Join(root, "writer", outputDirectory, "subdir")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	store := &fakeStore{}
	promoter := newPromoter(root, store, newFakeStorage())

	result, err := promoter.Promote(context.Background(), runContext("writer"))
	if err != nil {
		t.Fatalf("Promote: %v", err)
	}
	if len(result.Promoted) != 1 || result.Promoted[0] != "real.md" {
		t.Fatalf("promoted %v, want only real.md", result.Promoted)
	}
}

func TestPromoteRefusesAnAgentNameThatEscapesTheVolume(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{"blog.md": "body"})
	promoter := newPromoter(root, &fakeStore{}, newFakeStorage())

	run := runContext("../../etc")
	if _, err := promoter.Promote(context.Background(), run); err == nil {
		t.Fatal("a traversing agent name was accepted")
	}
}

func TestPromoteIsInertWithoutAMountedVolume(t *testing.T) {
	t.Parallel()
	promoter := &Promoter{Store: &fakeStore{}, Storage: newFakeStorage()}
	if promoter.Enabled() {
		t.Fatal("promotion reports enabled with no root")
	}
	result, err := promoter.Promote(context.Background(), runContext("writer"))
	if err != nil {
		t.Fatalf("Promote without a root should be a no-op: %v", err)
	}
	if len(result.Promoted) != 0 {
		t.Fatal("promoted something with no volume configured")
	}
}

func TestAgentAuthoredContentIsNeverServedAsRenderableHTML(t *testing.T) {
	t.Parallel()
	// An artifact is untrusted content written by a model. Serving it with a
	// renderable type would make it a stored cross-site script.
	for _, name := range []string{"page.html", "vector.svg", "doc.htm", "data.xml"} {
		if got := contentTypeFor(name); got != "application/octet-stream" {
			t.Errorf("contentTypeFor(%q) = %q, want octet-stream", name, got)
		}
	}
	if got := contentTypeFor("blog.md"); !strings.HasPrefix(got, "text/markdown") {
		t.Errorf("contentTypeFor(blog.md) = %q", got)
	}
}

// windowNow returns a run whose window brackets real time, which is what a
// freshly created symlink's own timestamp falls inside.
func windowNow(agent string) RunContext {
	now := time.Now().UTC()
	return RunContext{
		RunID:       uuid.New(),
		AgentSlug:   agent,
		StartedAt:   now.Add(-time.Minute),
		CompletedAt: now.Add(time.Minute),
	}
}

func TestASymlinkedFileIsNeverPromoted(t *testing.T) {
	t.Parallel()
	// The agent writing into this directory runs model-authored tool calls and
	// has write access to the volume. A symlink here would be followed on open
	// and promote whatever it points at inside the *worker's* filesystem — its
	// environment, its database URL, its object-storage keys — into an
	// attachment any workspace member can download.
	secret := filepath.Join(t.TempDir(), "worker-environment")
	if err := os.WriteFile(secret, []byte("DATABASE_URL=postgres://berry:pw@db/berry"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	root := workspace(t, "writer", map[string]string{"real.md": "a genuine deliverable"})
	if err := os.Symlink(secret, filepath.Join(root, "writer", outputDirectory, "notes.md")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	store, backend := &fakeStore{}, newFakeStorage()
	promoter := newPromoter(root, store, backend)
	result, err := promoter.Promote(context.Background(), windowNow("writer"))
	if err != nil {
		t.Fatalf("Promote: %v", err)
	}
	for _, name := range result.Promoted {
		if name == "notes.md" {
			t.Fatal("a symlink was promoted")
		}
	}
	for key, body := range backend.objects {
		if strings.Contains(string(body), "DATABASE_URL") {
			t.Fatalf("out-of-workspace bytes stored at %s", key)
		}
	}
}

func TestASymlinkedOutputDirectoryIsRefused(t *testing.T) {
	t.Parallel()
	// The agent owns every component of its workspace path, so linking the
	// output directory itself would walk somewhere else entirely.
	elsewhere := t.TempDir()
	if err := os.WriteFile(filepath.Join(elsewhere, "stolen.md"), []byte("not ours"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "writer"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(root, "writer", outputDirectory)); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	store, backend := &fakeStore{}, newFakeStorage()
	promoter := newPromoter(root, store, backend)
	if _, err := promoter.Promote(context.Background(), windowNow("writer")); err == nil {
		t.Fatal("a symlinked output directory was walked")
	}
	if len(backend.objects) != 0 {
		t.Fatal("objects were stored from outside the volume")
	}
}

func TestNonRegularFilesAreNotDeliverables(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{"real.md": "ok"})
	output := filepath.Join(root, "writer", outputDirectory)
	// A FIFO would block the reader forever if it were opened.
	if err := syscall.Mkfifo(filepath.Join(output, "pipe.md"), 0o644); err != nil {
		t.Skipf("mkfifo unavailable: %v", err)
	}

	store := &fakeStore{}
	promoter := newPromoter(root, store, newFakeStorage())
	result, err := promoter.Promote(context.Background(), windowNow("writer"))
	if err != nil {
		t.Fatalf("Promote: %v", err)
	}
	for _, name := range result.Promoted {
		if name == "pipe.md" {
			t.Fatal("a FIFO was promoted")
		}
	}
}
