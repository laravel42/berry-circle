package attachments

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	repository "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/storage"
)

func TestValidFileName(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"design.pdf", "résumé 2026.txt", "画像.png"} {
		if !validFileName(value) {
			t.Errorf("validFileName(%q) = false", value)
		}
	}
	for _, value := range []string{
		"",
		".",
		"..",
		"../secret",
		`folder\secret`,
		" leading.txt",
		"trailing.txt ",
		"line\nbreak.txt",
		strings.Repeat("a", 256),
	} {
		if validFileName(value) {
			t.Errorf("validFileName(%q) = true", value)
		}
	}
}

func TestValidateUploadContentType(t *testing.T) {
	t.Parallel()
	file, err := os.CreateTemp("", "berry-upload-validation-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = file.Close()
		_ = os.Remove(file.Name())
	})
	if _, err := file.WriteString(`{"ok":true}`); err != nil {
		t.Fatal(err)
	}
	if got, err := validateUploadContentType(
		"application/json",
		[]byte(`{"ok":true}`),
		file,
	); err != nil || got != "application/json" {
		t.Fatalf("JSON type = %q, %v", got, err)
	}
	if _, err := validateUploadContentType(
		"image/png",
		[]byte("<html>not an image</html>"),
		file,
	); err == nil {
		t.Fatal("mismatched image content was accepted")
	}
	if _, err := validateUploadContentType(
		"image/svg+xml",
		[]byte("<svg></svg>"),
		file,
	); err == nil {
		t.Fatal("SVG content was accepted")
	}
}

func TestUploadCompensatesForStorageAndActivationFailures(t *testing.T) {
	t.Parallel()
	actorID := uuid.New()
	workspaceID := uuid.New()
	attachmentID := uuid.New()
	storageKey := "attachments/" + workspaceID.String() + "/" + attachmentID.String()
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)

	for _, scenario := range []struct {
		name          string
		putError      error
		activationErr error
		wantDelete    bool
		wantStatus    int
	}{
		{
			name:       "storage write",
			putError:   errors.New("backend unavailable"),
			wantStatus: http.StatusServiceUnavailable,
		},
		{
			name:          "metadata activation",
			activationErr: errors.New("database unavailable"),
			wantDelete:    true,
			wantStatus:    http.StatusInternalServerError,
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			t.Parallel()
			store := &uploadStoreFake{
				reserved: repository.Attachment{
					ID:          attachmentID,
					WorkspaceID: workspaceID,
					StorageKey:  storageKey,
				},
				activationErr: scenario.activationErr,
			}
			backend := &uploadBackendFake{putError: scenario.putError}
			upload := newStagedUpload(t, []byte("attachment body"))
			request := httptest.NewRequest(http.MethodPost, "/upload", nil)
			request = request.WithContext(auth.WithUser(request.Context(), auth.User{
				ID: actorID,
			}))
			response := httptest.NewRecorder()
			ids := []uuid.UUID{attachmentID, uuid.New()}
			executeUpload(
				response,
				request,
				handlerOptions{Options: Options{
					Store:   store,
					Storage: backend,
					Clock:   func() time.Time { return now },
					NewID: func() uuid.UUID {
						next := ids[0]
						ids = ids[1:]
						return next
					},
				}},
				"BOARD-1",
				nil,
				upload,
			)

			if response.Code != scenario.wantStatus {
				t.Fatalf("status = %d, body=%s", response.Code, response.Body)
			}
			if store.abortActor != actorID || store.abortAttachment != attachmentID {
				t.Fatalf(
					"abort = (%s, %s), want (%s, %s)",
					store.abortActor,
					store.abortAttachment,
					actorID,
					attachmentID,
				)
			}
			if backend.putKey != storageKey {
				t.Fatalf("storage key = %q, want repository key %q", backend.putKey, storageKey)
			}
			if backend.deleted != scenario.wantDelete {
				t.Fatalf("storage delete = %t, want %t", backend.deleted, scenario.wantDelete)
			}
			if strings.Contains(response.Body.String(), storageKey) ||
				strings.Contains(response.Body.String(), upload.file.Name()) {
				t.Fatalf("response leaked backend path: %s", response.Body)
			}
		})
	}
}

func TestMultipartUploadReplaysAnIdenticalIdempotentRequest(t *testing.T) {
	t.Parallel()
	actorID, workspaceID, attachmentID, eventID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	storageKey := "attachments/" + workspaceID.String() + "/" + attachmentID.String()
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	store := &uploadStoreFake{reserved: repository.Attachment{
		ID:          attachmentID,
		WorkspaceID: workspaceID,
		IssueID:     uuid.New(),
		FileName:    "note.txt",
		ContentType: "text/plain",
		SizeBytes:   5,
		StorageKey:  storageKey,
		CreatedAt:   now,
	}}
	backend := &uploadBackendFake{}
	idempotency := &uploadIdempotencyFake{claimID: uuid.New()}
	ids := []uuid.UUID{attachmentID, eventID}
	options := handlerOptions{
		Options: Options{
			Store:            store,
			Storage:          backend,
			IdempotencyStore: idempotency,
			Clock:            func() time.Time { return now },
			NewID: func() uuid.UUID {
				next := ids[0]
				ids = ids[1:]
				return next
			},
		},
		maxBytes: hardMaxAttachmentBytes,
	}
	router := chi.NewRouter()
	router.Post("/issues/{issueRef}/attachments", func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		request = request.WithContext(auth.WithUser(request.Context(), auth.User{ID: actorID}))
		uploadIssueHandler(options).ServeHTTP(response, request)
	})

	first := executeMultipartRequest(t, router, "idempotency-key-0001", []byte("hello"))
	second := executeMultipartRequest(t, router, "idempotency-key-0001", []byte("hello"))

	if first.Code != http.StatusCreated || second.Code != http.StatusCreated {
		t.Fatalf(
			"statuses = %d/%d, bodies=%s/%s",
			first.Code,
			second.Code,
			first.Body,
			second.Body,
		)
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("replay body differs: %s != %s", first.Body, second.Body)
	}
	if store.reserveCalls != 1 || backend.putCount != 1 {
		t.Fatalf(
			"reserve calls=%d storage writes=%d, want 1/1",
			store.reserveCalls,
			backend.putCount,
		)
	}
}

