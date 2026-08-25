package github

import (
	"context"

	"github.com/google/uuid"
)

// Publisher opens pull requests as the workspace's connected account.
type Publisher struct {
	Credentials CredentialSource
	BaseURL     string
}

// Deliver commits the changes to a new branch and opens a pull request.
//
// The credential is opened per delivery, like every other product-side call:
// a run finishes long after it started, and a token held across that gap is a
// token that outlives the connection it came from.
func (publisher Publisher) Deliver(
	ctx context.Context,
	workspaceID uuid.UUID,
	repository, branch, title, body string,
	changes []FileChange,
) (PullRequest, error) {
	credential, err := publisher.Credentials.Credential(ctx, workspaceID, "github")
	if err != nil {
		return PullRequest{}, err
	}
	client := Client{Token: credential.AccessToken, BaseURL: publisher.BaseURL}
	return client.Deliver(ctx, repository, branch, title, body, changes)
}
