package runs

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/repository/collaboration"
)

// ArtifactStore lists what a run produced (ADR-0006).
type ArtifactStore interface {
	ListRunArtifacts(
		context.Context, uuid.UUID, *collaboration.AttachmentCursor, int,
	) ([]collaboration.Attachment, error)
}

type artifactResource struct {
	ID          uuid.UUID `json:"id"`
	FileName    string    `json:"fileName"`
	ContentType string    `json:"contentType"`
	SizeBytes   int64     `json:"sizeBytes"`
	Uploader    *actorRef `json:"uploader"`
	CreatedAt   time.Time `json:"createdAt"`
}

type actorRef struct {
	Type      string    `json:"type"`
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	AvatarURL *string   `json:"avatarUrl"`
}

// listRunArtifacts answers "what did this run produce".
//
// The storage key is deliberately absent from the response. It is private
// implementation detail, and bytes are reached through the attachment download
// routes, which presign — the same path a human upload takes.
func (handlers *Handlers) listRunArtifacts(response http.ResponseWriter, request *http.Request) {
	runID, ok := parseRunID(response, request)
	if !ok {
		return
	}
	if handlers.artifacts == nil {
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"artifacts": []artifactResource{}})
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handlers.authorization.AuthorizeRun(
		request.Context(),
		user.ID,
		runID,
		identity.PermissionRead,
	); !writeRunAuthorization(response, request, err, "run") {
		return
	}

	artifacts, err := handlers.artifacts.ListRunArtifacts(request.Context(), runID, nil, 100)
	if err != nil {
		writeInternal(response, request)
		return
	}
	resources := make([]artifactResource, 0, len(artifacts))
	for _, artifact := range artifacts {
		resource := artifactResource{
			ID:          artifact.ID,
			FileName:    artifact.FileName,
			ContentType: artifact.ContentType,
			SizeBytes:   artifact.SizeBytes,
			CreatedAt:   artifact.CreatedAt,
		}
		if artifact.Uploader != nil {
			kind := artifact.UploaderType
			if kind == "" {
				kind = "user"
			}
			resource.Uploader = &actorRef{
				Type:      kind,
				ID:        artifact.Uploader.ID,
				Name:      artifact.Uploader.Name,
				AvatarURL: artifact.Uploader.AvatarURL,
			}
		}
		resources = append(resources, resource)
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"artifacts": resources})
}
