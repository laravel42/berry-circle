// Package artifacts moves what a run produced out of the runtime's scratch
// space and into Berry's store (ADR-0006).
//
// The runtime writes into /data/workspaces/<agent>, a directory keyed by agent
// rather than by run, on a volume Berry does not own. Files there are not
// product state: nothing references them, nothing scopes them to a workspace,
// and a later run by the same agent can overwrite them. An artifact becomes
// real when it is promoted here and a row exists for it.
package artifacts

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/storage"
)

// outputDirectory is the subdirectory of an agent's workspace that a run's
// deliverables are taken from.
//
// Scoped deliberately rather than promoting the whole workspace: an agent's
// directory also holds its identity files, memory and scratch state, none of
// which are output, and all of which would otherwise be published to an issue.
const outputDirectory = "output"

// maxPromotedFiles bounds one run's promotion.
//
// A runaway agent writing thousands of files must not turn one run into
// thousands of attachments. What is skipped is logged rather than dropped
// silently, because a truncated promotion that looks complete is worse than
// one that says it stopped.
const maxPromotedFiles = 50

// Store is the persistence the promoter needs.
type Store interface {
	ReserveRunArtifact(context.Context, collaboration.ReserveRunArtifactParams) (collaboration.Attachment, error)
	ActivateRunArtifact(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, time.Time) (collaboration.Attachment, collaboration.Event, error)
	AbortRunArtifact(context.Context, uuid.UUID, uuid.UUID) error
	ListRunArtifacts(context.Context, uuid.UUID, *collaboration.AttachmentCursor, int) ([]collaboration.Attachment, error)
}

// RunContext is what the promoter needs to know about a finished run.
type RunContext struct {
	RunID uuid.UUID
	// AgentSlug names the runtime workspace directory. The runtime keys by
	// agent name, not id, which is why this is a slug rather than a uuid.
	AgentSlug string
	// StartedAt and CompletedAt bound which files belong to this run.
	StartedAt   time.Time
	CompletedAt time.Time
}

// Promoter copies a finished run's output into the store.
type Promoter struct {
	// Root is where the runtime's workspaces volume is mounted. Empty disables
	// promotion, so a deployment without the mount degrades to what it did
	// before rather than failing every run.
	Root string
	Store
	Storage storage.Backend
	// MaxBytes caps a single artifact. A file above it is skipped and logged:
	// refusing one oversized file must not abandon the rest of a run's output.
	MaxBytes int64
	Clock    func() time.Time
	NewID    func() uuid.UUID
	Logger   *slog.Logger
}

// Enabled reports whether promotion can run in this deployment.
func (promoter *Promoter) Enabled() bool {
	return promoter != nil && strings.TrimSpace(promoter.Root) != "" &&
		promoter.Store != nil && promoter.Storage != nil
}

// Result summarises one promotion, for logging and tests.
type Result struct {
	Promoted []string
	Skipped  []string
}

// Promote copies every eligible output file into the store.
//
// Errors on a single file do not stop the rest: a run that produced five
// deliverables and one unreadable file should publish five, not none.
func (promoter *Promoter) Promote(ctx context.Context, run RunContext) (Result, error) {
	var result Result
	if !promoter.Enabled() {
		return result, nil
	}
	if run.RunID == uuid.Nil || strings.TrimSpace(run.AgentSlug) == "" {
		return result, errors.New("artifacts: run id and agent are required")
	}

	directory, err := promoter.outputPath(run.AgentSlug)
	if err != nil {
		return result, err
	}
	candidates, err := promoter.candidates(directory, run)
	if err != nil {
		return result, err
	}
	if len(candidates) == 0 {
		return result, nil
	}

	// Already-promoted names are skipped so a retried workflow does not attach
	// the same file twice. Matching on name is enough because the store is
	// scoped to this run.
	existing, err := promoter.ListRunArtifacts(ctx, run.RunID, nil, maxPromotedFiles*2)
	if err != nil {
		return result, fmt.Errorf("artifacts: list existing: %w", err)
	}
	seen := make(map[string]struct{}, len(existing))
	for _, artifact := range existing {
		seen[artifact.FileName] = struct{}{}
	}

	for _, candidate := range candidates {
		if _, done := seen[candidate.name]; done {
			continue
		}
		if len(result.Promoted) >= maxPromotedFiles {
			result.Skipped = append(result.Skipped, candidate.name)
			continue
		}
		if promoter.MaxBytes > 0 && candidate.size > promoter.MaxBytes {
			promoter.logger().Warn("artifact exceeds the size cap and was not promoted",
				"runId", run.RunID, "file", candidate.name,
				"sizeBytes", candidate.size, "maxBytes", promoter.MaxBytes)
			result.Skipped = append(result.Skipped, candidate.name)
			continue
		}
		if err := promoter.promoteOne(ctx, run, candidate); err != nil {
			promoter.logger().Error("artifact promotion failed",
				"runId", run.RunID, "file", candidate.name, "error", err)
			result.Skipped = append(result.Skipped, candidate.name)
			continue
		}
		result.Promoted = append(result.Promoted, candidate.name)
	}
	return result, nil
}

