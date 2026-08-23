package attachments

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	shared "github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	repository "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/storage"
)

const multipartOverheadBytes = int64(1024 * 1024)

type stagedUpload struct {
	file        *os.File
	fileName    string
	contentType string
	size        int64
	checksum    [sha256.Size]byte
}

func (upload *stagedUpload) close() {
	if upload == nil || upload.file == nil {
		return
	}
	name := upload.file.Name()
	_ = upload.file.Close()
	_ = os.Remove(name)
}

func uploadIssueHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		upload, commentID, ok := parseMultipartUpload(response, request, options.maxBytes, true)
		if !ok {
			return
		}
		defer upload.close()
		executeIdempotentUpload(
			response,
			request,
			options,
			chi.URLParam(request, "issueRef"),
			commentID,
			upload,
		)
	}
}

func uploadCommentHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		commentID, ok := parseCommentID(response, request)
		if !ok {
			return
		}
		upload, _, ok := parseMultipartUpload(response, request, options.maxBytes, false)
		if !ok {
			return
		}
		defer upload.close()
		executeIdempotentUpload(response, request, options, "", &commentID, upload)
	}
}

func executeIdempotentUpload(
	response http.ResponseWriter,
	request *http.Request,
	options handlerOptions,
	issueReference string,
	commentID *uuid.UUID,
	upload *stagedUpload,
) {
	keys := request.Header.Values("Idempotency-Key")
	if len(keys) != 1 || httpapi.ValidateIdempotencyKey(keys[0]) != nil {
		shared.WriteValidation(response, request, httpapi.FieldError{
			Path:    "/headers/Idempotency-Key",
			Code:    "invalid",
			Message: "Idempotency-Key must contain 16 to 128 visible ASCII characters.",
		})
		return
	}
	user := auth.MustUser(request.Context())
	fingerprint := uploadFingerprint(issueReference, commentID, upload)
	result, err := options.IdempotencyStore.Begin(
		request.Context(),
		httpapi.ActorScope{
			ActorType:     "user",
			ActorID:       user.ID,
			Method:        http.MethodPost,
			CanonicalPath: request.URL.Path,
		},
		keys[0],
		fingerprint,
		options.Clock().UTC(),
	)
	if err != nil {
		httpapi.WriteError(
			response,
			request,
			http.StatusInternalServerError,
			"INTERNAL",
			"Internal server error.",
			nil,
		)
		return
	}
	switch result.Decision {
	case httpapi.IdempotencyReplay:
		httpapi.Replay(response, result.Response)
		return
	case httpapi.IdempotencyConflict:
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"IDEMPOTENCY_CONFLICT",
			"Idempotency-Key was already used with a different request body.",
			nil,
		)
		return
	case httpapi.IdempotencyInProgress:
		response.Header().Set("Retry-After", "1")
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"CONFLICT",
			"An identical request is already in progress.",
			nil,
		)
		return
	case httpapi.IdempotencyProceed:
	default:
		httpapi.WriteError(
			response,
			request,
			http.StatusInternalServerError,
			"INTERNAL",
			"Internal server error.",
			nil,
		)
		return
	}
	captured := newUploadResponse()
	completed := false
	defer func() {
		if recovered := recover(); recovered != nil {
			if !completed {
				_ = options.IdempotencyStore.Abandon(
					context.WithoutCancel(request.Context()),
					result.ClaimID,
				)
			}
			panic(recovered)
		}
	}()
	executeUpload(
		captured,
		request,
		options,
		issueReference,
		commentID,
		upload,
	)
	stored := httpapi.StoredResponse{
		Status:  captured.statusCode(),
		Headers: captured.header.Clone(),
		Body:    bytes.Clone(captured.body.Bytes()),
	}
	if err := options.IdempotencyStore.Complete(
		context.WithoutCancel(request.Context()),
		result.ClaimID,
		stored,
		options.Clock().UTC(),
	); err != nil {
		_ = options.IdempotencyStore.Abandon(
			context.WithoutCancel(request.Context()),
			result.ClaimID,
		)
		if stored.Status < http.StatusInternalServerError {
			httpapi.WriteError(
				response,
				request,
				http.StatusInternalServerError,
				"INTERNAL",
				"Internal server error.",
				nil,
			)
			return
		}
	}
	completed = true
	copyUploadResponse(response, captured)
}

