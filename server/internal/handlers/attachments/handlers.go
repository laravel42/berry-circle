// Package attachments exposes authenticated metadata, upload, download, and
// deletion routes without serializing backend object keys or filesystem paths.
package attachments

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	shared "github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	repository "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/storage"
)

const hardMaxAttachmentBytes = int64(25 * 1024 * 1024)

// Store is the narrow attachment persistence boundary.
type Store interface {
	ReserveAttachment(
		context.Context,
		repository.ReserveAttachmentParams,
	) (repository.Attachment, error)
	ActivateAttachment(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) (repository.Attachment, repository.Event, error)
	AbortAttachment(context.Context, uuid.UUID, uuid.UUID) error
	GetAttachment(context.Context, uuid.UUID, uuid.UUID) (repository.Attachment, error)
	ListIssueAttachments(
		context.Context,
		uuid.UUID,
		string,
		*uuid.UUID,
		*repository.AttachmentCursor,
		int,
	) ([]repository.Attachment, error)
	ListCommentAttachments(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		*repository.AttachmentCursor,
		int,
	) ([]repository.Attachment, error)
	BeginAttachmentDelete(
		context.Context,
		uuid.UUID,
		uuid.UUID,
	) (repository.Attachment, error)
	CancelAttachmentDelete(context.Context, uuid.UUID, uuid.UUID) error
	CompleteAttachmentDelete(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) (repository.Event, error)
}

// Options are explicit process dependencies.
type Options struct {
	Store            Store
	Sessions         auth.SessionResolver
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Storage          storage.Backend
	Presigner        storage.PresigningBackend
	Broadcaster      realtime.Broadcaster
	MaxBytes         int64
}

type handlerOptions struct {
	Options
	maxBytes int64
}

// NewMount returns the disjoint /api/v1/attachments metadata/download mount.
func NewMount(options Options) (httpapi.Mount, error) {
	validated, err := validateOptions(options)
	if err != nil {
		return httpapi.Mount{}, err
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(validated.Sessions))
	router.Get("/{attachmentId}", getHandler(validated))
	router.Get("/{attachmentId}/download", downloadHandler(validated))
	router.Get("/{attachmentId}/download-url", downloadURLHandler(validated))
	router.Delete("/{attachmentId}", deleteHandler(validated))
	return httpapi.Mount{Prefix: "/api/v1/attachments", Handler: router}, nil
}

// NewIssueHandler returns routes mounted at
// /api/v1/issues/{issueRef}/attachments.
func NewIssueHandler(options Options) (http.Handler, error) {
	validated, err := validateOptions(options)
	if err != nil {
		return nil, err
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(validated.Sessions))
	router.Get("/", listIssueHandler(validated))
	router.Post("/", uploadIssueHandler(validated))
	return router, nil
}

// NewCommentHandler returns routes mounted at
// /api/v1/comments/{commentId}/attachments.
func NewCommentHandler(options Options) (http.Handler, error) {
	validated, err := validateOptions(options)
	if err != nil {
		return nil, err
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(validated.Sessions))
	router.Get("/", listCommentHandler(validated))
	router.Post("/", uploadCommentHandler(validated))
	return router, nil
}

func validateOptions(options Options) (handlerOptions, error) {
	switch {
	case options.Store == nil:
		return handlerOptions{}, errors.New("attachment handler store is nil")
	case options.Sessions == nil:
		return handlerOptions{}, errors.New("attachment handler session resolver is nil")
	case options.Clock == nil:
		return handlerOptions{}, errors.New("attachment handler clock is nil")
	case options.NewID == nil:
		return handlerOptions{}, errors.New("attachment handler ID generator is nil")
	case options.IdempotencyStore == nil:
		return handlerOptions{}, errors.New("attachment handler idempotency store is nil")
	case options.Storage == nil:
		return handlerOptions{}, errors.New("attachment handler storage backend is nil")
	case options.Broadcaster == nil:
		return handlerOptions{}, errors.New("attachment handler broadcaster is nil")
	}
	maxBytes := options.MaxBytes
	if maxBytes == 0 || maxBytes > hardMaxAttachmentBytes {
		maxBytes = hardMaxAttachmentBytes
	}
	if maxBytes < 1 {
		return handlerOptions{}, errors.New("attachment handler max size must be positive")
	}
	return handlerOptions{Options: options, maxBytes: maxBytes}, nil
}

type actorResource struct {
	Type      string    `json:"type"`
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	AvatarURL *string   `json:"avatarUrl"`
}

type attachmentResource struct {
	ID          uuid.UUID      `json:"id"`
	IssueID     uuid.UUID      `json:"issueId"`
	CommentID   *uuid.UUID     `json:"commentId"`
	FileName    string         `json:"fileName"`
	ContentType string         `json:"contentType"`
	SizeBytes   int64          `json:"sizeBytes"`
	Uploader    *actorResource `json:"uploader"`
	DownloadURL string         `json:"downloadUrl"`
	CreatedAt   string         `json:"createdAt"`
}

type pageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type attachmentConnection struct {
	Nodes    []attachmentResource `json:"nodes"`
	PageInfo pageInfo             `json:"pageInfo"`
}

