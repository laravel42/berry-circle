package issues

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Dependencies say what an issue waits on. The database refuses cycles and
// cross-workspace edges; these routes translate those refusals and keep both
// ends inside the caller's workspace.

type dependencyResource struct {
	DependsOn []core.IssueDependencyRef `json:"dependsOn"`
	Blocks    []core.IssueDependencyRef `json:"blocks"`
}

type addDependencyBody struct {
	DependsOn string `json:"dependsOn"`
}

// authorizeDependencyIssue resolves the issue in the path with one permission.
func authorizeDependencyIssue(
	response http.ResponseWriter,
	request *http.Request,
	repository *core.Repository,
	options Options,
	reference string,
	permission identity.Permission,
) (core.Issue, identity.Scope, bool) {
	issue, err := repository.GetIssue(request.Context(), reference)
	if errors.Is(err, core.ErrNotFound) {
		writeIssueNotFound(response, request)
		return core.Issue{}, identity.Scope{}, false
	}
	if err != nil {
		writeIssueInternal(response, request)
		return core.Issue{}, identity.Scope{}, false
	}
	user := auth.MustUser(request.Context())
	scope, err := options.Authorization.AuthorizeIssue(request.Context(), user.ID, issue.ID, permission)
	if !writeIssueAuthorization(response, request, err, false) {
		return core.Issue{}, identity.Scope{}, false
	}
	return issue, scope, true
}

func writeDependencies(response http.ResponseWriter, request *http.Request, repository *core.Repository, issueID interface{ String() string }, status int) {
	parsed, err := core.ParseUUID(issueID.String())
	if err != nil {
		writeIssueInternal(response, request)
		return
	}
	dependencies, err := repository.ListIssueDependencies(request.Context(), parsed)
	if err != nil {
		writeIssueInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, status, dependencyResource{DependsOn: dependencies.DependsOn, Blocks: dependencies.Blocks})
}

func listDependenciesHandler(repository *core.Repository, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		issue, _, ok := authorizeDependencyIssue(response, request, repository, options, chi.URLParam(request, "issueRef"), identity.PermissionRead)
		if !ok {
			return
		}
		writeDependencies(response, request, repository, issue.ID, http.StatusOK)
	}
}

func addDependencyHandler(repository *core.Repository, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		issue, scope, ok := authorizeDependencyIssue(response, request, repository, options, chi.URLParam(request, "issueRef"), identity.PermissionWrite)
		if !ok {
			return
		}
		var body addDependencyBody
		if !decodeIssueJSON(response, request, &body) {
			return
		}
		reference := strings.TrimSpace(body.DependsOn)
		if reference == "" {
			writeIssueValidation(response, request, issueFieldError("/dependsOn", "invalid_type", "dependsOn names the blocking issue by id or identifier."))
			return
		}
		blocker, err := repository.GetIssue(request.Context(), reference)
		if errors.Is(err, core.ErrNotFound) || (err == nil && blocker.WorkspaceID != scope.WorkspaceID) {
			httpapi.WriteError(response, request, http.StatusNotFound, "ISSUE_NOT_FOUND", "The blocking issue was not found.", nil)
			return
		}
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		err = repository.AddIssueDependency(request.Context(), core.AddIssueDependencyParams{
			WorkspaceID: scope.WorkspaceID, IssueID: issue.ID, DependsOnIssueID: blocker.ID, CreatedBy: user.ID, CreatedAt: options.Clock().UTC(),
		})
		switch {
		case errors.Is(err, core.ErrDependencyCycle):
			httpapi.WriteError(response, request, http.StatusConflict, "DEPENDENCY_CYCLE",
				"That dependency would make the issue wait on itself.", nil)
			return
		case errors.Is(err, core.ErrNotFound):
			httpapi.WriteError(response, request, http.StatusNotFound, "ISSUE_NOT_FOUND", "The blocking issue was not found.", nil)
			return
		case err != nil:
			writeIssueInternal(response, request)
			return
		}
		writeDependencies(response, request, repository, issue.ID, http.StatusCreated)
	}
}

func removeDependencyHandler(repository *core.Repository, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		issue, scope, ok := authorizeDependencyIssue(response, request, repository, options, chi.URLParam(request, "issueRef"), identity.PermissionWrite)
		if !ok {
			return
		}
		blocker, err := repository.GetIssue(request.Context(), chi.URLParam(request, "dependsOnRef"))
		if errors.Is(err, core.ErrNotFound) || (err == nil && blocker.WorkspaceID != scope.WorkspaceID) {
			httpapi.WriteError(response, request, http.StatusNotFound, "ISSUE_NOT_FOUND", "The blocking issue was not found.", nil)
			return
		}
		if err != nil {
			writeIssueInternal(response, request)
			return
		}
		if err := repository.RemoveIssueDependency(request.Context(), issue.ID, blocker.ID); err != nil {
			if errors.Is(err, core.ErrNotFound) {
				httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "That dependency does not exist.", nil)
				return
			}
			writeIssueInternal(response, request)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}
}
