package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const testSecret = "cs_the_client_secret_value"

func fixedClock() func() time.Time {
	moment := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	return func() time.Time { return moment }
}

// provider stands in for a real OAuth server. Every test drives one of these:
// the suite must never need a registered app or a live credential.
func provider(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func jsonResponse(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func TestAuthorizeURLCarriesStateScopesAndPKCE(t *testing.T) {
	t.Parallel()
	client := Client{Now: fixedClock()}
	config := Config{
		Endpoint: Endpoints()["linear"],
		ClientID: "client-1", ClientSecret: testSecret,
		Scopes: []string{"read", "write"},
	}

	raw, err := client.AuthorizeURL(config, "state-abc", "https://berry.test/cb", "verifier-xyz")
	if err != nil {
		t.Fatalf("AuthorizeURL: %v", err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	query := parsed.Query()

	if got := query.Get("state"); got != "state-abc" {
		t.Errorf("state = %q", got)
	}
	if got := query.Get("redirect_uri"); got != "https://berry.test/cb" {
		t.Errorf("redirect_uri = %q", got)
	}
	// Linear requires commas. Space-separated scopes are accepted by the
	// endpoint and grant nothing, which is the failure this asserts against.
	if got := query.Get("scope"); got != "read,write" {
		t.Errorf("scope = %q, want comma-separated", got)
	}
	if got := query.Get("code_challenge"); got != Challenge("verifier-xyz") {
		t.Errorf("code_challenge = %q", got)
	}
	if got := query.Get("code_challenge_method"); got != "S256" {
		t.Errorf("code_challenge_method = %q", got)
	}
	if strings.Contains(raw, testSecret) {
		t.Fatal("client secret leaked into the authorization URL")
	}
}

func TestAuthorizeURLAppliesProviderSpecificParams(t *testing.T) {
	t.Parallel()
	client := Client{Now: fixedClock()}

	notion, err := client.AuthorizeURL(Config{
		Endpoint: Endpoints()["notion"], ClientID: "c", ClientSecret: testSecret,
	}, "s", "https://berry.test/cb", "")
	if err != nil {
		t.Fatalf("notion: %v", err)
	}
	if got := mustQuery(t, notion).Get("owner"); got != "user" {
		t.Errorf("notion owner = %q, want user", got)
	}

	// Without offline access and a forced prompt Google issues no refresh
	// token, and the connection dies at the first expiry.
	gmail, err := client.AuthorizeURL(Config{
		Endpoint: Endpoints()["gmail"], ClientID: "c", ClientSecret: testSecret,
	}, "s", "https://berry.test/cb", "v")
	if err != nil {
		t.Fatalf("gmail: %v", err)
	}
	query := mustQuery(t, gmail)
	if query.Get("access_type") != "offline" || query.Get("prompt") != "consent" {
		t.Errorf("gmail params = %v", query)
	}
}

func mustQuery(t *testing.T, raw string) url.Values {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return parsed.Query()
}

func TestAuthorizeURLRefusesUnconfiguredProvider(t *testing.T) {
	t.Parallel()
	client := Client{}
	_, err := client.AuthorizeURL(Config{Endpoint: Endpoints()["github"]}, "s", "https://berry.test/cb", "")
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

func TestExchangeFormEncodedProvider(t *testing.T) {
	t.Parallel()
	var seen url.Values
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen, _ = url.ParseQuery(string(body))
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept = %q", got)
		}
		jsonResponse(w, 200, map[string]any{
			"access_token": "gho_token", "refresh_token": "ghr_token",
			"expires_in": float64(3600), "scope": "repo read:org",
		})
	})

	endpoint := Endpoints()["github"]
	endpoint.TokenURL = server.URL
	client := Client{Now: fixedClock()}
	result, err := client.Exchange(context.Background(), Config{
		Endpoint: endpoint, ClientID: "client-1", ClientSecret: testSecret,
	}, "https://berry.test/cb", "the-code", "")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}

	if seen.Get("grant_type") != "authorization_code" || seen.Get("code") != "the-code" {
		t.Errorf("request body = %v", seen)
	}
	if seen.Get("client_secret") != testSecret {
		t.Error("client secret was not sent in the body for a body-auth provider")
	}
	if result.AccessToken != "gho_token" || result.RefreshToken != "ghr_token" {
		t.Errorf("tokens = %+v", result)
	}
	if result.ExpiresAt == nil || !result.ExpiresAt.Equal(fixedClock()().Add(time.Hour)) {
		t.Errorf("expires at = %v, want clock + 1h", result.ExpiresAt)
	}
	if len(result.Scopes) != 2 {
		t.Errorf("scopes = %v", result.Scopes)
	}
}

func TestExchangeNotionUsesBasicAuthAndJSONBody(t *testing.T) {
	t.Parallel()
	var (
		gotUser, gotPass string
		gotBody          map[string]any
		gotContentType   string
	)
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		gotUser, gotPass, _ = r.BasicAuth()
		gotContentType = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		jsonResponse(w, 200, map[string]any{
			"access_token": "secret_notion", "workspace_id": "ws-1",
			"workspace_name": "Acme", "bot_id": "bot-1",
		})
	})

	endpoint := Endpoints()["notion"]
	endpoint.TokenURL = server.URL
	client := Client{Now: fixedClock()}
	result, err := client.Exchange(context.Background(), Config{
		Endpoint: endpoint, ClientID: "client-1", ClientSecret: testSecret,
	}, "https://berry.test/cb", "the-code", "")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}

	if gotUser != "client-1" || gotPass != testSecret {
		t.Errorf("basic auth = %q/%q", gotUser, gotPass)
	}
	if !strings.HasPrefix(gotContentType, "application/json") {
		t.Errorf("content type = %q, want JSON", gotContentType)
	}
	// A body-auth provider gets the secret in the body; a header-auth one must
	// not, because some reject a request carrying both.
	if _, present := gotBody["client_secret"]; present {
		t.Error("client secret was duplicated into a Basic-auth request body")
	}
	if result.Account.ID != "ws-1" || result.Account.Name != "Acme" {
		t.Errorf("account = %+v", result.Account)
	}
	if result.Account.Metadata["bot_id"] != "bot-1" {
		t.Errorf("metadata = %+v", result.Account.Metadata)
	}
}

