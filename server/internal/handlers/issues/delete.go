package issues

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// deleteHandler removes an issue from the product without destroying it.
//
// Gated on the same permission as editing, matching how comments and projects
// already work: someone trusted to change an issue is trusted to remove it.
//
// The deletion is soft, so what the issue owned survives — its runs, the
// history of what agents did through it, and the artifacts they produced. That
// is deliberate rather than incidental: an issue is deleted because it is no
// longer wanted on a board, which is not a reason to destroy the record of work
// already done.
func deleteHandler(
	repository *core.Repository,
	options Options,
) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		found, err := repository.GetIssue(request.Context(), chi.URLParam(request, "issueRef"))
		if errors.Is(err, core.ErrNotFound) {
			writeIssueNotFound(response, request)
			return
		}
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		if _, err := options.Authorization.AuthorizeIssue(
			request.Context(),
			user.ID,
			found.ID,
			identity.PermissionWrite,
		); !writeIssueAuthorization(response, request, err, false) {
			return
		}

		_, events, err := repository.DeleteIssue(request.Context(), core.DeleteIssueParams{
			IssueID:   found.ID,
			DeletedBy: user.ID,
			DeletedAt: options.Clock().UTC(),
			NewID:     options.NewID,
		})
		if err != nil {
			// Already deleted reads as not-found, so a second click from a
			// stale board says something true rather than reporting success
			// for work it did not do.
			if errors.Is(err, core.ErrNotFound) {
				writeIssueNotFound(response, request)
				return
			}
			writeIssueInternal(response, request)
			return
		}
		shared.PublishIssue(request.Context(), options.Broadcaster, events)
		response.WriteHeader(http.StatusNoContent)
	}
}
