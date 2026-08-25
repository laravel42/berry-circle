// Package github is Berry's own client for the GitHub REST API.
//
// It exists alongside the MCP server rather than replacing it, and the split is
// by caller rather than by capability. An agent choosing to act on GitHub goes
// through MCP, where Berry's grants and audit decide what it may do. This
// package serves the product itself: filling a repository picker, reading a
// tree to build context for a run, opening the pull request a finished run
// produced. None of those are an agent's decision, and none should have to wait
// on a tool the runtime has not been given.
//
// core.Provider still has no Execute. That remains deliberate — this is not a
// second path for agents, and nothing here is reachable from one.
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// apiBase is overridable so tests can point at an httptest server.
const apiBase = "https://api.github.com"

// ErrUnauthorized means the token was refused. Distinct from a transport
// failure because it is the one error a person can act on: reconnect.
var ErrUnauthorized = errors.New("github: credential was refused")

// Client calls GitHub as the workspace's connected account.
type Client struct {
	HTTP    *http.Client
	BaseURL string
	// Token is the connection's access token, opened at the moment of use and
	// never retained beyond the call that needs it.
	Token string
}

func (client Client) httpClient() *http.Client {
	if client.HTTP != nil {
		return client.HTTP
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func (client Client) base() string {
	if client.BaseURL != "" {
		return strings.TrimRight(client.BaseURL, "/")
	}
	return apiBase
}

// Repository is one repository the connection can see.
type Repository struct {
	ID            int64  `json:"id"`
	FullName      string `json:"full_name"`
	Name          string `json:"name"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	Description   string `json:"description"`
	Archived      bool   `json:"archived"`
	PushedAt      string `json:"pushed_at"`
}

// ListRepositories returns the repositories the token can reach, most recently
// pushed first.
//
// Bounded to a few pages rather than every repository. A picker does not need
// an account's entire history, and an unbounded walk turns one page load into
// hundreds of upstream calls.
func (client Client) ListRepositories(ctx context.Context, limit int) ([]Repository, error) {
	if limit <= 0 || limit > 300 {
		limit = 100
	}
	const perPage = 100
	repositories := make([]Repository, 0, limit)

	for page := 1; page <= 3 && len(repositories) < limit; page++ {
		query := url.Values{}
		query.Set("per_page", strconv.Itoa(perPage))
		query.Set("page", strconv.Itoa(page))
		query.Set("sort", "pushed")
		query.Set("affiliation", "owner,collaborator,organization_member")

		var batch []Repository
		if err := client.get(ctx, "/user/repos?"+query.Encode(), &batch); err != nil {
			return nil, err
		}
		for _, repository := range batch {
			// An archived repository cannot receive a pull request, so offering
			// it in a picker only sets up a failure later.
			if repository.Archived {
				continue
			}
			repositories = append(repositories, repository)
			if len(repositories) == limit {
				break
			}
		}
		if len(batch) < perPage {
			break
		}
	}
	return repositories, nil
}

// Repository looks one up by owner/name.
func (client Client) Repository(ctx context.Context, fullName string) (Repository, error) {
	owner, name, ok := splitFullName(fullName)
	if !ok {
		return Repository{}, fmt.Errorf("github: %q is not owner/name", fullName)
	}
	var repository Repository
	if err := client.get(ctx, "/repos/"+owner+"/"+name, &repository); err != nil {
		return Repository{}, err
	}
	return repository, nil
}

// splitFullName rejects anything that is not exactly one owner and one name.
//
// The result is interpolated into a request path, so a value carrying a slash
// or a traversal segment would address a different resource than the one named.
func splitFullName(fullName string) (string, string, bool) {
	owner, name, found := strings.Cut(strings.TrimSpace(fullName), "/")
	if !found || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", "", false
	}
	for _, part := range []string{owner, name} {
		if part == "." || part == ".." || strings.ContainsAny(part, "?#%\\") {
			return "", "", false
		}
	}
	return owner, name, true
}

func (client Client) get(ctx context.Context, path string, into any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, client.base()+path, nil)
	if err != nil {
		return fmt.Errorf("github: build request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+client.Token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	response, err := client.httpClient().Do(request)
	if err != nil {
		return fmt.Errorf("github: request failed: %w", err)
	}
	defer response.Body.Close()

	// Bounded: an upstream returning an unbounded body must not be able to make
	// Berry allocate without limit.
	body, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("github: read response: %w", err)
	}
	switch {
	case response.StatusCode == http.StatusUnauthorized,
		response.StatusCode == http.StatusForbidden:
		return ErrUnauthorized
	case response.StatusCode < 200 || response.StatusCode > 299:
		// The message, not the body: GitHub error payloads echo request detail,
		// and this string reaches logs.
		var problem struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &problem)
		return fmt.Errorf("github: HTTP %d (%s)", response.StatusCode, problem.Message)
	}
	if into == nil {
		return nil
	}
	if err := json.Unmarshal(body, into); err != nil {
		return fmt.Errorf("github: decode response: %w", err)
	}
	return nil
}

// Installation is one place the GitHub App has been installed.
type Installation struct {
	ID                  int64  `json:"id"`
	RepositorySelection string `json:"repository_selection"`
	HTMLURL             string `json:"html_url"`
	Account             struct {
		Login string `json:"login"`
	} `json:"account"`
}

// Access describes what the connection can actually reach.
//
// A GitHub App sees only the repositories its installation covers, which is
// usually a chosen subset and never updates itself when a new repository is
// created. The repository list is therefore short for a reason the person
// looking at it cannot guess, so the reason travels with the list.
type Access struct {
	Installations []Installation
	// SelectedOnly is true when every installation is limited to chosen
	// repositories, which is the case that surprises people.
	SelectedOnly bool
	// ManageURL is where to widen it. Empty when there is no installation at
	// all, which is a different problem with a different fix.
	ManageURL string
}

// Access lists the app installations this credential can see.
func (client Client) Access(ctx context.Context) (Access, error) {
	var payload struct {
		Installations []Installation `json:"installations"`
	}
	if err := client.get(ctx, "/user/installations?per_page=100", &payload); err != nil {
		return Access{}, err
	}
	access := Access{Installations: payload.Installations, SelectedOnly: len(payload.Installations) > 0}
	for _, installation := range payload.Installations {
		if installation.RepositorySelection != "selected" {
			access.SelectedOnly = false
		}
		if access.ManageURL == "" {
			access.ManageURL = installation.HTMLURL
		}
	}
	return access, nil
}

// InstallationRepositories lists what one installation grants this user.
//
// Distinct from /user/repos, which answers "what does this person own" filtered
// by what the app may see. For a GitHub App the authoritative question is what
// the installation covers, and the two answers differ: a token minted before an
// installation existed still reads the user's public repositories through the
// first endpoint while seeing nothing private, which looks like a broken list
// rather than the wrong question.
func (client Client) InstallationRepositories(
	ctx context.Context,
	installationID int64,
	limit int,
) ([]Repository, error) {
	if limit <= 0 || limit > 300 {
		limit = 100
	}
	const perPage = 100
	repositories := make([]Repository, 0, limit)

	for page := 1; page <= 3 && len(repositories) < limit; page++ {
		var payload struct {
			Repositories []Repository `json:"repositories"`
		}
		path := fmt.Sprintf(
			"/user/installations/%d/repositories?per_page=%d&page=%d",
			installationID, perPage, page,
		)
		if err := client.get(ctx, path, &payload); err != nil {
			return nil, err
		}
		for _, repository := range payload.Repositories {
			if repository.Archived {
				continue
			}
			repositories = append(repositories, repository)
			if len(repositories) == limit {
				break
			}
		}
		if len(payload.Repositories) < perPage {
			break
		}
	}
	return repositories, nil
}
