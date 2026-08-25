package github

import (
	"context"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/codecontext"
)

// CodeSource reads a workspace's repository on behalf of a run.
//
// Opens the credential per call rather than holding one: a run's context is
// built minutes or hours apart from any other, and a token cached across that
// gap is a token that outlives the connection it came from.
type CodeSource struct {
	Credentials CredentialSource
	WorkspaceID uuid.UUID
	BaseURL     string
}

func (source CodeSource) client(ctx context.Context) (Client, error) {
	credential, err := source.Credentials.Credential(ctx, source.WorkspaceID, "github")
	if err != nil {
		return Client{}, err
	}
	return Client{Token: credential.AccessToken, BaseURL: source.BaseURL}, nil
}

// DefaultBranch reports the branch a repository's work starts from.
func (source CodeSource) DefaultBranch(ctx context.Context, fullName string) (string, error) {
	client, err := source.client(ctx)
	if err != nil {
		return "", err
	}
	repository, err := client.Repository(ctx, fullName)
	if err != nil {
		return "", err
	}
	return repository.DefaultBranch, nil
}

// Tree lists the repository's files.
func (source CodeSource) Tree(
	ctx context.Context,
	fullName, ref string,
) ([]codecontext.Entry, bool, error) {
	client, err := source.client(ctx)
	if err != nil {
		return nil, false, err
	}
	entries, truncated, err := client.Tree(ctx, fullName, ref)
	if err != nil {
		return nil, false, err
	}
	converted := make([]codecontext.Entry, 0, len(entries))
	for _, entry := range entries {
		converted = append(converted, codecontext.Entry{Path: entry.Path, Size: entry.Size})
	}
	return converted, truncated, nil
}

// File reads one file.
func (source CodeSource) File(ctx context.Context, fullName, ref, path string) (string, error) {
	client, err := source.client(ctx)
	if err != nil {
		return "", err
	}
	return client.File(ctx, fullName, ref, path)
}
