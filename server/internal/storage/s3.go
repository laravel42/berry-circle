package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const (
	checksumMetadataKey = "berry-sha256"
	sizeMetadataKey     = "berry-size"
)

type s3ObjectClient interface {
	PutObject(
		context.Context,
		*s3.PutObjectInput,
		...func(*s3.Options),
	) (*s3.PutObjectOutput, error)
	GetObject(
		context.Context,
		*s3.GetObjectInput,
		...func(*s3.Options),
	) (*s3.GetObjectOutput, error)
	HeadObject(
		context.Context,
		*s3.HeadObjectInput,
		...func(*s3.Options),
	) (*s3.HeadObjectOutput, error)
	DeleteObject(
		context.Context,
		*s3.DeleteObjectInput,
		...func(*s3.Options),
	) (*s3.DeleteObjectOutput, error)
}

type s3PresignClient interface {
	PresignGetObject(
		context.Context,
		*s3.GetObjectInput,
		...func(*s3.PresignOptions),
	) (*v4.PresignedHTTPRequest, error)
	PresignPutObject(
		context.Context,
		*s3.PutObjectInput,
		...func(*s3.PresignOptions),
	) (*v4.PresignedHTTPRequest, error)
}

// S3 stores private objects in AWS S3 or a compatible endpoint.
type S3 struct {
	client    s3ObjectClient
	presigner s3PresignClient
	bucket    string
	maxBytes  int64
}

// NewS3 validates configuration, resolves credentials, and builds an S3 client.
func NewS3(ctx context.Context, cfg Config) (*S3, error) {
	cfg, err := validateS3Config(cfg)
	if err != nil {
		return nil, err
	}
	loadOptions := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(cfg.S3Region),
	}
	if cfg.S3AccessKeyID != "" {
		loadOptions = append(
			loadOptions,
			awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
				cfg.S3AccessKeyID,
				cfg.S3SecretAccessKey,
				cfg.S3SessionToken,
			)),
		)
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOptions...)
	if err != nil {
		return nil, errors.New("load S3 configuration")
	}
	if _, err := awsCfg.Credentials.Retrieve(ctx); err != nil {
		return nil, errors.New("resolve S3 credentials")
	}
	client := s3.NewFromConfig(awsCfg, func(options *s3.Options) {
		if cfg.S3Endpoint != "" {
			options.BaseEndpoint = aws.String(cfg.S3Endpoint)
		}
		options.UsePathStyle = cfg.S3UsePathStyle
	})
	return newS3(client, s3.NewPresignClient(client), cfg), nil
}

func newS3(client s3ObjectClient, presigner s3PresignClient, cfg Config) *S3 {
	return &S3{
		client:    client,
		presigner: presigner,
		bucket:    cfg.S3Bucket,
		maxBytes:  cfg.MaxBytes,
	}
}

func validateS3Config(cfg Config) (Config, error) {
	cfg.S3Bucket = strings.TrimSpace(cfg.S3Bucket)
	cfg.S3Region = strings.TrimSpace(cfg.S3Region)
	cfg.S3Endpoint = strings.TrimSpace(cfg.S3Endpoint)
	cfg.S3AccessKeyID = strings.TrimSpace(cfg.S3AccessKeyID)
	if cfg.MaxBytes <= 0 {
		return Config{}, errors.New("S3 storage max size must be positive")
	}
	if !validS3Bucket(cfg.S3Bucket) {
		return Config{}, errors.New("S3_BUCKET is required and must be valid")
	}
	if !validS3Region(cfg.S3Region) {
		return Config{}, errors.New("S3_REGION is required and must be valid")
	}
	hasAccessKey := cfg.S3AccessKeyID != ""
	hasSecretKey := strings.TrimSpace(cfg.S3SecretAccessKey) != ""
	if hasAccessKey != hasSecretKey || (cfg.S3SessionToken != "" && !hasAccessKey) {
		return Config{}, errors.New("S3 credentials are incomplete")
	}
	if cfg.S3Endpoint != "" {
		endpoint, err := url.Parse(cfg.S3Endpoint)
		if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") ||
			endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" ||
			endpoint.Fragment != "" {
			return Config{}, errors.New("S3_ENDPOINT must be an HTTP(S) URL without credentials")
		}
		// Path-style is the interoperable default for MinIO and other local endpoints.
		if !cfg.S3UsePathStyleSet {
			cfg.S3UsePathStyle = true
		}
	}
	return cfg, nil
}

