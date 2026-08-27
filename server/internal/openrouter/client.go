// Package openrouter reads OpenRouter's public model catalog.
//
// OpenFang also reports a catalog, but its OpenRouter entries are compiled into
// the binary: anything published after that build is absent, which made a
// working model look unavailable. OpenRouter publishes the same information
// live, so for models it serves this is the authoritative source and the
// runtime's copy is a stale mirror.
package openrouter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// DefaultBaseURL is OpenRouter's public API. Listing models needs no
// credential, so Berry does not hold one to render the picker.
const DefaultBaseURL = "https://openrouter.ai/api/v1"

// Model is one entry of OpenRouter's catalog, reduced to what Berry shows.
type Model struct {
	ID             string
	DisplayName    string
	ContextWindow  int64
	InputCostPerM  float64
	OutputCostPerM float64
	SupportsTools  bool
	SupportsVision bool
}

// Client reads the catalog and, with a credential, completes chat. The zero
// value is unusable; call New.
type Client struct {
	baseURL     string
	http        *http.Client
	apiKey      string
	chatTimeout time.Duration
}

// Option configures a client. Listing models needs nothing; chat needs a key.
type Option func(*Client)

// WithAPIKey supplies the credential chat completion requires. Absent, the
// client still lists models — that route is public — and refuses to complete.
func WithAPIKey(key string) Option {
	return func(client *Client) { client.apiKey = key }
}

// WithChatTimeout bounds one completion. A model that thinks for two minutes
// is working, not hung, so this is separate from the catalog's timeout.
func WithChatTimeout(timeout time.Duration) Option {
	return func(client *Client) { client.chatTimeout = timeout }
}

func New(baseURL string, httpClient *http.Client, options ...Option) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	if httpClient == nil {
		// Bounds the catalog fetch only. A chat completion sets its own
		// deadline per call, because one shared timeout cannot serve both a
		// 400-model listing and a model that reasons for a minute.
		httpClient = &http.Client{}
	}
	client := &Client{baseURL: baseURL, http: httpClient}
	for _, option := range options {
		option(client)
	}
	return client
}

// wireModel mirrors the upstream payload. Prices arrive as per-token decimal
// strings, which is why they are not float64 here: "0.000001" must survive
// decoding exactly as written rather than through a JSON number.
type wireModel struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ContextLen   int64  `json:"context_length"`
	Architecture struct {
		InputModalities []string `json:"input_modalities"`
	} `json:"architecture"`
	Pricing struct {
		Prompt     string `json:"prompt"`
		Completion string `json:"completion"`
	} `json:"pricing"`
	SupportedParameters []string `json:"supported_parameters"`
}

// ListModels returns every model OpenRouter currently serves.
func (client *Client) ListModels(ctx context.Context) ([]Model, error) {
	if client == nil {
		return nil, errors.New("openrouter client is not configured")
	}
	// The catalog gets its own deadline rather than one on the shared client:
	// a blanket timeout large enough for a chat completion is far too large
	// for a listing, and one small enough for a listing would cut off every
	// model that reasons.
	listCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(
		listCtx, http.MethodGet, client.baseURL+"/models", nil)
	if err != nil {
		return nil, fmt.Errorf("openrouter model request: %w", err)
	}
	request.Header.Set("Accept", "application/json")

	response, err := client.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("openrouter model catalog: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openrouter model catalog: status %d", response.StatusCode)
	}

	var payload struct {
		Data []wireModel `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode openrouter model catalog: %w", err)
	}

	models := make([]Model, 0, len(payload.Data))
	for _, entry := range payload.Data {
		if entry.ID == "" {
			continue
		}
		models = append(models, Model{
			ID:             entry.ID,
			DisplayName:    firstNonEmpty(entry.Name, entry.ID),
			ContextWindow:  entry.ContextLen,
			InputCostPerM:  perMillion(entry.Pricing.Prompt),
			OutputCostPerM: perMillion(entry.Pricing.Completion),
			SupportsTools:  contains(entry.SupportedParameters, "tools"),
			SupportsVision: contains(entry.Architecture.InputModalities, "image"),
		})
	}
	return models, nil
}

// perMillion converts a per-token price string to the per-million figure the
// product displays. An unparsable price becomes 0 rather than failing the whole
// catalog: a missing price costs one column, a rejected catalog costs the picker.
func perMillion(price string) float64 {
	value, err := strconv.ParseFloat(price, 64)
	if err != nil {
		return 0
	}
	return value * 1_000_000
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