func executeUpload(
	response http.ResponseWriter,
	request *http.Request,
	options handlerOptions,
	issueReference string,
	commentID *uuid.UUID,
	upload *stagedUpload,
) {
	user := auth.MustUser(request.Context())
	attachmentID := options.NewID()
	eventID := options.NewID()
	now := options.Clock().UTC()
	reserved, err := options.Store.ReserveAttachment(
		request.Context(),
		repository.ReserveAttachmentParams{
			ID:             attachmentID,
			IssueReference: issueReference,
			CommentID:      commentID,
			UploaderID:     user.ID,
			FileName:       upload.fileName,
			ContentType:    upload.contentType,
			SizeBytes:      upload.size,
			ChecksumSHA256: upload.checksum,
			CreatedAt:      now,
		},
	)
	if err != nil {
		resource := "Issue"
		if issueReference == "" {
			resource = "Comment"
		}
		shared.WriteRepositoryError(response, request, err, resource)
		return
	}
	storageKey := reserved.StorageKey
	if _, err := upload.file.Seek(0, io.SeekStart); err != nil {
		_ = options.Store.AbortAttachment(
			context.WithoutCancel(request.Context()),
			user.ID,
			attachmentID,
		)
		writeStorageUnavailable(response, request)
		return
	}
	checksum := base64.StdEncoding.EncodeToString(upload.checksum[:])
	var object storage.Object
	if metadata, ok := options.Storage.(storage.MetadataBackend); ok {
		object, err = metadata.PutWithOptions(
			request.Context(),
			storageKey,
			upload.file,
			storage.PutOptions{
				ContentType:    upload.contentType,
				ChecksumSHA256: checksum,
				Metadata: map[string]string{
					"attachment-id": attachmentID.String(),
				},
			},
		)
	} else {
		object, err = options.Storage.Put(request.Context(), storageKey, upload.file)
	}
	if err != nil {
		_ = options.Store.AbortAttachment(
			context.WithoutCancel(request.Context()),
			user.ID,
			attachmentID,
		)
		if errors.Is(err, storage.ErrObjectTooLarge) {
			httpapi.WriteError(
				response,
				request,
				http.StatusRequestEntityTooLarge,
				"PAYLOAD_TOO_LARGE",
				"Attachment is too large.",
				nil,
			)
			return
		}
		writeStorageUnavailable(response, request)
		return
	}
	if object.Key != storageKey || object.Size != upload.size ||
		(object.ChecksumSHA256 != "" && object.ChecksumSHA256 != checksum) {
		_ = options.Storage.Delete(context.WithoutCancel(request.Context()), storageKey)
		_ = options.Store.AbortAttachment(
			context.WithoutCancel(request.Context()),
			user.ID,
			attachmentID,
		)
		writeStorageUnavailable(response, request)
		return
	}
	created, event, err := options.Store.ActivateAttachment(
		request.Context(),
		user.ID,
		attachmentID,
		eventID,
		now,
	)
	if err != nil {
		_ = options.Storage.Delete(context.WithoutCancel(request.Context()), storageKey)
		_ = options.Store.AbortAttachment(
			context.WithoutCancel(request.Context()),
			user.ID,
			attachmentID,
		)
		shared.WriteRepositoryError(response, request, err, "Attachment")
		return
	}
	if created.ID == uuid.Nil {
		created = reserved
	}
	shared.Publish(request.Context(), options.Broadcaster, event)
	response.Header().Set("Location", "/api/v1/attachments/"+created.ID.String())
	httpapi.WriteJSON(response, http.StatusCreated, serializeAttachment(created))
}