type downloadDescriptor struct {
	URL                    string              `json:"url"`
	Method                 string              `json:"method"`
	Headers                map[string][]string `json:"headers"`
	ExpiresAt              *string             `json:"expiresAt"`
	RequiresAuthentication bool                `json:"requiresAuthentication"`
}

func getHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		attachmentID, ok := parseAttachmentID(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		attachment, err := options.Store.GetAttachment(
			request.Context(),
			user.ID,
			attachmentID,
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Attachment")
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, serializeAttachment(attachment))
	}
}

func listIssueHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		first, encodedAfter, commentID, ok := parseListQuery(response, request, true)
		if !ok {
			return
		}
		issueReference := chi.URLParam(request, "issueRef")
		scope := attachmentCursorScope("issue", issueReference, commentID)
		after, ok := decodeAttachmentCursor(response, request, scope, encodedAfter)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		rows, err := options.Store.ListIssueAttachments(
			request.Context(),
			user.ID,
			issueReference,
			commentID,
			after,
			first+1,
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Issue")
			return
		}
		writeAttachmentPage(response, request, scope, rows, first)
	}
}

func listCommentHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		first, encodedAfter, _, ok := parseListQuery(response, request, false)
		if !ok {
			return
		}
		commentID, ok := parseCommentID(response, request)
		if !ok {
			return
		}
		scope := attachmentCursorScope("comment", commentID.String(), nil)
		after, ok := decodeAttachmentCursor(response, request, scope, encodedAfter)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		rows, err := options.Store.ListCommentAttachments(
			request.Context(),
			user.ID,
			commentID,
			after,
			first+1,
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Comment")
			return
		}
		writeAttachmentPage(response, request, scope, rows, first)
	}
}

func downloadHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		attachmentID, ok := parseAttachmentID(response, request)
		if !ok {
			return
		}
		if len(request.URL.Query()) != 0 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				nil,
			)
			return
		}
		user := auth.MustUser(request.Context())
		attachment, err := options.Store.GetAttachment(
			request.Context(),
			user.ID,
			attachmentID,
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Attachment")
			return
		}
		object, err := options.Storage.Open(request.Context(), attachment.StorageKey)
		if err != nil {
			writeStorageUnavailable(response, request)
			return
		}
		defer object.Close()
		response.Header().Set("Content-Type", attachment.ContentType)
		response.Header().Set("Content-Length", strconv.FormatInt(attachment.SizeBytes, 10))
		response.Header().Set("Content-Disposition", contentDisposition(attachment.FileName))
		response.Header().Set("Cache-Control", "private, no-store")
		response.WriteHeader(http.StatusOK)
		_, _ = io.Copy(response, object)
	}
}

func downloadURLHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		attachmentID, ok := parseAttachmentID(response, request)
		if !ok {
			return
		}
		if len(request.URL.Query()) != 0 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				nil,
			)
			return
		}
		user := auth.MustUser(request.Context())
		attachment, err := options.Store.GetAttachment(
			request.Context(),
			user.ID,
			attachmentID,
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Attachment")
			return
		}
		fallback := downloadDescriptor{
			URL:                    attachmentDownloadURL(attachment.ID),
			Method:                 http.MethodGet,
			Headers:                map[string][]string{},
			ExpiresAt:              nil,
			RequiresAuthentication: true,
		}
		if options.Presigner == nil {
			httpapi.WriteJSON(response, http.StatusOK, fallback)
			return
		}
		descriptor, err := options.Presigner.PresignGet(
			request.Context(),
			attachment.StorageKey,
			storage.PresignGetOptions{
				Expires:                    15 * time.Minute,
				ResponseContentDisposition: contentDisposition(attachment.FileName),
			},
		)
		if err != nil {
			writeStorageUnavailable(response, request)
			return
		}
		if descriptor.RequiresAuthentication {
			httpapi.WriteJSON(response, http.StatusOK, fallback)
			return
		}
		expiresAt := descriptor.ExpiresAt.UTC().Format(time.RFC3339Nano)
		httpapi.WriteJSON(response, http.StatusOK, downloadDescriptor{
			URL:                    descriptor.URL,
			Method:                 descriptor.Method,
			Headers:                descriptor.Header,
			ExpiresAt:              &expiresAt,
			RequiresAuthentication: false,
		})
	}
}

func deleteHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		attachmentID, ok := parseAttachmentID(response, request)
		if !ok {
			return
		}
		if len(request.URL.Query()) != 0 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				nil,
			)
			return
		}
		user := auth.MustUser(request.Context())
		attachment, err := options.Store.BeginAttachmentDelete(
			request.Context(),
			user.ID,
			attachmentID,
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Attachment")
			return
		}
		if err := options.Storage.Delete(request.Context(), attachment.StorageKey); err != nil {
			_ = options.Store.CancelAttachmentDelete(
				context.WithoutCancel(request.Context()),
				user.ID,
				attachmentID,
			)
			writeStorageUnavailable(response, request)
			return
		}
		event, err := options.Store.CompleteAttachmentDelete(
			request.Context(),
			user.ID,
			attachmentID,
			options.NewID(),
			options.Clock().UTC(),
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Attachment")
			return
		}
		shared.Publish(request.Context(), options.Broadcaster, event)
		response.WriteHeader(http.StatusNoContent)
	}
}

