package github

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func stub(t *testing.T, handler http.HandlerFunc) Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return Client{BaseURL: server.URL, Token: "gho_test"}
}

func TestListRepositoriesSendsTheCredentialAndPaginates(t *testing.T) {
	t.Parallel()
	var seenAuth string
	pages := 0
	client := stub(t, func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		pages++
		page := r.URL.Query().Get("page")
		w.Header().Set("Content-Type", "application/json")
		if page == "1" {
			batch := make([]Repository, 100)
			for i := range batch {
				batch[i] = Repository{ID: int64(i), FullName: "acme/repo" + page}
			}
			_ = json.NewEncoder(w).Encode(batch)
			return
		}
		_ = json.NewEncoder(w).Encode([]Repository{{ID: 999, FullName: "acme/last"}})
	})

	repositories, err := client.ListRepositories(context.Background(), 150)
	if err != nil {
		t.Fatalf("ListRepositories: %v", err)
	}
	if seenAuth != "Bearer gho_test" {
		t.Errorf("Authorization = %q", seenAuth)
	}
	if len(repositories) != 101 {
		t.Errorf("returned %d repositories, want 101", len(repositories))
	}
	// A short page ends the walk: continuing would be one wasted call per
	// picker load, forever.
	if pages != 2 {
		t.Errorf("made %d requests, want 2", pages)
	}
}

func TestListRepositoriesOmitsArchived(t *testing.T) {
	t.Parallel()
	client := stub(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]Repository{
			{ID: 1, FullName: "acme/live"},
			{ID: 2, FullName: "acme/frozen", Archived: true},
		})
	})
	repositories, err := client.ListRepositories(context.Background(), 50)
	if err != nil {
		t.Fatalf("ListRepositories: %v", err)
	}
	// An archived repository cannot receive a pull request, so offering it in a
	// picker only sets up a failure later.
	for _, repository := range repositories {
		if repository.Archived {
			t.Fatalf("archived repository offered: %s", repository.FullName)
		}
	}
	if len(repositories) != 1 {
		t.Errorf("returned %d, want 1", len(repositories))
	}
}

func TestRefusedCredentialIsDistinguishable(t *testing.T) {
	t.Parallel()
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		client := stub(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"message":"Bad credentials"}`))
		})
		// Reconnecting is the only fix, and it is the one thing a person can
		// act on — so it cannot be flattened into a generic failure.
		if _, err := client.ListRepositories(context.Background(), 10); !errors.Is(err, ErrUnauthorized) {
			t.Errorf("HTTP %d gave %v, want ErrUnauthorized", status, err)
		}
	}
}

func TestErrorsDoNotCarryTheResponseBody(t *testing.T) {
	t.Parallel()
	client := stub(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"boom","echoed_token":"gho_test"}`))
	})
	_, err := client.ListRepositories(context.Background(), 10)
	if err == nil {
		t.Fatal("expected an error")
	}
	// The string reaches logs, and upstream payloads have been known to echo
	// the request back.
	if strings.Contains(err.Error(), "gho_test") {
		t.Fatalf("error carried the credential: %v", err)
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("error dropped the provider's message: %v", err)
	}
}

func TestFullNameMustBeExactlyOwnerAndName(t *testing.T) {
	t.Parallel()
	// The value is interpolated into a request path, so anything that could
	// address a different resource is refused before it gets there.
	for _, bad := range []string{
		"", "noslash", "/name", "owner/", "owner/name/extra",
		"../etc/passwd", "owner/..", "owner/na%2fme", "owner/na?me",
	} {
		if _, _, ok := splitFullName(bad); ok {
			t.Errorf("accepted %q", bad)
		}
	}
	owner, name, ok := splitFullName("laravel42/berry-circle")
	if !ok || owner != "laravel42" || name != "berry-circle" {
		t.Errorf("split = %q/%q ok=%v", owner, name, ok)
	}
}

func TestRepositoryRefusesAMalformedNameWithoutCallingOut(t *testing.T) {
	t.Parallel()
	called := false
	client := stub(t, func(w http.ResponseWriter, r *http.Request) {
		called = true
	})
	if _, err := client.Repository(context.Background(), "owner/name/extra"); err == nil {
		t.Fatal("expected a refusal")
	}
	if called {
		t.Fatal("a malformed name still reached GitHub")
	}
}
