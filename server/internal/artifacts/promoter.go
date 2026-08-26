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
	"bytes"
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
	ReserveRunArtifact(context.Context, collaboration.ReserveRunArtifactParams) (collaboration.RunArtifact, error)
	ActivateRunArtifact(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, time.Time) (collaboration.RunArtifact, collaboration.Event, error)
	AbortRunArtifact(context.Context, uuid.UUID, uuid.UUID) error
	ListRunArtifacts(context.Context, uuid.UUID, *collaboration.RunArtifactCursor, int) ([]collaboration.RunArtifact, error)
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

// ContentEnabled reports whether in-memory content can be promoted. Unlike
// Enabled it needs no runtime volume: the bytes arrive on the stream.
func (promoter *Promoter) ContentEnabled() bool {
	return promoter != nil && promoter.Store != nil && promoter.Storage != nil
}

// PromoteContent publishes bytes captured from the run's stream as one
// artifact, named as the post-run sweep would name the same file so the
// sweep's existing-name check keeps it from being attached twice.
//
// The runtime writes a file_write's content to the agent's workspace, but a
// truncated call or a runtime that drops the write leaves nothing on disk
// (PLATFORM-5, 2026-08-25). The stream still carried the bytes, and this is
// how they reach the issue anyway.
func (promoter *Promoter) PromoteContent(
	ctx context.Context,
	run RunContext,
	name string,
	content []byte,
) error {
	if !promoter.ContentEnabled() {
		return errors.New("artifacts: content promotion is not configured")
	}
	if run.RunID == uuid.Nil {
		return errors.New("artifacts: run id is required")
	}
	cleaned, err := artifactName(name)
	if err != nil {
		return err
	}
	if len(content) == 0 {
		return fmt.Errorf("artifacts: %s is empty", cleaned)
	}
	if promoter.MaxBytes > 0 && int64(len(content)) > promoter.MaxBytes {
		return fmt.Errorf("artifacts: %s exceeds the artifact size limit", cleaned)
	}
	checksum := sha256.Sum256(content)
	artifact, err := promoter.ReserveRunArtifact(ctx, collaboration.ReserveRunArtifactParams{
		ID:             promoter.newID(),
		RunID:          run.RunID,
		Path:           cleaned,
		ContentType:    contentTypeFor(cleaned),
		SizeBytes:      int64(len(content)),
		ChecksumSHA256: checksum,
		CreatedAt:      promoter.now(),
	})
	if err != nil {
		return fmt.Errorf("reserve %s: %w", cleaned, err)
	}
	if _, err := promoter.Storage.Put(ctx, artifact.StorageKey, bytes.NewReader(content)); err != nil {
		if abortErr := promoter.AbortRunArtifact(ctx, run.RunID, artifact.ID); abortErr != nil {
			promoter.logger().Warn("could not abort a failed artifact reservation",
				"runId", run.RunID, "attachmentId", artifact.ID, "error", abortErr)
		}
		return fmt.Errorf("store %s: %w", cleaned, err)
	}
	if _, _, err := promoter.ActivateRunArtifact(
		ctx, run.RunID, artifact.ID, promoter.newID(), promoter.now(),
	); err != nil {
		return fmt.Errorf("activate %s: %w", cleaned, err)
	}
	return nil
}

// artifactName accepts the relative path a file has under output/ and refuses
// anything that could escape it or hide inside it. Nested paths keep their
// slashes: they are the file's identity, not a location on this filesystem.
func artifactName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || strings.HasPrefix(trimmed, "/") || strings.Contains(trimmed, "\\") {
		return "", errors.New("artifacts: file name must be a relative path")
	}
	cleaned := filepath.ToSlash(filepath.Clean(trimmed))
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") ||
		strings.Contains(cleaned, "/../") {
		return "", errors.New("artifacts: file name must stay inside output/")
	}
	// A dot-prefixed segment is tooling rather than output, except .github,
	// which agents are routinely asked to write. Same rule the directory walk
	// applies, so a file arriving through the stream and the same file found
	// on disk are judged identically.
	for _, part := range strings.Split(cleaned, "/") {
		if strings.HasPrefix(part, ".") && part != ".github" {
			return "", errors.New("artifacts: hidden files are not deliverables")
		}
	}
	return cleaned, nil
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
		seen[artifact.Path] = struct{}{}
	}

	for _, candidate := range candidates {
		if _, done := seen[candidate.relative]; done {
			continue
		}
		if len(result.Promoted) >= maxPromotedFiles {
			result.Skipped = append(result.Skipped, candidate.relative)
			continue
		}
		if promoter.MaxBytes > 0 && candidate.size > promoter.MaxBytes {
			promoter.logger().Warn("artifact exceeds the size cap and was not promoted",
				"runId", run.RunID, "file", candidate.relative,
				"sizeBytes", candidate.size, "maxBytes", promoter.MaxBytes)
			result.Skipped = append(result.Skipped, candidate.relative)
			continue
		}
		if err := promoter.promoteOne(ctx, run, candidate); err != nil {
			promoter.logger().Error("artifact promotion failed",
				"runId", run.RunID, "file", candidate.relative, "error", err)
			result.Skipped = append(result.Skipped, candidate.relative)
			continue
		}
		result.Promoted = append(result.Promoted, candidate.relative)
	}
	return result, nil
}

