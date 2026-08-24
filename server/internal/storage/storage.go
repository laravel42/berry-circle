package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	// ErrInvalidKey marks a key that cannot be safely mapped by a backend.
	ErrInvalidKey = errors.New("invalid storage key")
	// ErrObjectTooLarge marks an upload that exceeded the configured limit.
	ErrObjectTooLarge = errors.New("storage object exceeds configured limit")
	// ErrChecksumMismatch marks an upload whose body did not match its declared checksum.
	ErrChecksumMismatch = errors.New("storage object checksum mismatch")
)

// Object describes a stored object without exposing a local filesystem path.
type Object struct {
	Key            string
	Size           int64
	ContentType    string
	ChecksumSHA256 string
	ETag           string
	Metadata       map[string]string
	UpdatedAt      time.Time
}

// Backend is Berry's object-storage boundary.
type Backend interface {
	Put(context.Context, string, io.Reader) (Object, error)
	Open(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
}

// PutOptions adds metadata and an optional expected base64-encoded SHA-256.
type PutOptions struct {
	ContentType    string
	ChecksumSHA256 string
	Metadata       map[string]string
}

// MetadataBackend is an optional, backward-compatible richer storage seam.
type MetadataBackend interface {
	Backend
	PutWithOptions(context.Context, string, io.Reader, PutOptions) (Object, error)
	Stat(context.Context, string) (Object, error)
}

// PresignGetOptions controls a temporary object download.
type PresignGetOptions struct {
	Expires                    time.Duration
	ResponseContentDisposition string
}

// PresignPutOptions controls an exact-size temporary upload.
type PresignPutOptions struct {
	Expires        time.Duration
	Size           int64
	ContentType    string
	ChecksumSHA256 string
	Metadata       map[string]string
}

// PresignedRequest is an HTTP request descriptor. Local descriptors retain
// Berry authentication; S3 descriptors carry authorization in the signature.
type PresignedRequest struct {
	URL                    string
	Method                 string
	Header                 http.Header
	ExpiresAt              time.Time
	RequiresAuthentication bool
}

// PresigningBackend is implemented by backends that can produce temporary
// GET and exact-size PUT request descriptors.
type PresigningBackend interface {
	Backend
	PresignGet(context.Context, string, PresignGetOptions) (PresignedRequest, error)
	PresignPut(context.Context, string, PresignPutOptions) (PresignedRequest, error)
}

const (
	defaultLocalRoot = "./data/uploads"
	defaultMaxBytes  = int64(25 * 1024 * 1024)
)

// Config selects and validates a storage backend.
type Config struct {
	Backend           string
	LocalRoot         string
	MaxBytes          int64
	S3Bucket          string
	S3Region          string
	S3Endpoint        string
	S3UsePathStyle    bool
	S3UsePathStyleSet bool
	S3AccessKeyID     string
	S3SecretAccessKey string
	S3SessionToken    string
}

// New constructs the configured backend.
func New(cfg Config) (Backend, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return NewWithContext(ctx, cfg)
}

// NewWithContext constructs the configured backend while preserving startup
// cancellation for credential discovery.
func NewWithContext(ctx context.Context, cfg Config) (Backend, error) {
	if strings.TrimSpace(cfg.Backend) == "" {
		cfg.Backend = "local"
	}
	if cfg.MaxBytes == 0 {
		cfg.MaxBytes = defaultMaxBytes
	}
	switch cfg.Backend {
	case "local":
		if strings.TrimSpace(cfg.LocalRoot) == "" {
			cfg.LocalRoot = defaultLocalRoot
		}
		return NewLocal(cfg.LocalRoot, cfg.MaxBytes)
	case "s3":
		return NewS3(ctx, cfg)
	default:
		return nil, fmt.Errorf("unsupported storage backend %q", cfg.Backend)
	}
}

// Local stores objects beneath one private root using atomic renames.
type Local struct {
	root      string
	handle    *os.Root
	maxBytes  int64
	locks     [64]sync.Mutex
	closeOnce sync.Once
	closeErr  error
}

// NewLocal initializes a secure local storage root.
func NewLocal(root string, maxBytes int64) (*Local, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("local storage root is empty")
	}
	if maxBytes <= 0 {
		return nil, errors.New("local storage max size must be positive")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve local storage root: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, fmt.Errorf("create local storage root: %w", err)
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return nil, fmt.Errorf("inspect local storage root: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, errors.New("local storage root must be a real directory")
	}
	if err := os.Chmod(absolute, 0o700); err != nil {
		return nil, fmt.Errorf("protect local storage root: %w", err)
	}
	metadataRoot := filepath.Join(absolute, localMetadataDirectory)
	if err := os.MkdirAll(metadataRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create local metadata root: %w", err)
	}
	metadataInfo, err := os.Lstat(metadataRoot)
	if err != nil {
		return nil, fmt.Errorf("inspect local metadata root: %w", err)
	}
	if metadataInfo.Mode()&os.ModeSymlink != 0 || !metadataInfo.IsDir() {
		return nil, errors.New("local metadata root must be a real directory")
	}
	if err := os.Chmod(metadataRoot, 0o700); err != nil {
		return nil, fmt.Errorf("protect local metadata root: %w", err)
	}
	handle, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, fmt.Errorf("open local storage root: %w", err)
	}
	return &Local{root: absolute, handle: handle, maxBytes: maxBytes}, nil
}

