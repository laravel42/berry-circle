package storage

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLocalMetadataChecksumAndPresignedRoute(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	local, err := NewLocal(root, 1024)
	if err != nil {
		t.Fatalf("NewLocal() error = %v", err)
	}
	body := "hello berry"
	sum := sha256.Sum256([]byte(body))
	checksum := base64.StdEncoding.EncodeToString(sum[:])
	object, err := local.PutWithOptions(
		context.Background(),
		"workspace/object.txt",
		strings.NewReader(body),
		PutOptions{
			ContentType:    "text/plain; charset=utf-8",
			ChecksumSHA256: checksum,
			Metadata:       map[string]string{"owner": "workspace-1"},
		},
	)
	if err != nil {
		t.Fatalf("PutWithOptions() error = %v", err)
	}
	if object.ChecksumSHA256 != checksum || object.ContentType != "text/plain; charset=utf-8" {
		t.Fatalf("PutWithOptions() object = %#v", object)
	}

	stored, err := local.Stat(context.Background(), object.Key)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if stored.ChecksumSHA256 != checksum || stored.Metadata["owner"] != "workspace-1" {
		t.Fatalf("Stat() object = %#v", stored)
	}
	stored.Metadata["owner"] = "changed"
	again, err := local.Stat(context.Background(), object.Key)
	if err != nil {
		t.Fatalf("Stat(second) error = %v", err)
	}
	if again.Metadata["owner"] != "workspace-1" {
		t.Fatal("Stat() exposed mutable internal metadata")
	}

	request, err := local.PresignGet(
		context.Background(),
		object.Key,
		PresignGetOptions{Expires: time.Minute},
	)
	if err != nil {
		t.Fatalf("PresignGet() error = %v", err)
	}
	if !request.RequiresAuthentication || strings.Contains(request.URL, root) ||
		strings.Contains(request.URL, object.Key) {
		t.Fatalf("PresignGet() exposed local layout or skipped auth: %#v", request)
	}
	key, err := LocalKeyFromRequestURL(request.URL)
	if err != nil || key != object.Key {
		t.Fatalf("LocalKeyFromRequestURL() = %q, %v", key, err)
	}
	expired := strings.Replace(
		request.URL,
		"expires="+strconv.FormatInt(request.ExpiresAt.Unix(), 10),
		"expires=1",
		1,
	)
	if _, err := LocalKeyFromRequestURL(expired); err == nil {
		t.Fatal("LocalKeyFromRequestURL() accepted an expired descriptor")
	}
	if _, err := LocalKeyFromRequestURL("https://evil.example" + request.URL); err == nil {
		t.Fatal("LocalKeyFromRequestURL() accepted an absolute URL")
	}
}

func TestLocalRejectsChecksumMismatchAndKeepsAtomicReplacement(t *testing.T) {
	t.Parallel()

	local, err := NewLocal(t.TempDir(), 4)
	if err != nil {
		t.Fatalf("NewLocal() error = %v", err)
	}
	if _, err := local.Put(
		context.Background(),
		"object",
		strings.NewReader("old"),
	); err != nil {
		t.Fatalf("Put(old) error = %v", err)
	}
	wrongSum := sha256.Sum256([]byte("different"))
	_, err = local.PutWithOptions(
		context.Background(),
		"object",
		strings.NewReader("new"),
		PutOptions{ChecksumSHA256: base64.StdEncoding.EncodeToString(wrongSum[:])},
	)
	if !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("PutWithOptions() error = %v, want ErrChecksumMismatch", err)
	}
	_, err = local.Put(context.Background(), "object", strings.NewReader("oversized"))
	if !errors.Is(err, ErrObjectTooLarge) {
		t.Fatalf("Put(oversized) error = %v, want ErrObjectTooLarge", err)
	}
	reader, err := local.Open(context.Background(), "object")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if string(body) != "old" {
		t.Fatalf("body = %q, want old", body)
	}
}

func TestLocalHonorsCancellationAndRejectsFinalSymlink(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	local, err := NewLocal(root, 1024)
	if err != nil {
		t.Fatalf("NewLocal() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := local.Put(ctx, "cancelled", strings.NewReader("body")); !errors.Is(err, context.Canceled) {
		t.Fatalf("Put(cancelled) error = %v, want context.Canceled", err)
	}

	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := local.Open(context.Background(), "linked"); err == nil {
		t.Fatal("Open() followed a final symlink")
	}
	if err := local.Delete(context.Background(), "linked"); err == nil {
		t.Fatal("Delete() accepted a final symlink")
	}
}

func TestLocalPresignPutRetainsBoundedAuthenticatedSemantics(t *testing.T) {
	t.Parallel()

	local, err := NewLocal(t.TempDir(), 4)
	if err != nil {
		t.Fatalf("NewLocal() error = %v", err)
	}
	if _, err := local.PresignPut(
		context.Background(),
		"object",
		PresignPutOptions{Size: 5},
	); !errors.Is(err, ErrObjectTooLarge) {
		t.Fatalf("PresignPut(oversized) error = %v, want ErrObjectTooLarge", err)
	}
	request, err := local.PresignPut(
		context.Background(),
		"object",
		PresignPutOptions{Size: 4, ContentType: "text/plain"},
	)
	if err != nil {
		t.Fatalf("PresignPut() error = %v", err)
	}
	if !request.RequiresAuthentication || request.Header.Get("Content-Length") != "4" {
		t.Fatalf("PresignPut() request = %#v", request)
	}
	if _, err := local.PutWithOptions(
		context.Background(),
		"metadata",
		strings.NewReader("body"),
		PutOptions{Metadata: map[string]string{"Owner": "one", "owner": "two"}},
	); err == nil {
		t.Fatal("PutWithOptions() accepted duplicate normalized metadata keys")
	}
}
