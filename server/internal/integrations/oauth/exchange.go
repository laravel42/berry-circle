package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Endpoint is the shape of one provider's OAuth 2.0 implementation.
//
// The five providers Berry ships agree on the grant and disagree on nearly
// everything else — how scopes are joined, whether credentials go in the body
// or a header, whether the token request is form-encoded or JSON. Describing
// those differences as data keeps the exchange itself provider-independent, so
// a sixth provider is a table entry rather than a new code path.
type Endpoint struct {
	AuthorizeURL string
	TokenURL     string
	// ScopeSeparator joins requested scopes. Space per RFC 6749, except Linear,
	// which requires commas and silently grants nothing when given spaces.
	ScopeSeparator string
	// UsePKCE adds a code challenge. Required for public clients and harmless
	// for confidential ones, so it is on wherever the provider accepts it.
	UsePKCE bool
	// BasicAuth sends the client credentials in an Authorization header rather
	// than the request body.
	BasicAuth bool
	// JSONBody sends the token request as JSON. Notion alone requires this.
	JSONBody bool
	// AuthorizeParams are extra query parameters the authorisation URL needs —
	// Google's offline access, Notion's owner selector.
	AuthorizeParams map[string]string
	// OmitScope suppresses the scope parameter. A GitHub App's token is limited
	// to the permissions the App itself declares, so scopes are not part of its
	// authorisation request; sending them describes an access model the
	// provider does not use.
	OmitScope bool
	// ParseAccount pulls the provider's account identity out of a token
	// response. Optional: a provider that returns no identity leaves the
	// connection unnamed rather than failing.
	ParseAccount func(raw map[string]any) Account
}

// Account is who a connection turns out to belong to.
type Account struct {
	ID       string
	Name     string
	Metadata map[string]any
}

// Config is an endpoint plus this deployment's registered credentials.
//
// ClientSecret is the only field that must never be logged, serialised, or
// returned to a caller. Nothing in this package writes it anywhere but the
// outbound token request.
type Config struct {
	Endpoint
	ClientID     string
	ClientSecret string
	Scopes       []string
}

// Configured reports whether this deployment can run the flow at all.
func (config Config) Configured() bool {
	return config.ClientID != "" && config.ClientSecret != "" && config.TokenURL != ""
}

// TokenResult is a successful exchange, ready to be sealed and stored.
type TokenResult struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    *time.Time
	Scopes       []string
	Account      Account
}

// ErrNotConfigured means the provider has no client credentials in this
// deployment. Distinct from a failed exchange: the operator has work to do,
// the person clicking Connect has not done anything wrong.
var ErrNotConfigured = errors.New("oauth: provider is not configured")

// Client performs the exchange.
type Client struct {
	HTTP *http.Client
	Now  func() time.Time
}

