package oauth

import (
	"os"
	"strings"
)

// Endpoints describes each provider's OAuth implementation.
//
// Verified against each provider's current documentation rather than assumed
// from the RFC: three of the five deviate from it in ways that fail silently.
// Linear grants nothing when scopes arrive space-separated, Notion rejects a
// form-encoded token request, and Slack answers a refusal with HTTP 200.
func Endpoints() map[string]Endpoint {
	return map[string]Endpoint{
		"github": {
			AuthorizeURL:   "https://github.com/login/oauth/authorize",
			TokenURL:       "https://github.com/login/oauth/access_token",
			ScopeSeparator: " ",
			// GitHub's token response carries no identity, so the connection is
			// named by the caller after a follow-up lookup rather than here.
		},
		"slack": {
			AuthorizeURL:   "https://slack.com/oauth/v2/authorize",
			TokenURL:       "https://slack.com/api/oauth.v2.access",
			ScopeSeparator: ",",
			ParseAccount: func(raw map[string]any) Account {
				team, _ := raw["team"].(map[string]any)
				if team == nil {
					return Account{}
				}
				return Account{
					ID:   stringField(team, "id"),
					Name: stringField(team, "name"),
				}
			},
		},
		"linear": {
			AuthorizeURL:   "https://linear.app/oauth/authorize",
			TokenURL:       "https://api.linear.app/oauth/token",
			ScopeSeparator: ",",
			UsePKCE:        true,
		},
		"notion": {
			AuthorizeURL: "https://api.notion.com/v1/oauth/authorize",
			TokenURL:     "https://api.notion.com/v1/oauth/token",
			BasicAuth:    true,
			JSONBody:     true,
			// Notion asks which kind of principal is authorising; "user" is the
			// only value that yields a workspace-scoped bot token.
			AuthorizeParams: map[string]string{"owner": "user"},
			ParseAccount: func(raw map[string]any) Account {
				account := Account{
					ID:   stringField(raw, "workspace_id"),
					Name: stringField(raw, "workspace_name"),
				}
				if botID := stringField(raw, "bot_id"); botID != "" {
					account.Metadata = map[string]any{"bot_id": botID}
				}
				return account
			},
		},
		"gmail": {
			AuthorizeURL:   "https://accounts.google.com/o/oauth2/v2/auth",
			TokenURL:       "https://oauth2.googleapis.com/token",
			ScopeSeparator: " ",
			UsePKCE:        true,
			// Google issues a refresh token only for an offline grant, and only
			// on the first consent unless re-prompted. Without both, a
			// connection works until the first expiry and then dies unrenewable.
			AuthorizeParams: map[string]string{
				"access_type": "offline",
				"prompt":      "consent",
			},
		},
	}
}

// credentialEnv maps a provider to the variables documented in .env.example.
var credentialEnv = map[string][2]string{
	"github": {"GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"},
	"slack":  {"SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"},
	"linear": {"LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"},
	"notion": {"NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"},
	"gmail":  {"GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"},
}

// LoadConfigs builds each provider's config from the environment.
//
// A provider with no credentials is still returned, unconfigured. Settings can
// then show it as available-but-not-set-up, which is a different and more
// useful state than the provider silently not existing.
func LoadConfigs(scopesFor func(provider string) []string) map[string]Config {
	configs := make(map[string]Config, len(credentialEnv))
	for provider, endpoint := range Endpoints() {
		names, ok := credentialEnv[provider]
		if !ok {
			continue
		}
		config := Config{
			Endpoint:     endpoint,
			ClientID:     strings.TrimSpace(os.Getenv(names[0])),
			ClientSecret: strings.TrimSpace(os.Getenv(names[1])),
		}
		if scopesFor != nil {
			config.Scopes = scopesFor(provider)
		}
		configs[provider] = config
	}
	return configs
}

// RedirectAllowlist reads the URIs a provider may send a code back to.
//
// Empty means no flow can start. That is deliberate: defaulting to something
// permissive would let a misconfigured deployment hand authorisation codes to
// an address nobody vetted.
func RedirectAllowlist() []string {
	raw := strings.TrimSpace(os.Getenv("INTEGRATION_REDIRECT_ALLOWLIST"))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	allowed := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			allowed = append(allowed, trimmed)
		}
	}
	return allowed
}
