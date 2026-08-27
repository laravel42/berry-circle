package issues

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/repository/collaboration"
)

// A rejected auto review left the task in review with nothing to read. The
// verdict was recorded, the reason was written, and no surface showed either,
// so an issue an agent had declined to approve looked exactly like one nobody
// had looked at yet.

// AutoReviewStore reads the verdicts on an issue.
type AutoReviewStore interface {
	ListIssueAutoReviews(
		context.Context, uuid.UUID, string, int,
	) ([]collaboration.AutoReview, error)
}

type autoReviewResource struct {
	ID       uuid.UUID `json:"id"`
	RunID    uuid.UUID `json:"runId"`
	Reviewer string    `json:"reviewer"`
	Author   string    `json:"author"`
	// Approved is null while the reviewer is still reading.
	Approved   *bool      `json:"approved"`
	InProgress bool       `json:"inProgress"`
	Reason     string     `json:"reason"`
	Attempt    int        `json:"attempt"`
	StartedAt  time.Time  `json:"startedAt"`
	DecidedAt  *time.Time `json:"decidedAt"`
}

func listAutoReviewsHandler(store AutoReviewStore) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		resources := []autoReviewResource{}
		if store == nil {
			httpapi.WriteJSON(response, http.StatusOK, map[string]any{"reviews": resources})
			return
		}
		user := auth.MustUser(request.Context())
		reviews, err := store.ListIssueAutoReviews(
			request.Context(), user.ID, chi.URLParam(request, "issueRef"), 20,
		)
		if err != nil {
			// A missing verdict list must not break the task view: the issue
			// and its activity are what the page is for.
			httpapi.WriteJSON(response, http.StatusOK, map[string]any{"reviews": resources})
			return
		}
		for _, review := range reviews {
			resources = append(resources, autoReviewResource{
				ID: review.ID, RunID: review.RunID, Reviewer: review.Reviewer,
				Author: review.Author, Approved: review.Approved,
				InProgress: review.InProgress(), Reason: review.Reason,
				Attempt: review.Attempt, StartedAt: review.StartedAt,
				DecidedAt: review.DecidedAt,
			})
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"reviews": resources})
	}
}
