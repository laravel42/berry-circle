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

// fakePending stands in for the runs a recovery pass would reconsider.
type fakePending struct {
	pending []uuid.UUID
	runs    map[uuid.UUID]RunContext
	skipped map[uuid.UUID]bool
}

func (source *fakePending) RunsAwaitingPromotion(
	context.Context, time.Time, int,
) ([]uuid.UUID, error) {
	return source.pending, nil
}

func (source *fakePending) PromotableRunContext(
	_ context.Context, runID uuid.UUID,
) (RunContext, bool, error) {
	if source.skipped[runID] {
		return RunContext{}, false, nil
	}
	run, ok := source.runs[runID]
	return run, ok, nil
}

func TestRecoverPublishesOutputAnEarlierRunLeftBehind(t *testing.T) {
	t.Parallel()
	// The case that motivated this: a run succeeded and wrote a deliverable
	// before promotion existed. No later run will ever claim that file, because
	// each run only promotes files from its own window.
	root := workspace(t, "writer", map[string]string{"blog.md": "# the deliverable"})
	run := runContext("writer")
	source := &fakePending{
		pending: []uuid.UUID{run.RunID},
		runs:    map[uuid.UUID]RunContext{run.RunID: run},
	}
	store, backend := &fakeStore{}, newFakeStorage()
	promoter := newPromoter(root, store, backend)

	recovered, err := Recover(context.Background(), promoter, source, runStart, nil)
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if recovered != 1 {
		t.Fatalf("recovered %d files, want 1", recovered)
	}
	if len(backend.objects) != 1 {
		t.Fatalf("stored %d objects, want 1", len(backend.objects))
	}
}

func TestRecoverSkipsRunsThatDidNotSucceed(t *testing.T) {
	t.Parallel()
	// A failed run may have left a half-written file, and attaching that would
	// present an abandoned draft as a deliverable.
	root := workspace(t, "writer", map[string]string{"partial.md": "half a"})
	run := runContext("writer")
	source := &fakePending{
		pending: []uuid.UUID{run.RunID},
		runs:    map[uuid.UUID]RunContext{run.RunID: run},
		skipped: map[uuid.UUID]bool{run.RunID: true},
	}
	store, backend := &fakeStore{}, newFakeStorage()
	promoter := newPromoter(root, store, backend)

	recovered, err := Recover(context.Background(), promoter, source, runStart, nil)
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if recovered != 0 || len(backend.objects) != 0 {
		t.Fatalf("recovered %d from an ineligible run", recovered)
	}
}

func TestRecoverIsSafeToRepeat(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{"blog.md": "body"})
	run := runContext("writer")
	source := &fakePending{
		pending: []uuid.UUID{run.RunID},
		runs:    map[uuid.UUID]RunContext{run.RunID: run},
	}
	store, backend := &fakeStore{}, newFakeStorage()
	promoter := newPromoter(root, store, backend)

	if _, err := Recover(context.Background(), promoter, source, runStart, nil); err != nil {
		t.Fatalf("first Recover: %v", err)
	}
	// A second pass sees what the first published and must not attach it twice.
	store.existing = []collaboration.Attachment{{FileName: "blog.md"}}
	recovered, err := Recover(context.Background(), promoter, source, runStart, nil)
	if err != nil {
		t.Fatalf("second Recover: %v", err)
	}
	if recovered != 0 {
		t.Fatalf("a repeat pass re-published %d files", recovered)
	}
	if len(store.reserved) != 1 {
		t.Fatalf("reserved %d times across two passes, want 1", len(store.reserved))
	}
}

func TestRecoverIsInertWithoutAPromoter(t *testing.T) {
	t.Parallel()
	recovered, err := Recover(context.Background(), nil, nil, runStart, nil)
	if err != nil || recovered != 0 {
		t.Fatalf("Recover without a promoter = %d, %v", recovered, err)
	}
}

