package storage

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	localMetadataDirectory = ".berry-meta"
	localObjectRoute       = "/api/v1/storage/objects"
	maxMetadataEntries     = 32
	maxMetadataValueBytes  = 1024
	maxMetadataTotalBytes  = 2048
	maxContentTypeBytes    = 255
	defaultPresignTTL      = 15 * time.Minute
	maxPresignTTL          = 24 * time.Hour
)

type uploadCollector struct {
	target io.Writer
	hash   hash.Hash
	sniff  []byte
}

func newUploadCollector(target io.Writer) *uploadCollector {
	return &uploadCollector{
		target: target,
		hash:   sha256.New(),
		sniff:  make([]byte, 0, 512),
	}
}

func (collector *uploadCollector) Write(buffer []byte) (int, error) {
	written, err := collector.target.Write(buffer)
	if written > 0 {
		_, _ = collector.hash.Write(buffer[:written])
		remaining := 512 - len(collector.sniff)
		if remaining > 0 {
			if written < remaining {
				remaining = written
			}
			collector.sniff = append(collector.sniff, buffer[:remaining]...)
		}
	}
	return written, err
}

func (collector *uploadCollector) checksum() string {
	return base64.StdEncoding.EncodeToString(collector.hash.Sum(nil))
}

func (collector *uploadCollector) contentType() string {
	return http.DetectContentType(collector.sniff)
}

func validatePutOptions(options PutOptions) (PutOptions, error) {
	contentType, err := validateContentType(options.ContentType)
	if err != nil {
		return PutOptions{}, err
	}
	checksum, err := normalizeChecksum(options.ChecksumSHA256)
	if err != nil {
		return PutOptions{}, err
	}
	metadata, err := validateMetadata(options.Metadata)
	if err != nil {
		return PutOptions{}, err
	}
	return PutOptions{
		ContentType:    contentType,
		ChecksumSHA256: checksum,
		Metadata:       metadata,
	}, nil
}

func validateContentType(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if len(value) > maxContentTypeBytes || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New("invalid storage content type")
	}
	mediaType, parameters, err := mime.ParseMediaType(value)
	if err != nil || strings.TrimSpace(mediaType) == "" {
		return "", errors.New("invalid storage content type")
	}
	return mime.FormatMediaType(mediaType, parameters), nil
}

func validateMetadata(metadata map[string]string) (map[string]string, error) {
	if len(metadata) > maxMetadataEntries {
		return nil, fmt.Errorf("storage metadata exceeds %d entries", maxMetadataEntries)
	}
	result := make(map[string]string, len(metadata))
	totalBytes := 0
	for key, value := range metadata {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if !validMetadataKey(normalized) || strings.HasPrefix(normalized, "berry-") {
			return nil, errors.New("storage metadata contains an invalid key")
		}
		if _, exists := result[normalized]; exists {
			return nil, errors.New("storage metadata contains duplicate normalized keys")
		}
		if !validMetadataValue(value) {
			return nil, errors.New("storage metadata contains an invalid value")
		}
		totalBytes += len(normalized) + len(value)
		if totalBytes > maxMetadataTotalBytes {
			return nil, fmt.Errorf(
				"storage metadata exceeds %d bytes",
				maxMetadataTotalBytes,
			)
		}
		result[normalized] = value
	}
	return result, nil
}

func validMetadataValue(value string) bool {
	if len(value) > maxMetadataValueBytes {
		return false
	}
	for index := range len(value) {
		if value[index] < 0x20 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

func validMetadataKey(key string) bool {
	if key == "" || len(key) > 64 {
		return false
	}
	for _, character := range key {
		if (character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			character == '-' {
			continue
		}
		return false
	}
	return true
}

func normalizeChecksum(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return "", errors.New("invalid base64 SHA-256 checksum")
	}
	return base64.StdEncoding.EncodeToString(decoded), nil
}

func checksumsEqual(first, second string) bool {
	firstBytes, firstErr := base64.StdEncoding.DecodeString(first)
	secondBytes, secondErr := base64.StdEncoding.DecodeString(second)
	if firstErr != nil || secondErr != nil || len(firstBytes) != len(secondBytes) {
		return false
	}
	return subtle.ConstantTimeCompare(firstBytes, secondBytes) == 1
}

func cloneMetadata(metadata map[string]string) map[string]string {
	if len(metadata) == 0 {
		return nil
	}
	result := make(map[string]string, len(metadata))
	for key, value := range metadata {
		result[key] = value
	}
	return result
}

func (local *Local) keyLock(key string) *sync.Mutex {
	sum := sha256.Sum256([]byte(key))
	return &local.locks[int(sum[0])%len(local.locks)]
}

func (local *Local) metadataName(key string) string {
	sum := sha256.Sum256([]byte(key))
	return path.Join(localMetadataDirectory, hex.EncodeToString(sum[:])+".json")
}

func randomSuffix() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", fmt.Errorf("generate storage temporary name: %w", err)
	}
	return hex.EncodeToString(buffer[:]), nil
}

