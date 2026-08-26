package runs

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/repository/collaboration"
)

// ArtifactStore lists what a run produced (ADR-0006).
type ArtifactStore interface {
	ListRunArtifacts(
		context.Context, uuid.UUID, *collaboration.RunArtifactCursor, int,
	) ([]collaboration.RunArtifact, error)
	GetRunArtifact(context.Context, uuid.UUID) (collaboration.RunArtifact, error)
}

// ArtifactBytes opens a stored artifact for download.
type ArtifactBytes interface {
	Open(context.Context, string) (io.ReadCloser, error)
}

type artifactResource struct {
	ID uuid.UUID `json:"id"`
	// Path is where the agent wrote the file, relative to its output
	// directory: `src/password/generator.ts`. FileName is the leaf, kept
	// because a download needs a name and a list has always shown one.
	Path        string    `json:"path"`
	FileName    string    `json:"fileName"`
	Directory   string    `json:"directory"`
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
			Path:        artifact.Path,
			FileName:    artifact.Name(),
			Directory:   artifact.Directory(),
			ContentType: artifact.ContentType,
			SizeBytes:   artifact.SizeBytes,
			CreatedAt:   artifact.CreatedAt,
		}
		if artifact.Agent != nil {
			resource.Uploader = &actorRef{
				Type: "agent",
				ID:   artifact.Agent.ID,
				Name: artifact.Agent.Name,
			}
		}
		resources = append(resources, resource)
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"artifacts": resources})
}

// downloadRunArtifact streams one file a run produced.
//
// Scoped through the run rather than through the artifact id alone: an
// artifact belongs to a run, the run to an issue, and the caller's right to
// read it is the right to read that run. An artifact id from another run is a
// 404 here even for a member of the workspace, which is the same answer they
// would get for one that does not exist.
func (handlers *Handlers) downloadRunArtifact(response http.ResponseWriter, request *http.Request) {
	runID, ok := parseRunID(response, request)
	if !ok {
		return
	}
	artifactID, err := uuid.Parse(chi.URLParam(request, "artifactId"))
	if err != nil {
		httpapi.WriteError(response, request, http.StatusBadRequest,
			"INVALID_REQUEST", "The artifact id is not a UUID.", nil)
		return
	}
	if handlers.artifacts == nil || handlers.artifactBytes == nil {
		writeNotFound(response, request)
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handlers.authorization.AuthorizeRun(
		request.Context(), user.ID, runID, identity.PermissionRead,
	); !writeRunAuthorization(response, request, err, "run") {
		return
	}

	artifact, err := handlers.artifacts.GetRunArtifact(request.Context(), artifactID)
	if err != nil || artifact.RunID != runID {
		writeNotFound(response, request)
		return
	}
	object, err := handlers.artifactBytes.Open(request.Context(), artifact.StorageKey)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusServiceUnavailable,
			"STORAGE_UNAVAILABLE", "The artifact store is unavailable.", nil)
		return
	}
	defer object.Close()

	response.Header().Set("Content-Type", artifact.ContentType)
	response.Header().Set("Content-Length", strconv.FormatInt(artifact.SizeBytes, 10))
	// Always an attachment, never inline: the bytes are model-authored, and a
	// browser that renders them would be running an agent's HTML on Berry's
	// origin. The name is the leaf, so a download is called generator.ts
	// rather than src-password-generator.ts.
	response.Header().Set("Content-Disposition", contentDisposition(artifact.Name()))
	response.Header().Set("Cache-Control", "private, no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(http.StatusOK)
	_, _ = io.Copy(response, object)
}

// contentDisposition quotes the filename and strips what would break the
// header, matching the attachment route's handling.
func contentDisposition(name string) string {
	safe := strings.Map(func(letter rune) rune {
		if letter < 0x20 || letter == 0x7f || letter == '"' || letter == '\\' {
			return -1
		}
		return letter
	}, name)
	if strings.TrimSpace(safe) == "" {
		safe = "artifact"
	}
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s",
		safe, url.PathEscape(name))
}