func TestExchangeTreatsSlackOKFalseAsFailure(t *testing.T) {
	t.Parallel()
	// Slack answers a refusal with HTTP 200. Trusting the status code here
	// would store an empty token and report the connection as healthy.
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, map[string]any{"ok": false, "error": "invalid_code"})
	})
	endpoint := Endpoints()["slack"]
	endpoint.TokenURL = server.URL

	_, err := Client{Now: fixedClock()}.Exchange(context.Background(), Config{
		Endpoint: endpoint, ClientID: "c", ClientSecret: testSecret,
	}, "https://berry.test/cb", "bad", "")
	if err == nil {
		t.Fatal("ok:false was accepted as success")
	}
	if !strings.Contains(err.Error(), "invalid_code") {
		t.Errorf("error = %v, want the provider's code", err)
	}
}

func TestExchangeParsesSlackTeamIdentity(t *testing.T) {
	t.Parallel()
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, map[string]any{
			"ok": true, "access_token": "xoxb-1",
			"team":  map[string]any{"id": "T1", "name": "Acme"},
			"scope": "chat:write,channels:read",
		})
	})
	endpoint := Endpoints()["slack"]
	endpoint.TokenURL = server.URL

	result, err := Client{Now: fixedClock()}.Exchange(context.Background(), Config{
		Endpoint: endpoint, ClientID: "c", ClientSecret: testSecret,
	}, "https://berry.test/cb", "code", "")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if result.Account.ID != "T1" || result.Account.Name != "Acme" {
		t.Errorf("account = %+v", result.Account)
	}
	if len(result.Scopes) != 2 {
		t.Errorf("scopes = %v", result.Scopes)
	}
}

func TestExchangeErrorNeverEchoesTheRequest(t *testing.T) {
	t.Parallel()
	// Providers have been known to reflect the submitted form back on failure.
	// Whatever they return, the error Berry surfaces must not carry the secret.
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		jsonResponse(w, 400, map[string]any{
			"error":             "invalid_grant",
			"error_description": "code expired",
			"echoed_request":    string(body),
		})
	})
	endpoint := Endpoints()["github"]
	endpoint.TokenURL = server.URL

	_, err := Client{Now: fixedClock()}.Exchange(context.Background(), Config{
		Endpoint: endpoint, ClientID: "c", ClientSecret: testSecret,
	}, "https://berry.test/cb", "code", "")
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), testSecret) {
		t.Fatalf("client secret leaked into an error: %v", err)
	}
	if !strings.Contains(err.Error(), "invalid_grant") ||
		!strings.Contains(err.Error(), "code expired") {
		t.Errorf("error = %v, want the provider's code and description", err)
	}
}