func (client Client) httpClient() *http.Client {
	if client.HTTP != nil {
		return client.HTTP
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func (client Client) now() time.Time {
	if client.Now != nil {
		return client.Now().UTC()
	}
	return time.Now().UTC()
}

// NewVerifier returns a PKCE code verifier.
func NewVerifier() (string, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", fmt.Errorf("oauth: read random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// Challenge derives the S256 challenge for a verifier.
func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// AuthorizeURL builds the address to send a person to.
//
// The state is the CSRF defence and the redirect URI is echoed back to the
// provider for comparison, so both are required: a flow missing either is
// refused here rather than starting and failing at the callback.
func (client Client) AuthorizeURL(
	config Config,
	state, redirectURI, verifier string,
) (string, error) {
	if !config.Configured() {
		return "", ErrNotConfigured
	}
	if state == "" || redirectURI == "" {
		return "", errors.New("oauth: state and redirect uri are required")
	}
	parsed, err := url.Parse(config.AuthorizeURL)
	if err != nil {
		return "", fmt.Errorf("oauth: authorize url: %w", err)
	}

	query := parsed.Query()
	query.Set("response_type", "code")
	query.Set("client_id", config.ClientID)
	query.Set("redirect_uri", redirectURI)
	query.Set("state", state)
	if len(config.Scopes) > 0 && !config.OmitScope {
		query.Set("scope", strings.Join(config.Scopes, config.scopeSeparator()))
	}
	if config.UsePKCE {
		if verifier == "" {
			return "", errors.New("oauth: provider requires PKCE but no verifier was generated")
		}
		query.Set("code_challenge", Challenge(verifier))
		query.Set("code_challenge_method", "S256")
	}
	for key, value := range config.AuthorizeParams {
		query.Set(key, value)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func (config Config) scopeSeparator() string {
	if config.ScopeSeparator == "" {
		return " "
	}
	return config.ScopeSeparator
}

// Exchange trades an authorisation code for tokens.
func (client Client) Exchange(
	ctx context.Context,
	config Config,
	redirectURI, code, verifier string,
) (TokenResult, error) {
	if !config.Configured() {
		return TokenResult{}, ErrNotConfigured
	}
	if code == "" {
		return TokenResult{}, errors.New("oauth: authorization code is required")
	}
	form := map[string]string{
		"grant_type":   "authorization_code",
		"code":         code,
		"redirect_uri": redirectURI,
	}
	if config.UsePKCE && verifier != "" {
		form["code_verifier"] = verifier
	}
	return client.token(ctx, config, form)
}

// Refresh renews an access token.
func (client Client) Refresh(
	ctx context.Context,
	config Config,
	refreshToken string,
) (TokenResult, error) {
	if !config.Configured() {
		return TokenResult{}, ErrNotConfigured
	}
	if refreshToken == "" {
		return TokenResult{}, errors.New("oauth: refresh token is required")
	}
	return client.token(ctx, config, map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
	})
}

func (client Client) token(
	ctx context.Context,
	config Config,
	fields map[string]string,
) (TokenResult, error) {
	request, err := client.buildTokenRequest(ctx, config, fields)
	if err != nil {
		return TokenResult{}, err
	}
	response, err := client.httpClient().Do(request)
	if err != nil {
		return TokenResult{}, fmt.Errorf("oauth: token request: %w", err)
	}
	defer response.Body.Close()

	// Bounded: a provider returning an unbounded body must not be able to make
	// Berry allocate without limit on an unauthenticated-ish path.
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return TokenResult{}, fmt.Errorf("oauth: read token response: %w", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return TokenResult{}, fmt.Errorf("oauth: token response was not JSON (status %d)", response.StatusCode)
	}
	if err := tokenError(response.StatusCode, raw); err != nil {
		return TokenResult{}, err
	}

	accessToken, _ := raw["access_token"].(string)
	if accessToken == "" {
		// Slack nests the bot token differently on some app configurations.
		if nested, ok := raw["authed_user"].(map[string]any); ok {
			accessToken, _ = nested["access_token"].(string)
		}
	}
	if accessToken == "" {
		return TokenResult{}, errors.New("oauth: provider returned no access token")
	}

	result := TokenResult{
		AccessToken:  accessToken,
		RefreshToken: stringField(raw, "refresh_token"),
		Scopes:       splitScopes(stringField(raw, "scope"), config.scopeSeparator()),
	}
	if seconds, ok := numberField(raw, "expires_in"); ok && seconds > 0 {
		expiry := client.now().Add(time.Duration(seconds) * time.Second)
		result.ExpiresAt = &expiry
	}
	if config.ParseAccount != nil {
		result.Account = config.ParseAccount(raw)
	}
	return result, nil
}

func (client Client) buildTokenRequest(
	ctx context.Context,
	config Config,
	fields map[string]string,
) (*http.Request, error) {
	var (
		request *http.Request
		err     error
	)
	if config.JSONBody {
		encoded, marshalErr := json.Marshal(fields)
		if marshalErr != nil {
			return nil, fmt.Errorf("oauth: encode token request: %w", marshalErr)
		}
		request, err = http.NewRequestWithContext(
			ctx, http.MethodPost, config.TokenURL, strings.NewReader(string(encoded)))
		if err == nil {
			request.Header.Set("Content-Type", "application/json")
		}
	} else {
		form := url.Values{}
		for key, value := range fields {
			form.Set(key, value)
		}
		// Credentials go in the body only when the provider does not take them
		// in a header. Sending both is accepted by some providers and rejected
		// by others, so exactly one is used.
		if !config.BasicAuth {
			form.Set("client_id", config.ClientID)
			form.Set("client_secret", config.ClientSecret)
		}
		request, err = http.NewRequestWithContext(
			ctx, http.MethodPost, config.TokenURL, strings.NewReader(form.Encode()))
		if err == nil {
			request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
	}
	if err != nil {
		return nil, fmt.Errorf("oauth: build token request: %w", err)
	}
	if config.BasicAuth {
		request.SetBasicAuth(config.ClientID, config.ClientSecret)
	}
	request.Header.Set("Accept", "application/json")
	return request, nil
}

// tokenError turns a provider's refusal into an error.
//
// Only the provider's own error code and description are carried through. The
// raw body is deliberately dropped: providers have been known to echo the
// submitted request back on failure, which would put a client secret into a
// Berry log line.
func tokenError(status int, raw map[string]any) error {
	// Slack answers failures with HTTP 200 and ok:false, so status alone is not
	// enough to tell success from refusal.
	if ok, present := raw["ok"].(bool); present && !ok {
		return fmt.Errorf("oauth: provider refused the exchange (%s)",
			fallback(stringField(raw, "error"), "unknown error"))
	}
	if code := stringField(raw, "error"); code != "" {
		description := stringField(raw, "error_description")
		if description != "" {
			return fmt.Errorf("oauth: provider refused the exchange (%s: %s)", code, description)
		}
		return fmt.Errorf("oauth: provider refused the exchange (%s)", code)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("oauth: token endpoint returned HTTP %d", status)
	}
	return nil
}

func stringField(raw map[string]any, key string) string {
	value, _ := raw[key].(string)
	return value
}

func numberField(raw map[string]any, key string) (float64, bool) {
	value, ok := raw[key].(float64)
	return value, ok
}

func fallback(value, alternative string) string {
	if strings.TrimSpace(value) == "" {
		return alternative
	}
	return value
}

// splitScopes accepts either separator regardless of what was requested,
// because providers do not always answer in the format they demand.
func splitScopes(granted, separator string) []string {
	granted = strings.TrimSpace(granted)
	if granted == "" {
		return []string{}
	}
	fields := strings.FieldsFunc(granted, func(r rune) bool {
		return r == ' ' || r == ',' || r == '\t'
	})
	_ = separator
	scopes := make([]string, 0, len(fields))
	for _, field := range fields {
		if field != "" {
			scopes = append(scopes, field)
		}
	}
	return scopes
}