func TestAttachmentSerializationDoesNotExposeStorageMetadata(t *testing.T) {
	t.Parallel()
	attachment := repository.Attachment{
		ID:          uuid.New(),
		IssueID:     uuid.New(),
		FileName:    "safe.txt",
		ContentType: "text/plain",
		SizeBytes:   4,
		StorageKey:  "attachments/private/backend-key",
		CreatedAt:   time.Now(),
	}
	encoded, err := json.Marshal(serializeAttachment(attachment))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"storageKey", "checksum", attachment.StorageKey} {
		if bytes.Contains(encoded, []byte(forbidden)) {
			t.Fatalf("serialized attachment leaked %q: %s", forbidden, encoded)
		}
	}
}

func newStagedUpload(t *testing.T, body []byte) *stagedUpload {
	t.Helper()
	file, err := os.CreateTemp("", "berry-staged-upload-*")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(body); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	upload := &stagedUpload{
		file:        file,
		fileName:    "attachment.txt",
		contentType: "text/plain",
		size:        int64(len(body)),
		checksum:    sum,
	}
	t.Cleanup(upload.close)
	return upload
}

func executeMultipartRequest(
	t *testing.T,
	handler http.Handler,
	idempotencyKey string,
	content []byte,
) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="note.txt"`)
	header.Set("Content-Type", "text/plain; charset=utf-8")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		"/issues/BOARD-1/attachments",
		&body,
	)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Idempotency-Key", idempotencyKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

type uploadStoreFake struct {
	Store
	reserved        repository.Attachment
	activationErr   error
	abortActor      uuid.UUID
	abortAttachment uuid.UUID
	reserveCalls    int
}

func (store *uploadStoreFake) ReserveAttachment(
	context.Context,
	repository.ReserveAttachmentParams,
) (repository.Attachment, error) {
	store.reserveCalls++
	return store.reserved, nil
}

func (store *uploadStoreFake) ActivateAttachment(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
	time.Time,
) (repository.Attachment, repository.Event, error) {
	if store.activationErr != nil {
		return repository.Attachment{}, repository.Event{}, store.activationErr
	}
	return store.reserved, repository.Event{}, nil
}

func (store *uploadStoreFake) AbortAttachment(
	_ context.Context,
	actorID, attachmentID uuid.UUID,
) error {
	store.abortActor = actorID
	store.abortAttachment = attachmentID
	return nil
}

type uploadBackendFake struct {
	putError error
	putKey   string
	deleted  bool
	putCount int
}

func (backend *uploadBackendFake) Put(
	_ context.Context,
	key string,
	body io.Reader,
) (storage.Object, error) {
	backend.putCount++
	backend.putKey = key
	content, err := io.ReadAll(body)
	if err != nil {
		return storage.Object{}, err
	}
	if backend.putError != nil {
		return storage.Object{}, backend.putError
	}
	return storage.Object{Key: key, Size: int64(len(content))}, nil
}

func (*uploadBackendFake) Open(context.Context, string) (io.ReadCloser, error) {
	return nil, errors.New("not implemented")
}

func (backend *uploadBackendFake) Delete(context.Context, string) error {
	backend.deleted = true
	return nil
}

type uploadIdempotencyFake struct {
	claimID     uuid.UUID
	fingerprint [sha256.Size]byte
	response    *httpapi.StoredResponse
}

func (store *uploadIdempotencyFake) Begin(
	_ context.Context,
	_ httpapi.ActorScope,
	_ string,
	fingerprint [sha256.Size]byte,
	_ time.Time,
) (httpapi.IdempotencyResult, error) {
	if store.response != nil {
		if fingerprint != store.fingerprint {
			return httpapi.IdempotencyResult{Decision: httpapi.IdempotencyConflict}, nil
		}
		return httpapi.IdempotencyResult{
			Decision: httpapi.IdempotencyReplay,
			Response: *store.response,
		}, nil
	}
	store.fingerprint = fingerprint
	return httpapi.IdempotencyResult{
		Decision: httpapi.IdempotencyProceed,
		ClaimID:  store.claimID,
	}, nil
}

func (store *uploadIdempotencyFake) Complete(
	_ context.Context,
	_ uuid.UUID,
	response httpapi.StoredResponse,
	_ time.Time,
) error {
	store.response = &response
	return nil
}

func (*uploadIdempotencyFake) Abandon(context.Context, uuid.UUID) error {
	return nil
}