// Delivery has to place files, not just name them: a run that edits
// src/api/handler.go writes output/src/api/handler.go, and the path is the
// whole point. Promotion stays flat — an attachment has a name, not a location.
func TestOutputKeepsThePathTheRunWroteEvenThoughPromotionDoesNot(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{"README.md": "top level"})
	nested := filepath.Join(root, "writer", outputDirectory, "src", "api")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	deep := filepath.Join(nested, "handler.go")
	if err := os.WriteFile(deep, []byte("package api\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Chtimes(deep, runStart.Add(time.Minute), runStart.Add(time.Minute)); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	promoter := newPromoter(root, &fakeStore{}, newFakeStorage())

	produced, err := promoter.Output(runContext("writer"))
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	found := map[string]string{}
	for _, file := range produced {
		found[file.Name] = file.Contents
	}
	if found["src/api/handler.go"] != "package api\n" {
		t.Fatalf("output %v, want src/api/handler.go with its contents", found)
	}
	if _, ok := found["README.md"]; !ok {
		t.Fatalf("output %v, want the top-level file too", found)
	}
}

// The walk lstats, so a symlinked directory is a symlink and never a way out.
func TestOutputWillNotWalkOutOfTheWorkspaceThroughASymlinkedDirectory(t *testing.T) {
	t.Parallel()
	root := workspace(t, "writer", map[string]string{"real.md": "mine"})
	secret := t.TempDir()
	if err := os.WriteFile(filepath.Join(secret, "credentials"), []byte("token"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	link := filepath.Join(root, "writer", outputDirectory, "elsewhere")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	promoter := newPromoter(root, &fakeStore{}, newFakeStorage())

	produced, err := promoter.Output(runContext("writer"))
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	for _, file := range produced {
		if strings.Contains(file.Contents, "token") {
			t.Fatalf("read %s from outside the workspace", file.Name)
		}
	}
}

func TestPromoteContentAttachesStreamedBytesWithoutARuntimeVolume(t *testing.T) {
	store := &fakeStore{}
	backend := newFakeStorage()
	promoter := newPromoter("", store, backend)
	if promoter.Enabled() {
		t.Fatal("Enabled() = true without a runtime root")
	}
	if !promoter.ContentEnabled() {
		t.Fatal("ContentEnabled() = false with a store and storage")
	}
	run := runContext("researcher")
	content := []byte("# Report\n\nfourteen verified channels")
	if err := promoter.PromoteContent(context.Background(), run, "../report.md", content); err == nil {
		t.Fatal("PromoteContent() accepted a path that escapes output/")
	}
	if err := promoter.PromoteContent(context.Background(), run, ".hidden/report.md", content); err == nil {
		t.Fatal("PromoteContent() accepted a hidden path")
	}
	if err := promoter.PromoteContent(context.Background(), run, "notes/report.md", content); err != nil {
		t.Fatalf("PromoteContent() error = %v", err)
	}
	if len(store.reserved) != 1 || store.reserved[0].FileName != "notes/report.md" ||
		store.reserved[0].RunID != run.RunID || store.reserved[0].SizeBytes != int64(len(content)) ||
		store.reserved[0].ContentType != contentTypeFor("report.md") {
		t.Fatalf("reserved = %#v", store.reserved)
	}
	if len(store.activated) != 1 || len(store.aborted) != 0 {
		t.Fatalf("activated = %v aborted = %v, want one activation", store.activated, store.aborted)
	}
	if len(backend.objects) != 1 {
		t.Fatalf("objects = %d, want the content stored once", len(backend.objects))
	}
	for _, stored := range backend.objects {
		if string(stored) != string(content) {
			t.Fatalf("stored bytes = %q", stored)
		}
	}
	if err := promoter.PromoteContent(context.Background(), run, "empty.md", nil); err == nil {
		t.Fatal("PromoteContent() accepted empty content")
	}
	big := make([]byte, promoter.MaxBytes+1)
	if err := promoter.PromoteContent(context.Background(), run, "big.bin", big); err == nil {
		t.Fatal("PromoteContent() accepted content over MaxBytes")
	}
}

func TestPromoteContentAbortsTheReservationWhenStorageFails(t *testing.T) {
	store := &fakeStore{}
	backend := newFakeStorage()
	backend.putErr = errors.New("bucket unavailable")
	promoter := newPromoter("", store, backend)
	err := promoter.PromoteContent(context.Background(), runContext("researcher"), "report.md", []byte("x"))
	if err == nil {
		t.Fatal("PromoteContent() succeeded with failing storage")
	}
	if len(store.reserved) != 1 || len(store.aborted) != 1 || len(store.activated) != 0 {
		t.Fatalf("reserved=%d aborted=%d activated=%d, want the reservation aborted", len(store.reserved), len(store.aborted), len(store.activated))
	}
}