func parseMultipartUpload(
	response http.ResponseWriter,
	request *http.Request,
	maxBytes int64,
	allowCommentID bool,
) (*stagedUpload, *uuid.UUID, bool) {
	contentTypes := request.Header.Values("Content-Type")
	if len(contentTypes) != 1 {
		writeInvalidMultipart(response, request)
		return nil, nil, false
	}
	mediaType, parameters, err := mime.ParseMediaType(contentTypes[0])
	if err != nil || !strings.EqualFold(mediaType, "multipart/form-data") ||
		parameters["boundary"] == "" {
		writeInvalidMultipart(response, request)
		return nil, nil, false
	}
	request.Body = http.MaxBytesReader(
		response,
		request.Body,
		maxBytes+multipartOverheadBytes,
	)
	reader := multipart.NewReader(request.Body, parameters["boundary"])
	var (
		upload       *stagedUpload
		commentID    *uuid.UUID
		commentIDSet bool
	)
	fail := func(fields ...httpapi.FieldError) (*stagedUpload, *uuid.UUID, bool) {
		if upload != nil {
			upload.close()
		}
		shared.WriteValidation(response, request, fields...)
		return nil, nil, false
	}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if upload != nil {
				upload.close()
			}
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				writeAttachmentTooLarge(response, request)
			} else {
				writeInvalidMultipart(response, request)
			}
			return nil, nil, false
		}
		name := part.FormName()
		switch name {
		case "file":
			if upload != nil || part.FileName() == "" {
				_ = part.Close()
				return fail(httpapi.FieldError{
					Path:    "/file",
					Code:    "invalid",
					Message: "Exactly one file part is required.",
				})
			}
			staged, err := stageFilePart(part, maxBytes)
			_ = part.Close()
			if err != nil {
				var validation *uploadValidationError
				if errors.As(err, &validation) {
					return fail(validation.field)
				}
				if errors.Is(err, storage.ErrObjectTooLarge) {
					if upload != nil {
						upload.close()
					}
					writeAttachmentTooLarge(response, request)
					return nil, nil, false
				}
				if upload != nil {
					upload.close()
				}
				writeInvalidMultipart(response, request)
				return nil, nil, false
			}
			upload = staged
		case "commentId":
			if !allowCommentID || commentIDSet || part.FileName() != "" {
				_ = part.Close()
				return fail(httpapi.FieldError{
					Path:    "/commentId",
					Code:    "invalid",
					Message: "commentId is not allowed or was repeated.",
				})
			}
			commentIDSet = true
			value, err := io.ReadAll(io.LimitReader(part, 65))
			_ = part.Close()
			if err != nil || len(value) == 0 || len(value) > 64 {
				return fail(httpapi.FieldError{
					Path:    "/commentId",
					Code:    "invalid_string",
					Message: "commentId must be a UUID.",
				})
			}
			parsed, err := coreParseUUID(string(value))
			if err != nil {
				return fail(httpapi.FieldError{
					Path:    "/commentId",
					Code:    "invalid_string",
					Message: "commentId must be a UUID.",
				})
			}
			commentID = &parsed
		default:
			_ = part.Close()
			path := "/"
			if name != "" {
				path += name
			}
			return fail(httpapi.FieldError{
				Path:    path,
				Code:    "unknown_field",
				Message: "Unknown multipart field.",
			})
		}
	}
	if upload == nil {
		return fail(httpapi.FieldError{
			Path:    "/file",
			Code:    "invalid_type",
			Message: "File is required.",
		})
	}
	return upload, commentID, true
}