type candidate struct {
	name string
	path string
	size int64
}

// outputPath resolves the agent's output directory inside the mounted volume.
//
// The agent slug reaches this from the database, so the joined path is checked
// to still be under the root: a name containing traversal segments must not be
// able to read outside the runtime volume.
func (promoter *Promoter) outputPath(agentSlug string) (string, error) {
	root, err := filepath.Abs(promoter.Root)
	if err != nil {
		return "", fmt.Errorf("artifacts: resolve root: %w", err)
	}
	joined := filepath.Join(root, agentSlug, outputDirectory)
	resolved, err := filepath.Abs(joined)
	if err != nil {
		return "", fmt.Errorf("artifacts: resolve output path: %w", err)
	}
	if resolved != root && !strings.HasPrefix(resolved, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("artifacts: agent %q resolves outside the runtime volume", agentSlug)
	}
	return resolved, nil
}

// resolveInsideRoot follows symlinks and confirms the result is still within
// the mounted volume.
//
// Both sides are resolved before comparison: on macOS a temporary directory is
// reached through /var, which is itself a link to /private/var, so comparing a
// resolved path against an unresolved root would reject every legitimate path.
func (promoter *Promoter) resolveInsideRoot(path string) (string, error) {
	root, err := filepath.EvalSymlinks(promoter.Root)
	if err != nil {
		return "", fmt.Errorf("artifacts: resolve root: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		// Not-exist is passed through so the caller can treat a missing output
		// directory as "produced nothing" rather than as a failure.
		return "", err
	}
	if resolved != root && !strings.HasPrefix(resolved, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("artifacts: %q resolves outside the runtime volume", path)
	}
	return resolved, nil
}

// candidates lists the files this run is credited with.
//
// The runtime keys workspaces by agent, so two runs by one agent share a
// directory and the filesystem alone cannot say which run wrote what. Modified
// time within the run's window is the available signal. It is a heuristic: a
// file an earlier run wrote and this one merely touched would be attributed
// here. The alternative — promoting everything in the directory — would
// re-attach every previous run's output on every run, which is worse.
func (promoter *Promoter) candidates(directory string, run RunContext) ([]candidate, error) {
	// The lexical check in outputPath cannot see a symlink, and the agent owns
	// every component of this path. Resolving before reading means a workspace
	// whose output/ is a link to somewhere else is refused rather than walked.
	resolved, err := promoter.resolveInsideRoot(directory)
	if errors.Is(err, fs.ErrNotExist) {
		// An agent that produced no files is the common case, not a fault.
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(resolved)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("artifacts: read output directory: %w", err)
	}

	// A generous margin either side: the run's recorded window and the
	// filesystem's clock are not the same clock, and a file written moments
	// before completion is still this run's output.
	const margin = 2 * time.Minute
	from := run.StartedAt.Add(-margin)
	until := run.CompletedAt.Add(margin)

	found := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		// Info is lstat, so a symlink reports as a symlink here rather than as
		// whatever it points at.
		info, err := entry.Info()
		if err != nil {
			continue
		}
		// Regular files only. A symlink would be followed on open and promote
		// whatever it targets in *this* process's filesystem — the worker's
		// environment, its credentials, another workspace's data — and the
		// agent that writes into this directory is running model-authored tool
		// calls. Devices, sockets and FIFOs are refused for the same reason:
		// nothing that is not a plain file is a deliverable.
		if !info.Mode().IsRegular() {
			continue
		}
		if info.Size() == 0 {
			continue
		}
		modified := info.ModTime()
		if modified.Before(from) || modified.After(until) {
			continue
		}
		found = append(found, candidate{
			name: entry.Name(),
			path: filepath.Join(resolved, entry.Name()),
			size: info.Size(),
		})
	}
	sort.Slice(found, func(left, right int) bool {
		return found[left].name < found[right].name
	})
	return found, nil
}