type candidate struct {
	// relative is the path inside output/, slash-separated. It is the
	// artifact's identity: run_artifacts is keyed on (run_id, path), and
	// delivery commits a file at exactly this path.
	relative string
	// path is the absolute location on the mounted volume.
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

	// A generous margin either side: the run's recorded window and the
	// filesystem's clock are not the same clock, and a file written moments
	// before completion is still this run's output.
	const margin = 2 * time.Minute
	from := run.StartedAt.Add(-margin)
	until := run.CompletedAt.Add(margin)

	found := make([]candidate, 0, 16)
	// Recursive, because agents organise their work. An agent asked to build a
	// React application writes output/src/components/…, and a discovery that
	// read only the top level promoted none of it: the run looked as though it
	// had produced nothing, and a reviewer shown no files rejected work that
	// was actually done.
	//
	// WalkDir lstats, so a symlinked directory is reported as a symlink and
	// never descended into. With the O_NOFOLLOW opens elsewhere, nothing
	// outside the output directory can be read however the tree is arranged.
	walkErr := filepath.WalkDir(resolved, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if current == resolved {
			return nil
		}
		if entry.IsDir() {
			// A dot-directory is tooling, not output — except .github, which
			// is the one an agent is routinely asked to write.
			if strings.HasPrefix(entry.Name(), ".") && entry.Name() != ".github" {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(entry.Name(), ".") {
			return nil
		}
		if len(found) >= maxPromotedFiles*2 {
			return fs.SkipAll
		}
		// Info is lstat, so a symlink reports as a symlink here rather than as
		// whatever it points at.
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		// Regular files only. A symlink would be followed on open and promote
		// whatever it targets in *this* process's filesystem — the worker's
		// environment, its credentials, another workspace's data — and the
		// agent that writes into this directory is running model-authored tool
		// calls. Devices, sockets and FIFOs are refused for the same reason:
		// nothing that is not a plain file is a deliverable.
		if !info.Mode().IsRegular() || info.Size() == 0 {
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
		relative = filepath.ToSlash(relative)
		found = append(found, candidate{
			relative: relative,
			path:     current,
			size:     info.Size(),
		})
		return nil
	})
	if walkErr != nil {
		return nil, fmt.Errorf("artifacts: read output directory: %w", walkErr)
	}
	sort.Slice(found, func(left, right int) bool {
		return found[left].relative < found[right].relative
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
		return fmt.Errorf("open %s: %w", file.relative, err)
	}
	defer handle.Close()

	// Re-checked against the open descriptor rather than the earlier directory
	// entry, so what is read is provably the file that was inspected.
	stat, err := handle.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", file.relative, err)
	}
	if !stat.Mode().IsRegular() {
		return fmt.Errorf("artifacts: %s is not a regular file", file.relative)
	}
	if stat.Size() != file.size {
		return fmt.Errorf("artifacts: %s changed size during promotion", file.relative)
	}

	digest := sha256.New()
	if _, err := io.Copy(digest, io.LimitReader(handle, file.size)); err != nil {
		return fmt.Errorf("checksum %s: %w", file.relative, err)
	}
	var checksum [32]byte
	copy(checksum[:], digest.Sum(nil))
	if _, err := handle.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind %s: %w", file.relative, err)
	}

	now := promoter.now()
	artifact, err := promoter.ReserveRunArtifact(ctx, collaboration.ReserveRunArtifactParams{
		ID:             promoter.newID(),
		RunID:          run.RunID,
		Path:           file.relative,
		ContentType:    contentTypeFor(file.relative),
		SizeBytes:      file.size,
		ChecksumSHA256: checksum,
		CreatedAt:      now,
	})
	if err != nil {
		return fmt.Errorf("reserve %s: %w", file.relative, err)
	}

	if _, err := promoter.Storage.Put(ctx, artifact.StorageKey, handle); err != nil {
		// The reservation is removed so a retry starts clean rather than
		// leaving a pending row that will never become ready.
		if abortErr := promoter.AbortRunArtifact(ctx, run.RunID, artifact.ID); abortErr != nil {
			promoter.logger().Warn("could not abort a failed artifact reservation",
				"runId", run.RunID, "attachmentId", artifact.ID, "error", abortErr)
		}
		return fmt.Errorf("store %s: %w", file.relative, err)
	}

	if _, _, err := promoter.ActivateRunArtifact(
		ctx, run.RunID, artifact.ID, promoter.newID(), promoter.now(),
	); err != nil {
		return fmt.Errorf("activate %s: %w", file.relative, err)
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
// The same discovery promotion uses — the same directory, the same run window,
// the same refusal of symlinks, empty files and anything that is not a plain
// file — read back for delivery, which needs the path rather than the name. An
// attachment is named; a commit is placed.
func (promoter *Promoter) Output(run RunContext) ([]Produced, error) {
	if !promoter.Enabled() {
		return nil, nil
	}
	directory, err := promoter.outputPath(run.AgentSlug)
	if err != nil {
		return nil, err
	}
	files, err := promoter.candidates(directory, run)
	if err != nil {
		return nil, err
	}

	produced := make([]Produced, 0, len(files))
	for _, file := range files {
		if promoter.MaxBytes > 0 && file.size > promoter.MaxBytes {
			continue
		}
		// O_NOFOLLOW for the same reason the promoter uses it: the agent can
		// still write to this directory while delivery runs.
		handle, err := os.OpenFile(file.path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			continue
		}
		contents, readErr := io.ReadAll(io.LimitReader(handle, file.size))
		handle.Close()
		if readErr != nil {
			continue
		}
		produced = append(produced, Produced{Name: file.relative, Contents: string(contents)})
	}
	return produced, nil
}