func TestExchangeRejectsResponseWithoutToken(t *testing.T) {
	t.Parallel()
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, map[string]any{"token_type": "Bearer"})
	})
	endpoint := Endpoints()["github"]
	endpoint.TokenURL = server.URL

	_, err := Client{Now: fixedClock()}.Exchange(context.Background(), Config{
		Endpoint: endpoint, ClientID: "c", ClientSecret: testSecret,
	}, "https://berry.test/cb", "code", "")
	if err == nil {
		t.Fatal("a response with no access token was accepted")
	}
}

func TestRefreshSendsRefreshGrant(t *testing.T) {
	t.Parallel()
	var seen url.Values
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen, _ = url.ParseQuery(string(body))
		jsonResponse(w, 200, map[string]any{
			"access_token": "new-token", "expires_in": float64(1800),
		})
	})
	endpoint := Endpoints()["gmail"]
	endpoint.TokenURL = server.URL

	result, err := Client{Now: fixedClock()}.Refresh(context.Background(), Config{
		Endpoint: endpoint, ClientID: "c", ClientSecret: testSecret,
	}, "old-refresh")
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if seen.Get("grant_type") != "refresh_token" || seen.Get("refresh_token") != "old-refresh" {
		t.Errorf("body = %v", seen)
	}
	if result.AccessToken != "new-token" {
		t.Errorf("access token = %q", result.AccessToken)
	}
	if result.ExpiresAt == nil || !result.ExpiresAt.Equal(fixedClock()().Add(30*time.Minute)) {
		t.Errorf("expires at = %v", result.ExpiresAt)
	}
}

func TestExchangeSurfacesNonJSONResponse(t *testing.T) {
	t.Parallel()
	server := provider(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(502)
		_, _ = w.Write([]byte("<html>gateway error</html>"))
	})
	endpoint := Endpoints()["github"]
	endpoint.TokenURL = server.URL

	_, err := Client{Now: fixedClock()}.Exchange(context.Background(), Config{
		Endpoint: endpoint, ClientID: "c", ClientSecret: testSecret,
	}, "https://berry.test/cb", "code", "")
	if err == nil {
		t.Fatal("an HTML error page was accepted as a token response")
	}
	if !strings.Contains(err.Error(), "502") {
		t.Errorf("error = %v, want the status", err)
	}
}

func TestEveryShippedProviderHasAnEndpointAndCredentialMapping(t *testing.T) {
	t.Parallel()
	endpoints := Endpoints()
	for _, id := range []string{"github", "slack", "linear", "notion", "gmail"} {
		endpoint, ok := endpoints[id]
		if !ok {
			t.Errorf("%s has no OAuth endpoint", id)
			continue
		}
		if endpoint.AuthorizeURL == "" || endpoint.TokenURL == "" {
			t.Errorf("%s is missing an endpoint URL", id)
		}
		if !strings.HasPrefix(endpoint.AuthorizeURL, "https://") ||
			!strings.HasPrefix(endpoint.TokenURL, "https://") {
			t.Errorf("%s uses a non-TLS endpoint", id)
		}
		if _, ok := credentialEnv[id]; !ok {
			t.Errorf("%s has no credential environment mapping", id)
		}
	}
}

func TestLoadConfigsReportsUnconfiguredProvidersRatherThanHidingThem(t *testing.T) {
	t.Setenv("GITHUB_CLIENT_ID", "gh-id")
	t.Setenv("GITHUB_CLIENT_SECRET", "gh-secret")
	t.Setenv("SLACK_CLIENT_ID", "")
	t.Setenv("SLACK_CLIENT_SECRET", "")

	configs := LoadConfigs(func(provider string) []string { return []string{"scope-" + provider} })
	if len(configs) != 5 {
		t.Fatalf("loaded %d configs, want all five", len(configs))
	}
	if !configs["github"].Configured() {
		t.Error("github should be configured")
	}
	if configs["slack"].Configured() {
		t.Error("slack has no credentials and must not report as configured")
	}
	if got := configs["linear"].Scopes; len(got) != 1 || got[0] != "scope-linear" {
		t.Errorf("scopes were not taken from the provider: %v", got)
	}
}

func TestRedirectAllowlistIsEmptyUntilConfigured(t *testing.T) {
	t.Setenv("INTEGRATION_REDIRECT_ALLOWLIST", "")
	if got := RedirectAllowlist(); len(got) != 0 {
		t.Fatalf("unset allowlist returned %v, want nothing", got)
	}
	t.Setenv("INTEGRATION_REDIRECT_ALLOWLIST", " https://a.test/cb , https://b.test/cb ")
	got := RedirectAllowlist()
	if len(got) != 2 || got[0] != "https://a.test/cb" || got[1] != "https://b.test/cb" {
		t.Fatalf("allowlist = %v", got)
	}
}