// promoteOne reserves, uploads and activates a single file.
//
// The order matters and mirrors the human upload path: the row is reserved
// pending, the bytes are written, and only then does the row become ready. A
// failure between the two leaves an invisible reservation rather than an
// attachment that promises bytes which are not there.
func (promoter *Promoter) promoteOne(
	ctx context.Context,
	run RunContext,
	file candidate,
) error {
	// O_NOFOLLOW closes the window between listing and opening: the agent can
	// still write to this directory while promotion runs, and replacing a plain
	// file with a symlink after it was checked would otherwise be enough.
	handle, err := os.OpenFile(file.path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", file.name, err)
	}
	defer handle.Close()

	// Re-checked against the open descriptor rather than the earlier directory
	// entry, so what is read is provably the file that was inspected.
	stat, err := handle.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", file.name, err)
	}
	if !stat.Mode().IsRegular() {
		return fmt.Errorf("artifacts: %s is not a regular file", file.name)
	}
	if stat.Size() != file.size {
		return fmt.Errorf("artifacts: %s changed size during promotion", file.name)
	}

	digest := sha256.New()
	if _, err := io.Copy(digest, io.LimitReader(handle, file.size)); err != nil {
		return fmt.Errorf("checksum %s: %w", file.name, err)
	}
	var checksum [32]byte
	copy(checksum[:], digest.Sum(nil))
	if _, err := handle.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind %s: %w", file.name, err)
	}

	now := promoter.now()
	artifact, err := promoter.ReserveRunArtifact(ctx, collaboration.ReserveRunArtifactParams{
		ID:             promoter.newID(),
		RunID:          run.RunID,
		FileName:       file.name,
		ContentType:    contentTypeFor(file.name),
		SizeBytes:      file.size,
		ChecksumSHA256: checksum,
		CreatedAt:      now,
	})
	if err != nil {
		return fmt.Errorf("reserve %s: %w", file.name, err)
	}

	if _, err := promoter.Storage.Put(ctx, artifact.StorageKey, handle); err != nil {
		// The reservation is removed so a retry starts clean rather than
		// leaving a pending row that will never become ready.
		if abortErr := promoter.AbortRunArtifact(ctx, run.RunID, artifact.ID); abortErr != nil {
			promoter.logger().Warn("could not abort a failed artifact reservation",
				"runId", run.RunID, "attachmentId", artifact.ID, "error", abortErr)
		}
		return fmt.Errorf("store %s: %w", file.name, err)
	}

	if _, _, err := promoter.ActivateRunArtifact(
		ctx, run.RunID, artifact.ID, promoter.newID(), promoter.now(),
	); err != nil {
		return fmt.Errorf("activate %s: %w", file.name, err)
	}
	return nil
}

// contentTypeFor guesses from the extension, defaulting to a type browsers will
// download rather than render. An agent-authored file is untrusted content, and
// serving it as text/html would make an artifact a stored cross-site script.
func contentTypeFor(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
	case ".txt", ".log":
		return "text/plain; charset=utf-8"
	case ".json":
		return "application/json"
	case ".csv":
		return "text/csv; charset=utf-8"
	case ".html", ".htm", ".svg", ".xml":
		return "application/octet-stream"
	}
	if guessed := mime.TypeByExtension(filepath.Ext(name)); guessed != "" &&
		!strings.HasPrefix(guessed, "text/html") && !strings.Contains(guessed, "svg") {
		return guessed
	}
	return "application/octet-stream"
}

func (promoter *Promoter) now() time.Time {
	if promoter.Clock != nil {
		return promoter.Clock().UTC()
	}
	return time.Now().UTC()
}

func (promoter *Promoter) newID() uuid.UUID {
	if promoter.NewID != nil {
		return promoter.NewID()
	}
	return uuid.New()
}

func (promoter *Promoter) logger() *slog.Logger {
	if promoter.Logger != nil {
		return promoter.Logger
	}
	return slog.Default()
}

// Produced is one file a run wrote, with its contents.
type Produced struct {
	Name     string
	Contents string
}

// Output reads the files a finished run produced, at the paths it wrote them.
//
// Shares the promoter's rules — the same output directory, the same run window,
// the same refusal of symlinks, empty files and anything that is not a plain
// file — but descends into subdirectories, which promotion does not. An
// attachment is named; a commit is placed. A run that writes
// output/src/api/handler.go means that file to arrive at src/api/handler.go in
// the repository, and a flat name cannot say so.
func (promoter *Promoter) Output(run RunContext) ([]Produced, error) {
	if !promoter.Enabled() {
		return nil, nil
	}
	directory, err := promoter.outputPath(run.AgentSlug)
	if err != nil {
		return nil, err
	}
	resolved, err := promoter.resolveInsideRoot(directory)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	const margin = 2 * time.Minute
	from := run.StartedAt.Add(-margin)
	until := run.CompletedAt.Add(margin)

	produced := make([]Produced, 0, 8)
	// WalkDir lstats, so a symlinked directory is reported as a symlink and
	// never descended into. Combined with O_NOFOLLOW below, nothing outside the
	// output directory can be read however the tree is arranged.
	err = filepath.WalkDir(resolved, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if current == resolved {
			return nil
		}
		if strings.HasPrefix(entry.Name(), ".") {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if len(produced) >= maxPromotedFiles {
			return fs.SkipAll
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return nil
		}
		if promoter.MaxBytes > 0 && info.Size() > promoter.MaxBytes {
			return nil
		}
		modified := info.ModTime()
		if modified.Before(from) || modified.After(until) {
			return nil
		}
		relative, err := filepath.Rel(resolved, current)
		if err != nil {
			return nil
		}
		// O_NOFOLLOW for the same reason the promoter uses it: the agent can
		// still write to this directory while delivery runs.
		handle, err := os.OpenFile(current, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return nil
		}
		contents, readErr := io.ReadAll(io.LimitReader(handle, info.Size()))
		handle.Close()
		if readErr != nil {
			return nil
		}
		produced = append(produced, Produced{
			Name:     filepath.ToSlash(relative),
			Contents: string(contents),
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("artifacts: read output directory: %w", err)
	}
	sort.Slice(produced, func(a, b int) bool { return produced[a].Name < produced[b].Name })
	return produced, nil
}
