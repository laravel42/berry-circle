package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// PullRequest is an opened pull request.
type PullRequest struct {
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
	State   string `json:"state"`
}

// FileChange is one file to write.
type FileChange struct {
	Path     string
	Contents string
}

// Deliver commits files to a new branch and opens a pull request.
//
// One commit rather than one per file: the unit of work is the issue, and a
// history of "add file A", "add file B" describes the transport rather than the
// change. Built through the git data API — blobs, a tree, a commit, a ref —
// which is four calls regardless of how many files there are.
//
// The branch is created from the default branch's head at the moment of
// delivery. A run that started against older code still lands cleanly or
// conflicts visibly in the pull request, which is where a person can see it.
func (client Client) Deliver(
	ctx context.Context,
	fullName, branch, title, body string,
	changes []FileChange,
) (PullRequest, error) {
	owner, name, ok := splitFullName(fullName)
	if !ok {
		return PullRequest{}, fmt.Errorf("github: %q is not owner/name", fullName)
	}
	if len(changes) == 0 {
		return PullRequest{}, fmt.Errorf("github: nothing to deliver")
	}

	repository, err := client.Repository(ctx, fullName)
	if err != nil {
		return PullRequest{}, err
	}
	base := repository.DefaultBranch

	var head struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := client.get(ctx,
		fmt.Sprintf("/repos/%s/%s/git/ref/heads/%s", owner, name, base), &head); err != nil {
		return PullRequest{}, fmt.Errorf("read %s head: %w", base, err)
	}

	// The tree the head commit points at, not the commit itself: base_tree is
	// documented as taking a tree, and passing a commit sha is a leniency to
	// rely on only if you enjoy surprises.
	var headCommit struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := client.get(ctx,
		fmt.Sprintf("/repos/%s/%s/git/commits/%s", owner, name, head.Object.SHA),
		&headCommit); err != nil {
		return PullRequest{}, fmt.Errorf("read %s tree: %w", base, err)
	}

	// Blobs first: a tree entry references content by sha, so the content has
	// to exist before the tree that points at it.
	entries := make([]map[string]any, 0, len(changes))
	for _, change := range changes {
		var blob struct {
			SHA string `json:"sha"`
		}
		if err := client.post(ctx,
			fmt.Sprintf("/repos/%s/%s/git/blobs", owner, name),
			map[string]any{
				"content":  base64.StdEncoding.EncodeToString([]byte(change.Contents)),
				"encoding": "base64",
			}, &blob); err != nil {
			return PullRequest{}, fmt.Errorf("write %s: %w", change.Path, err)
		}
		entries = append(entries, map[string]any{
			"path": change.Path,
			"mode": "100644",
			"type": "blob",
			"sha":  blob.SHA,
		})
	}

	var tree struct {
		SHA string `json:"sha"`
	}
	if err := client.post(ctx,
		fmt.Sprintf("/repos/%s/%s/git/trees", owner, name),
		// base_tree keeps everything the run did not touch; without it the
		// commit would delete the rest of the repository.
		map[string]any{"base_tree": headCommit.Tree.SHA, "tree": entries}, &tree); err != nil {
		return PullRequest{}, fmt.Errorf("build tree: %w", err)
	}

	var commit struct {
		SHA string `json:"sha"`
	}
	if err := client.post(ctx,
		fmt.Sprintf("/repos/%s/%s/git/commits", owner, name),
		map[string]any{
			"message": title,
			"tree":    tree.SHA,
			"parents": []string{head.Object.SHA},
		}, &commit); err != nil {
		return PullRequest{}, fmt.Errorf("create commit: %w", err)
	}

	// A retried delivery meets its own branch: the name is per-run, so the
	// second attempt is the same work, not different work. Moving the ref is
	// the honest resolution — the retry's commit is the one to keep.
	err = client.post(ctx,
		fmt.Sprintf("/repos/%s/%s/git/refs", owner, name),
		map[string]any{"ref": "refs/heads/" + branch, "sha": commit.SHA}, nil)
	if alreadyExists(err) {
		err = client.patch(ctx,
			fmt.Sprintf("/repos/%s/%s/git/refs/heads/%s", owner, name, branch),
			map[string]any{"sha": commit.SHA, "force": true}, nil)
	}
	if err != nil {
		return PullRequest{}, fmt.Errorf("create branch %s: %w", branch, err)
	}

	var pull PullRequest
	err = client.post(ctx,
		fmt.Sprintf("/repos/%s/%s/pulls", owner, name),
		map[string]any{
			"title": title,
			"body":  body,
			"head":  branch,
			"base":  base,
		}, &pull)
	if alreadyExists(err) {
		// The first attempt got this far. Returning the pull request it opened
		// is the truthful answer to "deliver this run", and opening a second
		// one for the same branch is not possible anyway.
		existing, lookupErr := client.pullRequestForBranch(ctx, owner, name, branch)
		if lookupErr == nil && existing.Number != 0 {
			return existing, nil
		}
	}
	if err != nil {
		return PullRequest{}, fmt.Errorf("open pull request: %w", err)
	}
	return pull, nil
}

// alreadyExists reports the 422 GitHub answers with when the thing being
// created is already there.
func alreadyExists(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "http 422") &&
		(strings.Contains(message, "already exists") ||
			strings.Contains(message, "pull request already exists"))
}

func (client Client) pullRequestForBranch(
	ctx context.Context,
	owner, name, branch string,
) (PullRequest, error) {
	var open []PullRequest
	if err := client.get(ctx,
		fmt.Sprintf("/repos/%s/%s/pulls?state=open&head=%s:%s", owner, name, owner, branch),
		&open); err != nil {
		return PullRequest{}, err
	}
	if len(open) == 0 {
		return PullRequest{}, fmt.Errorf("github: no pull request for %s", branch)
	}
	return open[0], nil
}

// patch exists for moving a ref. Same handling as post; only the verb differs.
func (client Client) patch(ctx context.Context, path string, payload any, into any) error {
	return client.write(ctx, http.MethodPatch, path, payload, into)
}

func (client Client) post(ctx context.Context, path string, payload any, into any) error {
	return client.write(ctx, http.MethodPost, path, payload, into)
}

func (client Client) write(
	ctx context.Context,
	method, path string,
	payload any,
	into any,
) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("github: encode request: %w", err)
	}
	request, err := http.NewRequestWithContext(
		ctx, method, client.base()+path, bytes.NewReader(encoded))
	if err != nil {
		return fmt.Errorf("github: build request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+client.Token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	response, err := client.httpClient().Do(request)
	if err != nil {
		return fmt.Errorf("github: request failed: %w", err)
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("github: read response: %w", err)
	}
	switch {
	case response.StatusCode == http.StatusUnauthorized,
		response.StatusCode == http.StatusForbidden:
		return ErrUnauthorized
	case response.StatusCode < 200 || response.StatusCode > 299:
		var problem struct {
			Message string `json:"message"`
			Errors  []struct {
				Message string `json:"message"`
			} `json:"errors"`
		}
		_ = json.Unmarshal(body, &problem)
		detail := problem.Message
		if len(problem.Errors) > 0 && problem.Errors[0].Message != "" {
			detail += ": " + problem.Errors[0].Message
		}
		// The message only. GitHub echoes the submitted payload on some
		// failures, and this string reaches logs.
		return fmt.Errorf("github: HTTP %d (%s)", response.StatusCode, strings.TrimSpace(detail))
	}
	if into == nil {
		return nil
	}
	if err := json.Unmarshal(body, into); err != nil {
		return fmt.Errorf("github: decode response: %w", err)
	}
	return nil
}