type localMetadata struct {
	Object Object `json:"object"`
}

func (local *Local) writeMetadata(object Object) error {
	info, err := local.handle.Lstat(localMetadataDirectory)
	if err != nil {
		return fmt.Errorf("inspect local metadata root: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("local metadata root is not a real directory")
	}
	body, err := json.Marshal(localMetadata{Object: object})
	if err != nil {
		return fmt.Errorf("encode storage metadata: %w", err)
	}
	suffix, err := randomSuffix()
	if err != nil {
		return err
	}
	tempName := path.Join(localMetadataDirectory, ".berry-meta-"+suffix)
	temp, err := local.handle.OpenFile(
		tempName,
		os.O_CREATE|os.O_EXCL|os.O_WRONLY,
		0o600,
	)
	if err != nil {
		return fmt.Errorf("create temporary storage metadata: %w", err)
	}
	keep := false
	defer func() {
		if !keep {
			_ = local.handle.Remove(tempName)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("protect temporary storage metadata: %w", err)
	}
	if _, err := temp.Write(body); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write storage metadata: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("sync storage metadata: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close storage metadata: %w", err)
	}
	if err := local.handle.Rename(tempName, local.metadataName(object.Key)); err != nil {
		return fmt.Errorf("publish storage metadata: %w", err)
	}
	keep = true
	if directory, err := local.handle.Open(localMetadataDirectory); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

// Stat returns metadata without revealing the local filesystem layout.
func (local *Local) Stat(ctx context.Context, key string) (Object, error) {
	if err := ctx.Err(); err != nil {
		return Object{}, err
	}
	parts, err := validateKey(key)
	if err != nil {
		return Object{}, err
	}
	lock := local.keyLock(key)
	lock.Lock()
	defer lock.Unlock()

	_, _, err = local.resolve(parts, false)
	if err != nil {
		return Object{}, err
	}
	info, err := local.handle.Lstat(key)
	if err != nil {
		return Object{}, fmt.Errorf("inspect storage object: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return Object{}, errors.New("storage object is not a regular file")
	}
	if object, ok := local.readMetadata(key, info); ok {
		return object, nil
	}
	return local.inspectObject(ctx, key, info)
}

func (local *Local) readMetadata(key string, info os.FileInfo) (Object, bool) {
	body, err := local.handle.ReadFile(local.metadataName(key))
	if err != nil {
		return Object{}, false
	}
	var stored localMetadata
	if err := json.Unmarshal(body, &stored); err != nil {
		return Object{}, false
	}
	object := stored.Object
	if object.Key != key || object.Size != info.Size() ||
		!object.UpdatedAt.Equal(info.ModTime().UTC()) {
		return Object{}, false
	}
	object.Metadata = cloneMetadata(object.Metadata)
	return object, true
}

func (local *Local) inspectObject(
	ctx context.Context,
	key string,
	info os.FileInfo,
) (Object, error) {
	file, err := local.handle.Open(key)
	if err != nil {
		return Object{}, fmt.Errorf("open storage object for metadata: %w", err)
	}
	defer file.Close()
	collector := newUploadCollector(io.Discard)
	if _, err := io.Copy(collector, contextReader{ctx: ctx, source: file}); err != nil {
		return Object{}, fmt.Errorf("inspect storage object body: %w", err)
	}
	return Object{
		Key:            key,
		Size:           info.Size(),
		ContentType:    collector.contentType(),
		ChecksumSHA256: collector.checksum(),
		UpdatedAt:      info.ModTime().UTC(),
	}, nil
}

// PresignGet returns an authenticated Berry route for local downloads.
func (local *Local) PresignGet(
	ctx context.Context,
	key string,
	options PresignGetOptions,
) (PresignedRequest, error) {
	if err := ctx.Err(); err != nil {
		return PresignedRequest{}, err
	}
	if _, err := validateKey(key); err != nil {
		return PresignedRequest{}, err
	}
	if !validContentDisposition(options.ResponseContentDisposition) {
		return PresignedRequest{}, errors.New("invalid response content disposition")
	}
	expires, err := presignExpiry(options.Expires)
	if err != nil {
		return PresignedRequest{}, err
	}
	values := url.Values{
		"key":     []string{base64.RawURLEncoding.EncodeToString([]byte(key))},
		"expires": []string{strconv.FormatInt(expires.Unix(), 10)},
	}
	return PresignedRequest{
		URL:                    localObjectRoute + "?" + values.Encode(),
		Method:                 http.MethodGet,
		Header:                 make(http.Header),
		ExpiresAt:              expires,
		RequiresAuthentication: true,
	}, nil
}

// PresignPut returns an authenticated Berry route whose handler must stream
// through PutWithOptions, preserving the backend's size and checksum checks.
func (local *Local) PresignPut(
	ctx context.Context,
	key string,
	options PresignPutOptions,
) (PresignedRequest, error) {
	if err := ctx.Err(); err != nil {
		return PresignedRequest{}, err
	}
	if _, err := validateKey(key); err != nil {
		return PresignedRequest{}, err
	}
	if options.Size < 0 || options.Size > local.maxBytes {
		return PresignedRequest{}, fmt.Errorf(
			"%w: maximum is %d bytes",
			ErrObjectTooLarge,
			local.maxBytes,
		)
	}
	clean, err := validatePutOptions(PutOptions{
		ContentType:    options.ContentType,
		ChecksumSHA256: options.ChecksumSHA256,
		Metadata:       options.Metadata,
	})
	if err != nil {
		return PresignedRequest{}, err
	}
	expires, err := presignExpiry(options.Expires)
	if err != nil {
		return PresignedRequest{}, err
	}
	values := url.Values{
		"key":     []string{base64.RawURLEncoding.EncodeToString([]byte(key))},
		"expires": []string{strconv.FormatInt(expires.Unix(), 10)},
	}
	headers := make(http.Header)
	headers.Set("Content-Length", strconv.FormatInt(options.Size, 10))
	if clean.ContentType != "" {
		headers.Set("Content-Type", clean.ContentType)
	}
	if clean.ChecksumSHA256 != "" {
		headers.Set("X-Berry-Checksum-Sha256", clean.ChecksumSHA256)
	}
	for metadataKey, metadataValue := range clean.Metadata {
		headers.Set("X-Berry-Metadata-"+metadataKey, metadataValue)
	}
	return PresignedRequest{
		URL:                    localObjectRoute + "?" + values.Encode(),
		Method:                 http.MethodPut,
		Header:                 headers,
		ExpiresAt:              expires,
		RequiresAuthentication: true,
	}, nil
}

// LocalKeyFromRequestURL extracts the logical key from a local request
// descriptor. It never returns or accepts a filesystem path.
func LocalKeyFromRequestURL(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "" || parsed.Host != "" ||
		parsed.Path != localObjectRoute {
		return "", errors.New("invalid local storage request URL")
	}
	query := parsed.Query()
	expiresUnix, err := strconv.ParseInt(query.Get("expires"), 10, 64)
	if err != nil {
		return "", errors.New("invalid local storage request URL")
	}
	expiresAt := time.Unix(expiresUnix, 0)
	now := time.Now()
	if !expiresAt.After(now) || expiresAt.After(now.Add(maxPresignTTL+time.Minute)) {
		return "", errors.New("local storage request URL is expired or invalid")
	}
	encoded := query.Get("key")
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return "", errors.New("invalid local storage request URL")
	}
	key := string(decoded)
	if _, err := validateKey(key); err != nil {
		return "", err
	}
	return key, nil
}

func validContentDisposition(value string) bool {
	if len(value) > 1024 {
		return false
	}
	for index := range len(value) {
		if value[index] < 0x20 || value[index] == 0x7f {
			return false
		}
	}
	return true
}

func presignExpiry(ttl time.Duration) (time.Time, error) {
	if ttl == 0 {
		ttl = defaultPresignTTL
	}
	if ttl < time.Second || ttl > maxPresignTTL {
		return time.Time{}, fmt.Errorf(
			"storage presign expiry must be between 1s and %s",
			maxPresignTTL,
		)
	}
	return time.Now().UTC().Add(ttl), nil
}

var (
	_ MetadataBackend   = (*Local)(nil)
	_ PresigningBackend = (*Local)(nil)
)
