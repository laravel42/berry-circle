package github

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	integrationsrepo "github.com/laravel42/berry-circle/server/internal/repository/integrations"
)

// CredentialSource opens the workspace's GitHub token.
type CredentialSource interface {
	Credential(ctx context.Context, workspaceID uuid.UUID, provider string) (integrationsrepo.Credential, error)
}

// Resolver turns a repository name into the id GitHub keeps stable.
type Resolver struct {
	Credentials CredentialSource
	BaseURL     string
}

// ResolveRepository confirms the workspace's connection can actually see the
// repository, and returns its id.
//
// The check is the point, not the id. Storing a name the connected account
// cannot reach would produce a project that looks configured and fails at the
// first pull request, long after the person who linked it has moved on.
func (resolver Resolver) ResolveRepository(
	ctx context.Context,
	workspaceID uuid.UUID,
	fullName string,
) (int64, error) {
	if resolver.Credentials == nil {
		return 0, fmt.Errorf("github: no credential source")
	}
	credential, err := resolver.Credentials.Credential(ctx, workspaceID, "github")
	if err != nil {
		return 0, err
	}
	repository, err := Client{Token: credential.AccessToken, BaseURL: resolver.BaseURL}.
		Repository(ctx, fullName)
	if err != nil {
		return 0, err
	}
	return repository.ID, nil
}