// Put writes an object atomically and rejects traversal and symlink paths.
func (local *Local) Put(
	ctx context.Context,
	key string,
	source io.Reader,
) (Object, error) {
	return local.PutWithOptions(ctx, key, source, PutOptions{})
}

// PutWithOptions writes an object and its validated metadata.
func (local *Local) PutWithOptions(
	ctx context.Context,
	key string,
	source io.Reader,
	options PutOptions,
) (Object, error) {
	if source == nil {
		return Object{}, errors.New("storage object source is nil")
	}
	parts, err := validateKey(key)
	if err != nil {
		return Object{}, err
	}
	cleanOptions, err := validatePutOptions(options)
	if err != nil {
		return Object{}, err
	}
	lock := local.keyLock(key)
	lock.Lock()
	defer lock.Unlock()

	_, _, err = local.resolve(parts, true)
	if err != nil {
		return Object{}, err
	}
	if info, statErr := local.handle.Lstat(key); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return Object{}, errors.New("storage key resolves to a symlink")
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return Object{}, fmt.Errorf("inspect storage target: %w", statErr)
	}

	parentKey := path.Dir(key)
	if parentKey == "." {
		parentKey = ""
	}
	suffix, err := randomSuffix()
	if err != nil {
		return Object{}, err
	}
	tempKey := path.Join(parentKey, ".berry-object-"+suffix)
	temp, err := local.handle.OpenFile(tempKey, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return Object{}, fmt.Errorf("create temporary storage object: %w", err)
	}
	keep := false
	defer func() {
		if !keep {
			_ = local.handle.Remove(tempKey)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return Object{}, fmt.Errorf("protect temporary storage object: %w", err)
	}

	collector := newUploadCollector(temp)
	written, err := io.Copy(
		collector,
		io.LimitReader(contextReader{ctx: ctx, source: source}, local.maxBytes+1),
	)
	if err != nil {
		_ = temp.Close()
		return Object{}, fmt.Errorf("write storage object: %w", err)
	}
	if written > local.maxBytes {
		_ = temp.Close()
		return Object{}, fmt.Errorf("%w: maximum is %d bytes", ErrObjectTooLarge, local.maxBytes)
	}
	checksum := collector.checksum()
	if cleanOptions.ChecksumSHA256 != "" &&
		!checksumsEqual(cleanOptions.ChecksumSHA256, checksum) {
		_ = temp.Close()
		return Object{}, ErrChecksumMismatch
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return Object{}, fmt.Errorf("sync storage object: %w", err)
	}
	if err := temp.Close(); err != nil {
		return Object{}, fmt.Errorf("close storage object: %w", err)
	}
	info, err := local.handle.Stat(tempKey)
	if err != nil {
		return Object{}, fmt.Errorf("inspect stored object: %w", err)
	}
	contentType := cleanOptions.ContentType
	if contentType == "" {
		contentType = collector.contentType()
	}
	object := Object{
		Key:            key,
		Size:           info.Size(),
		ContentType:    contentType,
		ChecksumSHA256: checksum,
		Metadata:       cloneMetadata(cleanOptions.Metadata),
		UpdatedAt:      info.ModTime().UTC(),
	}
	if err := local.writeMetadata(object); err != nil {
		return Object{}, err
	}
	if err := local.handle.Rename(tempKey, key); err != nil {
		return Object{}, fmt.Errorf("publish storage object: %w", err)
	}
	keep = true
	directoryKey := parentKey
	if directoryKey == "" {
		directoryKey = "."
	}
	if directory, err := local.handle.Open(directoryKey); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return object, nil
}