func validS3Bucket(bucket string) bool {
	if len(bucket) < 3 || len(bucket) > 63 ||
		bucket[0] == '.' || bucket[0] == '-' ||
		bucket[len(bucket)-1] == '.' || bucket[len(bucket)-1] == '-' ||
		strings.Contains(bucket, "..") {
		return false
	}
	for _, character := range bucket {
		if (character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			character == '.' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func validS3Region(region string) bool {
	if region == "" || len(region) > 64 {
		return false
	}
	for _, character := range region {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

// Put preserves the original storage interface.
func (backend *S3) Put(
	ctx context.Context,
	key string,
	source io.Reader,
) (Object, error) {
	return backend.PutWithOptions(ctx, key, source, PutOptions{})
}

// PutWithOptions stages a bounded body, computes SHA-256, then uploads it.
func (backend *S3) PutWithOptions(
	ctx context.Context,
	key string,
	source io.Reader,
	options PutOptions,
) (Object, error) {
	if backend == nil || backend.client == nil {
		return Object{}, errors.New("S3 storage is unavailable")
	}
	if source == nil {
		return Object{}, errors.New("storage object source is nil")
	}
	if _, err := validateKey(key); err != nil {
		return Object{}, err
	}
	cleanOptions, err := validatePutOptions(options)
	if err != nil {
		return Object{}, err
	}
	temp, err := os.CreateTemp("", "berry-s3-object-*")
	if err != nil {
		return Object{}, fmt.Errorf("stage S3 object: %w", err)
	}
	tempName := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}()
	collector := newUploadCollector(temp)
	size, err := io.Copy(
		collector,
		io.LimitReader(contextReader{ctx: ctx, source: source}, backend.maxBytes+1),
	)
	if err != nil {
		return Object{}, fmt.Errorf("stage S3 object: %w", err)
	}
	if size > backend.maxBytes {
		return Object{}, fmt.Errorf(
			"%w: maximum is %d bytes",
			ErrObjectTooLarge,
			backend.maxBytes,
		)
	}
	checksum := collector.checksum()
	if cleanOptions.ChecksumSHA256 != "" &&
		!checksumsEqual(cleanOptions.ChecksumSHA256, checksum) {
		return Object{}, ErrChecksumMismatch
	}
	if _, err := temp.Seek(0, io.SeekStart); err != nil {
		return Object{}, fmt.Errorf("rewind S3 object: %w", err)
	}
	contentType := cleanOptions.ContentType
	if contentType == "" {
		contentType = collector.contentType()
	}
	metadata := cloneMetadata(cleanOptions.Metadata)
	if metadata == nil {
		metadata = make(map[string]string, 2)
	}
	metadata[checksumMetadataKey] = checksum
	metadata[sizeMetadataKey] = strconv.FormatInt(size, 10)
	output, err := backend.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:            aws.String(backend.bucket),
		Key:               aws.String(key),
		Body:              temp,
		ContentLength:     aws.Int64(size),
		ContentType:       aws.String(contentType),
		ChecksumAlgorithm: types.ChecksumAlgorithmSha256,
		ChecksumSHA256:    aws.String(checksum),
		Metadata:          metadata,
	})
	if err != nil {
		return Object{}, fmt.Errorf("put S3 object: %w", err)
	}
	return Object{
		Key:            key,
		Size:           size,
		ContentType:    contentType,
		ChecksumSHA256: checksum,
		ETag:           aws.ToString(output.ETag),
		Metadata:       cloneMetadata(cleanOptions.Metadata),
		UpdatedAt:      time.Now().UTC(),
	}, nil
}

// Open streams an object and binds reads to the caller's context.
func (backend *S3) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	if backend == nil || backend.client == nil {
		return nil, errors.New("S3 storage is unavailable")
	}
	if _, err := validateKey(key); err != nil {
		return nil, err
	}
	output, err := backend.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(backend.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("get S3 object: %w", err)
	}
	return contextReadCloser{ctx: ctx, ReadCloser: output.Body}, nil
}

// Delete removes one object. S3 deletion is idempotent for missing keys.
func (backend *S3) Delete(ctx context.Context, key string) error {
	if backend == nil || backend.client == nil {
		return errors.New("S3 storage is unavailable")
	}
	if _, err := validateKey(key); err != nil {
		return err
	}
	if _, err := backend.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(backend.bucket),
		Key:    aws.String(key),
	}); err != nil {
		return fmt.Errorf("delete S3 object: %w", err)
	}
	return nil
}

