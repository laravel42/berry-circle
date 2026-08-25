package integrations

import (
	"errors"
	"net/http"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/github"
)

// accessResource explains the shape of the list, not just its contents.
type accessResource struct {
	// SelectedOnly means the app is limited to chosen repositories, which is
	// why a repository created after installing does not appear.
	SelectedOnly bool   `json:"selectedOnly"`
	ManageURL    string `json:"manageUrl,omitempty"`
	Installed    bool   `json:"installed"`
	// InstallURL is where to install the app. Offered when it is not installed,
	// which is the state that makes the list look mysteriously short: without
	// an installation a user token reads only public repositories.
	InstallURL string `json:"installUrl,omitempty"`
}

type repositoryResource struct {
	ID            int64  `json:"id"`
	FullName      string `json:"fullName"`
	Name          string `json:"name"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"defaultBranch"`
	Description   string `json:"description,omitempty"`
}

// listRepositoriesHandler fills the repository picker on a project.
//
// Gated on product write rather than settings: choosing which repository a
// project delivers into is part of running the project, and someone who cannot
// link one has no reason to read the list.
//
// The credential is opened here and used for one call. It is never returned,
// and the resources below carry no field that could hold it.
func listRepositoriesHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, _, ok := workspaceFor(response, request, options, identity.PermissionWrite)
		if !ok {
			return
		}
		if options.Credentials == nil {
			httpapi.WriteError(response, request, http.StatusPreconditionFailed,
				"INTEGRATIONS_NOT_CONFIGURED",
				"This deployment cannot read integration credentials.", nil)
			return
		}

		credential, err := options.Credentials.Credential(request.Context(), workspaceID, "github")
		if errors.Is(err, core.ErrNoConnection) {
			httpapi.WriteError(response, request, http.StatusPreconditionFailed,
				"NOT_CONNECTED", "Connect GitHub before choosing a repository.", nil)
			return
		}
		if err != nil {
			writeInternal(response, request, options, "open github credential", err)
			return
		}

		client := github.Client{Token: credential.AccessToken}
		repositories, err := client.ListRepositories(request.Context(), 100)
		if errors.Is(err, github.ErrUnauthorized) {
			// The one failure a person can act on, so it is not flattened into
			// a generic error: the connection needs re-authorising.
			httpapi.WriteError(response, request, http.StatusPreconditionFailed,
				"CREDENTIAL_REJECTED",
				"GitHub refused this connection. Reconnect it and try again.", nil)
			return
		}
		if err != nil {
			writeInternal(response, request, options, "list repositories", err)
			return
		}

		resources := make([]repositoryResource, 0, len(repositories))
		for _, repository := range repositories {
			resources = append(resources, repositoryResource{
				ID:            repository.ID,
				FullName:      repository.FullName,
				Name:          repository.Name,
				Private:       repository.Private,
				DefaultBranch: repository.DefaultBranch,
				Description:   repository.Description,
			})
		}
		// Asked after the list, and its failure is not the list's failure: a
		// short list is still useful, and an unexplained short list is the
		// complaint this answers.
		access := accessResource{}
		if reach, err := client.Access(request.Context()); err == nil {
			access.Installed = len(reach.Installations) > 0
			access.SelectedOnly = reach.SelectedOnly
			access.ManageURL = reach.ManageURL
		} else {
			options.logger().Warn("could not read github installation access", "error", err)
		}
		if !access.Installed && options.GitHubAppSlug != "" {
			access.InstallURL = "https://github.com/apps/" +
				options.GitHubAppSlug + "/installations/new"
		}

		httpapi.WriteJSON(response, http.StatusOK,
			map[string]any{"repositories": resources, "access": access})
	}
}
