package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type fakeS3Client struct {
	putInput    *s3.PutObjectInput
	getInput    *s3.GetObjectInput
	headInput   *s3.HeadObjectInput
	deleteInput *s3.DeleteObjectInput
	body        []byte
}

func (client *fakeS3Client) PutObject(
	ctx context.Context,
	input *s3.PutObjectInput,
	_ ...func(*s3.Options),
) (*s3.PutObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	body, err := io.ReadAll(input.Body)
	if err != nil {
		return nil, err
	}
	client.putInput = input
	client.body = body
	return &s3.PutObjectOutput{ETag: aws.String(`"etag"`)}, nil
}

func (client *fakeS3Client) GetObject(
	ctx context.Context,
	input *s3.GetObjectInput,
	_ ...func(*s3.Options),
) (*s3.GetObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client.getInput = input
	return &s3.GetObjectOutput{
		Body: io.NopCloser(bytes.NewReader(client.body)),
	}, nil
}

func (client *fakeS3Client) HeadObject(
	ctx context.Context,
	input *s3.HeadObjectInput,
	_ ...func(*s3.Options),
) (*s3.HeadObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client.headInput = input
	modified := time.Unix(100, 0).UTC()
	return &s3.HeadObjectOutput{
		ContentLength:  aws.Int64(int64(len(client.body))),
		ContentType:    aws.String("text/plain"),
		ChecksumSHA256: client.putInput.ChecksumSHA256,
		ETag:           aws.String(`"etag"`),
		LastModified:   &modified,
		Metadata: map[string]string{
			checksumMetadataKey: aws.ToString(client.putInput.ChecksumSHA256),
			sizeMetadataKey:     "4",
			"owner":             "workspace-1",
		},
	}, nil
}

func (client *fakeS3Client) DeleteObject(
	ctx context.Context,
	input *s3.DeleteObjectInput,
	_ ...func(*s3.Options),
) (*s3.DeleteObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client.deleteInput = input
	return &s3.DeleteObjectOutput{}, nil
}

type fakeS3Presigner struct {
	getInput *s3.GetObjectInput
	putInput *s3.PutObjectInput
}

func (presigner *fakeS3Presigner) PresignGetObject(
	_ context.Context,
	input *s3.GetObjectInput,
	options ...func(*s3.PresignOptions),
) (*v4.PresignedHTTPRequest, error) {
	presigner.getInput = input
	for _, option := range options {
		option(&s3.PresignOptions{})
	}
	return &v4.PresignedHTTPRequest{
		URL:          "https://storage.example/object?signature=redacted",
		Method:       http.MethodGet,
		SignedHeader: make(http.Header),
	}, nil
}

func (presigner *fakeS3Presigner) PresignPutObject(
	_ context.Context,
	input *s3.PutObjectInput,
	options ...func(*s3.PresignOptions),
) (*v4.PresignedHTTPRequest, error) {
	presigner.putInput = input
	for _, option := range options {
		option(&s3.PresignOptions{})
	}
	headers := make(http.Header)
	headers.Set("X-Amz-Checksum-Sha256", aws.ToString(input.ChecksumSHA256))
	return &v4.PresignedHTTPRequest{
		URL:          "https://storage.example/object?signature=redacted",
		Method:       http.MethodPut,
		SignedHeader: headers,
	}, nil
}

func TestS3PutOpenStatDeleteAndBounds(t *testing.T) {
	t.Parallel()

	client := &fakeS3Client{}
	backend := newS3(client, &fakeS3Presigner{}, Config{
		S3Bucket: "berry",
		MaxBytes: 4,
	})
	sum := sha256.Sum256([]byte("body"))
	checksum := base64.StdEncoding.EncodeToString(sum[:])
	object, err := backend.PutWithOptions(
		context.Background(),
		"workspace/object",
		strings.NewReader("body"),
		PutOptions{
			ContentType:    "text/plain",
			ChecksumSHA256: checksum,
			Metadata:       map[string]string{"owner": "workspace-1"},
		},
	)
	if err != nil {
		t.Fatalf("PutWithOptions() error = %v", err)
	}
	if string(client.body) != "body" || object.ChecksumSHA256 != checksum ||
		client.putInput.Metadata[checksumMetadataKey] != checksum {
		t.Fatalf("PutWithOptions() object/input = %#v / %#v", object, client.putInput)
	}
	if _, err := backend.Put(
		context.Background(),
		"workspace/large",
		strings.NewReader("large"),
	); !errors.Is(err, ErrObjectTooLarge) {
		t.Fatalf("Put(oversized) error = %v, want ErrObjectTooLarge", err)
	}

	reader, err := backend.Open(context.Background(), object.Key)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	body, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || string(body) != "body" {
		t.Fatalf("Open() body/error = %q / %v", body, err)
	}
	stored, err := backend.Stat(context.Background(), object.Key)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if stored.Metadata["owner"] != "workspace-1" ||
		stored.Metadata[checksumMetadataKey] != "" ||
		stored.ChecksumSHA256 != checksum {
		t.Fatalf("Stat() object = %#v", stored)
	}
	if err := backend.Delete(context.Background(), object.Key); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if aws.ToString(client.deleteInput.Key) != object.Key {
		t.Fatalf("Delete() key = %q", aws.ToString(client.deleteInput.Key))
	}
}