// Open reads an object after rechecking every path component.
func (local *Local) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	parts, err := validateKey(key)
	if err != nil {
		return nil, err
	}
	_, _, err = local.resolve(parts, false)
	if err != nil {
		return nil, err
	}
	info, err := local.handle.Lstat(key)
	if err != nil {
		return nil, fmt.Errorf("open storage object: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("storage object is not a regular file")
	}
	file, err := local.handle.Open(key)
	if err != nil {
		return nil, fmt.Errorf("open storage object: %w", err)
	}
	return contextReadCloser{ctx: ctx, ReadCloser: file}, nil
}

// Delete removes one object without following symlinks.
func (local *Local) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	parts, err := validateKey(key)
	if err != nil {
		return err
	}
	lock := local.keyLock(key)
	lock.Lock()
	defer lock.Unlock()
	_, _, err = local.resolve(parts, false)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	info, err := local.handle.Lstat(key)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("inspect storage object: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("storage object is not a regular file")
	}
	if err := local.handle.Remove(key); err != nil {
		return fmt.Errorf("delete storage object: %w", err)
	}
	if err := local.handle.Remove(local.metadataName(key)); err != nil &&
		!errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete storage metadata: %w", err)
	}
	return nil
}

// Close releases the secure root handle. The backend must not be reused.
func (local *Local) Close() error {
	if local == nil || local.handle == nil {
		return nil
	}
	local.closeOnce.Do(func() {
		local.closeErr = local.handle.Close()
	})
	return local.closeErr
}

func (local *Local) resolve(parts []string, create bool) (string, string, error) {
	currentRelative := ""
	for _, part := range parts[:len(parts)-1] {
		currentRelative = path.Join(currentRelative, part)
		info, err := local.handle.Lstat(currentRelative)
		switch {
		case errors.Is(err, os.ErrNotExist) && create:
			if err := local.handle.Mkdir(currentRelative, 0o700); err != nil &&
				!errors.Is(err, os.ErrExist) {
				return "", "", fmt.Errorf("create storage directory: %w", err)
			}
			info, err = local.handle.Lstat(currentRelative)
		case err != nil:
			return "", "", fmt.Errorf("inspect storage directory: %w", err)
		}
		if err != nil {
			return "", "", fmt.Errorf("inspect storage directory: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", "", errors.New("storage path contains a non-directory component")
		}
	}
	current := filepath.Join(local.root, filepath.FromSlash(currentRelative))
	return current, filepath.Join(current, parts[len(parts)-1]), nil
}

func validateKey(key string) ([]string, error) {
	if key == "" || len(key) > 1024 || strings.ContainsRune(key, '\x00') ||
		strings.Contains(key, `\`) || path.IsAbs(key) || path.Clean(key) != key {
		return nil, ErrInvalidKey
	}
	parts := strings.Split(key, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, ErrInvalidKey
		}
	}
	if parts[0] == localMetadataDirectory {
		return nil, ErrInvalidKey
	}
	return parts, nil
}

type contextReader struct {
	ctx    context.Context
	source io.Reader
}

func (reader contextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.source.Read(buffer)
}

type contextReadCloser struct {
	ctx context.Context
	io.ReadCloser
}

func (reader contextReadCloser) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.ReadCloser.Read(buffer)
}