func parseListQuery(
	response http.ResponseWriter,
	request *http.Request,
	allowComment bool,
) (int, string, *uuid.UUID, bool) {
	query := request.URL.Query()
	for name, values := range query {
		allowed := name == "first" || name == "after" ||
			(allowComment && name == "commentId")
		if !allowed || len(values) != 1 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				nil,
			)
			return 0, "", nil, false
		}
	}
	first := 50
	if raw := query.Get("first"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 100 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				httpapi.ValidationDetails{Fields: []httpapi.FieldError{{
					Path:    "/query/first",
					Code:    "invalid",
					Message: "first must be an integer from 1 to 100.",
				}}},
			)
			return 0, "", nil, false
		}
		first = value
	}
	after := query.Get("after")
	if _, present := query["after"]; present && after == "" {
		writeInvalidCursor(response, request)
		return 0, "", nil, false
	}
	var commentID *uuid.UUID
	if raw, present := query["commentId"]; present {
		if raw[0] == "" {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				nil,
			)
			return 0, "", nil, false
		}
		parsed, err := core.ParseUUID(raw[0])
		if err != nil {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				httpapi.ValidationDetails{Fields: []httpapi.FieldError{{
					Path:    "/query/commentId",
					Code:    "invalid",
					Message: "commentId must be a UUID.",
				}}},
			)
			return 0, "", nil, false
		}
		commentID = &parsed
	}
	return first, after, commentID, true
}

func decodeAttachmentCursor(
	response http.ResponseWriter,
	request *http.Request,
	scope, encoded string,
) (*repository.AttachmentCursor, bool) {
	if encoded == "" {
		return nil, true
	}
	var decoded repository.AttachmentCursor
	if err := httpapi.DecodeCursor(encoded, scope, &decoded); err != nil ||
		decoded.ID == uuid.Nil || decoded.CreatedAt.IsZero() {
		writeInvalidCursor(response, request)
		return nil, false
	}
	return &decoded, true
}

func writeAttachmentPage(
	response http.ResponseWriter,
	request *http.Request,
	scope string,
	rows []repository.Attachment,
	first int,
) {
	hasNextPage := len(rows) > first
	if hasNextPage {
		rows = rows[:first]
	}
	nodes := make([]attachmentResource, 0, len(rows))
	for _, row := range rows {
		nodes = append(nodes, serializeAttachment(row))
	}
	var endCursor *string
	if len(rows) > 0 {
		last := rows[len(rows)-1]
		encoded, err := httpapi.EncodeCursor(scope, repository.AttachmentCursor{
			CreatedAt: last.CreatedAt,
			ID:        last.ID,
		})
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Attachment")
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, attachmentConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNextPage,
			EndCursor:   endCursor,
		},
	})
}

func parseAttachmentID(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, bool) {
	id, err := core.ParseUUID(chi.URLParam(request, "attachmentId"))
	if err != nil {
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			"Attachment not found.",
			nil,
		)
		return uuid.Nil, false
	}
	return id, true
}

func parseCommentID(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, bool) {
	id, err := core.ParseUUID(chi.URLParam(request, "commentId"))
	if err != nil {
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			"Comment not found.",
			nil,
		)
		return uuid.Nil, false
	}
	return id, true
}

func serializeAttachment(attachment repository.Attachment) attachmentResource {
	var uploader *actorResource
	if attachment.Uploader != nil {
		uploader = &actorResource{
			Type:      "user",
			ID:        attachment.Uploader.ID,
			Name:      attachment.Uploader.Name,
			AvatarURL: attachment.Uploader.AvatarURL,
		}
	}
	return attachmentResource{
		ID:          attachment.ID,
		IssueID:     attachment.IssueID,
		CommentID:   attachment.CommentID,
		FileName:    attachment.FileName,
		ContentType: attachment.ContentType,
		SizeBytes:   attachment.SizeBytes,
		Uploader:    uploader,
		DownloadURL: attachmentDownloadURL(attachment.ID),
		CreatedAt:   attachment.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func attachmentDownloadURL(id uuid.UUID) string {
	return "/api/v1/attachments/" + id.String() + "/download"
}

func contentDisposition(fileName string) string {
	value := mime.FormatMediaType("attachment", map[string]string{"filename": fileName})
	if value == "" {
		return "attachment"
	}
	return value
}

func attachmentCursorScope(
	kind, target string,
	commentID *uuid.UUID,
) string {
	filter := ""
	if commentID != nil {
		filter = commentID.String()
	}
	sum := sha256.Sum256([]byte(kind + ":" + strings.ToLower(target) + ":" + filter))
	return fmt.Sprintf("attachments.list.%x", sum[:8])
}

func writeInvalidCursor(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_CURSOR",
		"The pagination cursor is invalid.",
		nil,
	)
}

func writeStorageUnavailable(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusServiceUnavailable,
		"STORAGE_UNAVAILABLE",
		"Attachment storage is unavailable.",
		nil,
	)
}