func TestS3PresigningRequiresBoundedChecksummedPut(t *testing.T) {
	t.Parallel()

	presigner := &fakeS3Presigner{}
	backend := newS3(&fakeS3Client{}, presigner, Config{
		S3Bucket: "berry",
		MaxBytes: 10,
	})
	if _, err := backend.PresignPut(
		context.Background(),
		"object",
		PresignPutOptions{Size: 4},
	); err == nil {
		t.Fatal("PresignPut() accepted a missing checksum")
	}
	sum := sha256.Sum256([]byte("body"))
	checksum := base64.StdEncoding.EncodeToString(sum[:])
	request, err := backend.PresignPut(
		context.Background(),
		"object",
		PresignPutOptions{
			Size:           4,
			ContentType:    "text/plain",
			ChecksumSHA256: checksum,
		},
	)
	if err != nil {
		t.Fatalf("PresignPut() error = %v", err)
	}
	if request.RequiresAuthentication || request.Method != http.MethodPut ||
		request.Header.Get("Content-Length") != "4" ||
		aws.ToString(presigner.putInput.ChecksumSHA256) != checksum {
		t.Fatalf("PresignPut() request/input = %#v / %#v", request, presigner.putInput)
	}
	getRequest, err := backend.PresignGet(
		context.Background(),
		"object",
		PresignGetOptions{Expires: time.Minute},
	)
	if err != nil || getRequest.Method != http.MethodGet {
		t.Fatalf("PresignGet() request/error = %#v / %v", getRequest, err)
	}
}

func TestS3ConfigRejectsIncompleteSecretsWithoutEchoingThem(t *testing.T) {
	t.Parallel()

	const secret = "do-not-log-this-secret"
	_, err := validateS3Config(Config{
		MaxBytes:          1024,
		S3Bucket:          "berry",
		S3Region:          "us-east-1",
		S3SecretAccessKey: secret,
	})
	if err == nil {
		t.Fatal("validateS3Config() accepted incomplete credentials")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("validateS3Config() exposed a secret: %v", err)
	}
	if _, err := validateS3Config(Config{
		MaxBytes: 1024,
		S3Bucket: "../unsafe",
		S3Region: "us-east-1",
	}); err == nil {
		t.Fatal("validateS3Config() accepted an unsafe bucket")
	}
	cfg, err := validateS3Config(Config{
		MaxBytes:          1024,
		S3Bucket:          "berry",
		S3Region:          "us-east-1",
		S3Endpoint:        "http://127.0.0.1:9000",
		S3AccessKeyID:     "minio",
		S3SecretAccessKey: secret,
	})
	if err != nil {
		t.Fatalf("validateS3Config(endpoint) error = %v", err)
	}
	if !cfg.S3UsePathStyle {
		t.Fatal("custom endpoint did not default to path-style")
	}
	cfg, err = validateS3Config(Config{
		MaxBytes:          1024,
		S3Bucket:          "berry",
		S3Region:          "us-east-1",
		S3Endpoint:        "https://objects.example.test",
		S3UsePathStyle:    false,
		S3UsePathStyleSet: true,
		S3AccessKeyID:     "access",
		S3SecretAccessKey: secret,
	})
	if err != nil {
		t.Fatalf("validateS3Config(explicit virtual host) error = %v", err)
	}
	if cfg.S3UsePathStyle {
		t.Fatal("custom endpoint ignored explicit virtual-host style")
	}
}

func TestNewS3ResolvesCompleteStaticCredentialsAtStartup(t *testing.T) {
	t.Parallel()

	backend, err := NewS3(context.Background(), Config{
		MaxBytes:          1024,
		S3Bucket:          "berry",
		S3Region:          "us-east-1",
		S3Endpoint:        "http://127.0.0.1:9000",
		S3AccessKeyID:     "minio",
		S3SecretAccessKey: "minio-secret",
	})
	if err != nil {
		t.Fatalf("NewS3() error = %v", err)
	}
	if backend.bucket != "berry" || backend.maxBytes != 1024 {
		t.Fatalf("NewS3() backend = %#v", backend)
	}
}
