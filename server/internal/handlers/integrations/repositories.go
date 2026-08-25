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
	// Accounts the app is installed on. Installations are per account, so an
	// app installed on a personal account reaches none of an organisation's
	// repositories — which looks identical to a broken picker unless the list
	// says whose repositories it is showing.
	Accounts []string `json:"accounts,omitempty"`
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

		// What the installation grants, not what the person owns. For a GitHub
		// App those differ, and asking the wrong one returns the user's public
		// repositories and nothing else — which reads as a broken picker rather
		// than the wrong question. Falls back when there is no installation,
		// where /user/repos is all there is.
		reach, accessErr := client.Access(request.Context())
		if accessErr != nil {
			options.logger().Warn("could not read github installation access", "error", accessErr)
		}

		var repositories []github.Repository
		if accessErr == nil && len(reach.Installations) > 0 {
			for _, installation := range reach.Installations {
				batch, listErr := client.InstallationRepositories(
					request.Context(), installation.ID, 100)
				if listErr != nil {
					err = listErr
					break
				}
				repositories = append(repositories, batch...)
			}
		} else {
			repositories, err = client.ListRepositories(request.Context(), 100)
		}
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
		// Reported alongside the list so a short one explains itself.
		access := accessResource{}
		if accessErr == nil {
			access.Installed = len(reach.Installations) > 0
			access.SelectedOnly = reach.SelectedOnly
			access.ManageURL = reach.ManageURL
			for _, installation := range reach.Installations {
				if installation.Account.Login != "" {
					access.Accounts = append(access.Accounts, installation.Account.Login)
				}
			}
		}
		// Offered whether or not it is installed: the account it is missing from
		// is the common case once it is installed somewhere.
		if options.GitHubAppSlug != "" {
			access.InstallURL = "https://github.com/apps/" +
				options.GitHubAppSlug + "/installations/new"
		}

		httpapi.WriteJSON(response, http.StatusOK,
			map[string]any{"repositories": resources, "access": access})
	}
}