// Stat returns object metadata and the full-object SHA-256 when available.
func (backend *S3) Stat(ctx context.Context, key string) (Object, error) {
	if backend == nil || backend.client == nil {
		return Object{}, errors.New("S3 storage is unavailable")
	}
	if _, err := validateKey(key); err != nil {
		return Object{}, err
	}
	output, err := backend.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(backend.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return Object{}, fmt.Errorf("head S3 object: %w", err)
	}
	metadata := cloneMetadata(output.Metadata)
	checksum := aws.ToString(output.ChecksumSHA256)
	if checksum == "" {
		checksum = metadata[checksumMetadataKey]
	}
	delete(metadata, checksumMetadataKey)
	delete(metadata, sizeMetadataKey)
	var updatedAt time.Time
	if output.LastModified != nil {
		updatedAt = output.LastModified.UTC()
	}
	return Object{
		Key:            key,
		Size:           aws.ToInt64(output.ContentLength),
		ContentType:    aws.ToString(output.ContentType),
		ChecksumSHA256: checksum,
		ETag:           aws.ToString(output.ETag),
		Metadata:       metadata,
		UpdatedAt:      updatedAt,
	}, nil
}

// PresignGet produces a short-lived S3 GET request.
func (backend *S3) PresignGet(
	ctx context.Context,
	key string,
	options PresignGetOptions,
) (PresignedRequest, error) {
	if backend == nil || backend.presigner == nil {
		return PresignedRequest{}, errors.New("S3 presigning is unavailable")
	}
	if _, err := validateKey(key); err != nil {
		return PresignedRequest{}, err
	}
	if !validContentDisposition(options.ResponseContentDisposition) {
		return PresignedRequest{}, errors.New("invalid response content disposition")
	}
	expiresAt, err := presignExpiry(options.Expires)
	if err != nil {
		return PresignedRequest{}, err
	}
	input := &s3.GetObjectInput{
		Bucket: aws.String(backend.bucket),
		Key:    aws.String(key),
	}
	if options.ResponseContentDisposition != "" {
		input.ResponseContentDisposition = aws.String(options.ResponseContentDisposition)
	}
	request, err := backend.presigner.PresignGetObject(
		ctx,
		input,
		func(presign *s3.PresignOptions) {
			presign.Expires = time.Until(expiresAt)
		},
	)
	if err != nil {
		return PresignedRequest{}, fmt.Errorf("presign S3 GET: %w", err)
	}
	return fromAWSPresignedRequest(request, expiresAt), nil
}

// PresignPut produces a checksum-bound, exact-size S3 PUT request.
func (backend *S3) PresignPut(
	ctx context.Context,
	key string,
	options PresignPutOptions,
) (PresignedRequest, error) {
	if backend == nil || backend.presigner == nil {
		return PresignedRequest{}, errors.New("S3 presigning is unavailable")
	}
	if _, err := validateKey(key); err != nil {
		return PresignedRequest{}, err
	}
	if options.Size < 0 || options.Size > backend.maxBytes {
		return PresignedRequest{}, fmt.Errorf(
			"%w: maximum is %d bytes",
			ErrObjectTooLarge,
			backend.maxBytes,
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
	if clean.ChecksumSHA256 == "" {
		return PresignedRequest{}, errors.New("presigned S3 PUT requires a SHA-256 checksum")
	}
	if clean.ContentType == "" {
		clean.ContentType = "application/octet-stream"
	}
	expiresAt, err := presignExpiry(options.Expires)
	if err != nil {
		return PresignedRequest{}, err
	}
	metadata := cloneMetadata(clean.Metadata)
	if metadata == nil {
		metadata = make(map[string]string, 2)
	}
	metadata[checksumMetadataKey] = clean.ChecksumSHA256
	metadata[sizeMetadataKey] = strconv.FormatInt(options.Size, 10)
	input := &s3.PutObjectInput{
		Bucket:            aws.String(backend.bucket),
		Key:               aws.String(key),
		ContentLength:     aws.Int64(options.Size),
		ContentType:       aws.String(clean.ContentType),
		ChecksumAlgorithm: types.ChecksumAlgorithmSha256,
		ChecksumSHA256:    aws.String(clean.ChecksumSHA256),
		Metadata:          metadata,
	}
	request, err := backend.presigner.PresignPutObject(
		ctx,
		input,
		func(presign *s3.PresignOptions) {
			presign.Expires = time.Until(expiresAt)
		},
	)
	if err != nil {
		return PresignedRequest{}, fmt.Errorf("presign S3 PUT: %w", err)
	}
	result := fromAWSPresignedRequest(request, expiresAt)
	result.Header.Set("Content-Length", strconv.FormatInt(options.Size, 10))
	return result, nil
}

func fromAWSPresignedRequest(
	request *v4.PresignedHTTPRequest,
	expiresAt time.Time,
) PresignedRequest {
	headers := make(http.Header)
	if request != nil {
		headers = request.SignedHeader.Clone()
	}
	result := PresignedRequest{
		Method:    http.MethodGet,
		Header:    headers,
		ExpiresAt: expiresAt,
	}
	if request != nil {
		result.URL = request.URL
		result.Method = request.Method
	}
	return result
}

var (
	_ MetadataBackend   = (*S3)(nil)
	_ PresigningBackend = (*S3)(nil)
)