func stageFilePart(part *multipart.Part, maxBytes int64) (*stagedUpload, error) {
	rawDisposition := part.Header.Get("Content-Disposition")
	_, parameters, err := mime.ParseMediaType(rawDisposition)
	if err != nil || !validFileName(parameters["filename"]) {
		return nil, &uploadValidationError{field: httpapi.FieldError{
			Path:    "/file",
			Code:    "invalid_name",
			Message: "File name is invalid or too long.",
		}}
	}
	file, err := os.CreateTemp("", "berry-attachment-upload-*")
	if err != nil {
		return nil, err
	}
	staged := &stagedUpload{file: file, fileName: parameters["filename"]}
	success := false
	defer func() {
		if !success {
			staged.close()
		}
	}()
	collector := &uploadCollector{
		target: file,
		hash:   sha256.New(),
		sniff:  make([]byte, 0, 512),
	}
	size, err := io.Copy(collector, io.LimitReader(part, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if size > maxBytes {
		return nil, storage.ErrObjectTooLarge
	}
	if size == 0 {
		return nil, &uploadValidationError{field: httpapi.FieldError{
			Path:    "/file",
			Code:    "too_small",
			Message: "File must contain at least one byte.",
		}}
	}
	copy(staged.checksum[:], collector.hash.Sum(nil))
	staged.size = size
	contentType, err := validateUploadContentType(
		part.Header.Get("Content-Type"),
		collector.sniff,
		file,
	)
	if err != nil {
		return nil, &uploadValidationError{field: httpapi.FieldError{
			Path:    "/file",
			Code:    "unsupported_media_type",
			Message: "File type is not allowed or does not match its content.",
		}}
	}
	staged.contentType = contentType
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	success = true
	return staged, nil
}

type uploadCollector struct {
	target io.Writer
	hash   hash.Hash
	sniff  []byte
}

func (collector *uploadCollector) Write(buffer []byte) (int, error) {
	written, err := collector.target.Write(buffer)
	if written > 0 {
		_, _ = collector.hash.Write(buffer[:written])
		remaining := 512 - len(collector.sniff)
		if remaining > written {
			remaining = written
		}
		if remaining > 0 {
			collector.sniff = append(collector.sniff, buffer[:remaining]...)
		}
	}
	return written, err
}

type uploadValidationError struct {
	field httpapi.FieldError
}

func (validation *uploadValidationError) Error() string {
	return validation.field.Message
}

func validFileName(value string) bool {
	if value == "" || value == "." || value == ".." || len(value) > 255 ||
		!utf8.ValidString(value) || utf8.RuneCountInString(value) > 255 ||
		strings.TrimSpace(value) != value ||
		strings.ContainsAny(value, `/\`) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validateUploadContentType(
	declared string,
	sniff []byte,
	file *os.File,
) (string, error) {
	detected, _, err := mime.ParseMediaType(http.DetectContentType(sniff))
	if err != nil {
		return "", err
	}
	declaredType := ""
	if strings.TrimSpace(declared) != "" {
		var parameters map[string]string
		declaredType, parameters, err = mime.ParseMediaType(declared)
		if err != nil {
			return "", err
		}
		declaredType = strings.ToLower(declaredType)
		for name, value := range parameters {
			if name != "charset" || !strings.EqualFold(value, "utf-8") {
				return "", errors.New("unsupported content type parameter")
			}
		}
	} else {
		declaredType = strings.ToLower(detected)
	}
	detected = strings.ToLower(detected)
	switch declaredType {
	case "image/png", "image/jpeg", "image/gif", "image/webp",
		"application/pdf", "application/zip":
		if detected != declaredType {
			return "", errors.New("content type mismatch")
		}
	case "text/plain", "text/markdown":
		if detected != "text/plain" {
			return "", errors.New("content type mismatch")
		}
	case "application/json":
		if detected != "text/plain" {
			return "", errors.New("content type mismatch")
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return "", err
		}
		body, err := io.ReadAll(file)
		if err != nil || !json.Valid(body) {
			return "", errors.New("invalid JSON attachment")
		}
	default:
		return "", errors.New("unsupported content type")
	}
	return declaredType, nil
}

func uploadFingerprint(
	issueReference string,
	commentID *uuid.UUID,
	upload *stagedUpload,
) [sha256.Size]byte {
	hash := sha256.New()
	writeFingerprintField(hash, strings.ToLower(issueReference))
	if commentID != nil {
		writeFingerprintField(hash, commentID.String())
	} else {
		writeFingerprintField(hash, "")
	}
	writeFingerprintField(hash, upload.fileName)
	writeFingerprintField(hash, upload.contentType)
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(upload.size))
	_, _ = hash.Write(size[:])
	_, _ = hash.Write(upload.checksum[:])
	var result [sha256.Size]byte
	copy(result[:], hash.Sum(nil))
	return result
}

func writeFingerprintField(target io.Writer, value string) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = target.Write(size[:])
	_, _ = io.WriteString(target, value)
}

func coreParseUUID(value string) (uuid.UUID, error) {
	id, err := uuid.Parse(value)
	if err != nil || id == uuid.Nil || id.Variant() != uuid.RFC4122 ||
		!strings.EqualFold(id.String(), value) {
		return uuid.Nil, errors.New("invalid canonical UUID")
	}
	return id, nil
}

func writeInvalidMultipart(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The multipart request is invalid.",
		nil,
	)
}

func writeAttachmentTooLarge(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusRequestEntityTooLarge,
		"PAYLOAD_TOO_LARGE",
		"Attachment is too large.",
		nil,
	)
}

type uploadResponse struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func newUploadResponse() *uploadResponse {
	return &uploadResponse{header: make(http.Header)}
}

func (response *uploadResponse) Header() http.Header {
	return response.header
}

func (response *uploadResponse) WriteHeader(status int) {
	if response.status == 0 {
		response.status = status
	}
}

func (response *uploadResponse) Write(body []byte) (int, error) {
	if response.status == 0 {
		response.status = http.StatusOK
	}
	return response.body.Write(body)
}

func (response *uploadResponse) statusCode() int {
	if response.status == 0 {
		return http.StatusOK
	}
	return response.status
}

func copyUploadResponse(destination http.ResponseWriter, source *uploadResponse) {
	for name, values := range source.header {
		for _, value := range values {
			destination.Header().Add(name, value)
		}
	}
	destination.WriteHeader(source.statusCode())
	_, _ = destination.Write(source.body.Bytes())
}
