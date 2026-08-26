package attachments

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	shared "github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	repository "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
)

// Run artifacts are listed beside attachments but are not attachments.
//
// A person's upload has a name; an agent's output has a path, and the shape of
// the tree is part of the work (migration 027). They share a route prefix
// because the drawer shows both under "Files", and nothing else.

// ArtifactStore lists what the agents on an issue produced.
type ArtifactStore interface {
	ListIssueArtifactsFor(context.Context, uuid.UUID, string, int) ([]repository.RunArtifact, error)
}

type artifactResource struct {
	ID string `json:"id"`
	// Path is the file's location inside the run's output directory, which is
	// what the tree is built from. Name is its leaf, for a download.
	Path        string    `json:"path"`
	Name        string    `json:"name"`
	Directory   string    `json:"directory"`
	ContentType string    `json:"contentType"`
	SizeBytes   int64     `json:"sizeBytes"`
	RunID       string    `json:"runId"`
	AgentName   string    `json:"agentName"`
	DownloadURL string    `json:"downloadUrl"`
	CreatedAt   time.Time `json:"createdAt"`
}

// NewIssueArtifactHandler returns routes mounted at
// /api/v1/issues/{issueRef}/artifacts.
func NewIssueArtifactHandler(store ArtifactStore, sessions auth.SessionResolver) (http.Handler, error) {
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(sessions))
	router.Get("/", listIssueArtifacts(store))
	return router, nil
}

func listIssueArtifacts(store ArtifactStore) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if store == nil {
			httpapi.WriteJSON(response, http.StatusOK, map[string]any{"artifacts": []artifactResource{}})
			return
		}
		user := auth.MustUser(request.Context())
		rows, err := store.ListIssueArtifactsFor(
			request.Context(), user.ID, chi.URLParam(request, "issueRef"), 200,
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Issue")
			return
		}
		resources := make([]artifactResource, 0, len(rows))
		for _, artifact := range rows {
			resources = append(resources, artifactResource{
				ID:          artifact.ID.String(),
				Path:        artifact.Path,
				Name:        artifact.Name(),
				Directory:   artifact.Directory(),
				ContentType: artifact.ContentType,
				SizeBytes:   artifact.SizeBytes,
				RunID:       artifact.RunID.String(),
				AgentName:   artifact.AgentName,
				// Through the run, because that is where the read is
				// authorised: an artifact is readable by whoever may read the
				// run that produced it.
				DownloadURL: "/api/v1/runs/" + artifact.RunID.String() +
					"/artifacts/" + artifact.ID.String() + "/download",
				CreatedAt: artifact.CreatedAt,
			})
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"artifacts": resources})
	}
}
