package openfang

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	maxChatMessages = 32
	// MaxChatContentBytes bounds one chat message. The planner builds its
	// task messages against it so an oversized context is trimmed before
	// the call rather than refused by it.
	MaxChatContentBytes = 64 * 1024
)

// Compatibility exposes OpenAI-compatible substrate probes for operator testing.
type Compatibility interface {
	ListModels(context.Context) ([]ModelSummary, error)
	CreateChatCompletion(context.Context, ChatCompletionRequest) (ChatCompletionResult, error)
}

// ModelSummary is a display-safe model listing entry from GET /v1/models.
type ModelSummary struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	OwnedBy string `json:"ownedBy"`
}

// ChatMessage is one OpenAI-compatible chat turn.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatResponseFormat asks the upstream to constrain the reply shape. The
// pinned runtime honours OpenAI's response_format on POST /v1/chat/completions.
type ChatResponseFormat string

// ChatResponseFormatJSONObject makes the reply a single JSON object.
const ChatResponseFormatJSONObject ChatResponseFormat = "json_object"

// Valid reports whether the format is one the runtime accepts; empty means
// the field is omitted from the request.
func (format ChatResponseFormat) Valid() bool {
	return format == "" || format == ChatResponseFormatJSONObject
}

// ChatCompletionRequest is a non-streaming chat call against the substrate.
// Model is an agent name on the pinned runtime, which routes the call through
// that agent's configured provider and model.
type ChatCompletionRequest struct {
	Model    string
	Messages []ChatMessage
	// ResponseFormat is sent as response_format when set; "" omits the field.
	ResponseFormat ChatResponseFormat
}

// ChatCompletionUsage reports token totals when the upstream includes them.
type ChatCompletionUsage struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
}

// ChatCompletionResult is the normalized Berry projection of a chat completion.
type ChatCompletionResult struct {
	Model   string              `json:"model"`
	Content string              `json:"content"`
	Usage   ChatCompletionUsage `json:"usage"`
	// RequestID is the upstream X-Request-Id, kept for the ledger and never
	// shown to a browser.
	RequestID string `json:"-"`
}

// chatResponseFormatWire is the OpenAI-compatible response_format object.
type chatResponseFormatWire struct {
	Type string `json:"type"`
}

type modelsListWire struct {
	Object string `json:"object"`
	Data   []struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	} `json:"data"`
}

type chatCompletionWire struct {
	Object  string `json:"object"`
	Choices []struct {
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

// ListModels performs a bounded, retryable read of GET /v1/models.
func (client *Client) ListModels(ctx context.Context) ([]ModelSummary, error) {
	var wire modelsListWire
	requestID, err := client.readJSON(ctx, "/v1/models", &wire)
	if err != nil {
		return nil, err
	}
	if wire.Object != "list" || wire.Data == nil {
		return nil, badResponse(requestID)
	}
	result := make([]ModelSummary, 0, len(wire.Data))
	for _, item := range wire.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" || !utf8.ValidString(id) {
			return nil, badResponse(requestID)
		}
		result = append(result, ModelSummary{
			ID:      id,
			Object:  item.Object,
			OwnedBy: item.OwnedBy,
		})
	}
	return result, nil
}

// CreateChatCompletion performs the unsafe POST exactly once against
// POST /v1/chat/completions with stream=false.
func (client *Client) CreateChatCompletion(
	ctx context.Context,
	input ChatCompletionRequest,
) (ChatCompletionResult, error) {
	if err := validateChatCompletionRequest(input); err != nil {
		return ChatCompletionResult{}, err
	}
	timeout := client.chatTimeout
	if timeout <= 0 {
		timeout = client.requestTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body := struct {
		Model          string                  `json:"model"`
		Messages       []ChatMessage           `json:"messages"`
		Stream         bool                    `json:"stream"`
		ResponseFormat *chatResponseFormatWire `json:"response_format,omitempty"`
	}{
		Model:    input.Model,
		Messages: input.Messages,
		Stream:   false,
	}
	if input.ResponseFormat != "" {
		body.ResponseFormat = &chatResponseFormatWire{Type: string(input.ResponseFormat)}
	}
	request, err := client.NewJSONRequest(
		callCtx,
		http.MethodPost,
		"/v1/chat/completions",
		body,
	)
	if err != nil {
		return ChatCompletionResult{}, err
	}
	response, err := client.Do(callCtx, request, RetryUnsafe)
	if err != nil {
		return ChatCompletionResult{}, err
	}
	defer response.Body.Close()
	requestID := response.Header.Get("X-Request-Id")
	if response.StatusCode != http.StatusOK {
		return ChatCompletionResult{}, badResponse(requestID)
	}
	var wire chatCompletionWire
	if err := decodeBoundedJSON(response.Body, client.maxJSONBytes, &wire); err != nil {
		return ChatCompletionResult{}, badResponse(requestID)
	}
	if wire.Object != "chat.completion" || len(wire.Choices) == 0 {
		return ChatCompletionResult{}, badResponse(requestID)
	}
	content := wire.Choices[0].Message.Content
	if !utf8.ValidString(content) {
		return ChatCompletionResult{}, badResponse(requestID)
	}
	return ChatCompletionResult{
		Model:   input.Model,
		Content: content,
		Usage: ChatCompletionUsage{
			InputTokens:  wire.Usage.PromptTokens,
			OutputTokens: wire.Usage.CompletionTokens,
		},
		RequestID: requestID,
	}, nil
}

func validateChatCompletionRequest(input ChatCompletionRequest) error {
	model := strings.TrimSpace(input.Model)
	if model == "" || !utf8.ValidString(model) {
		return errors.New("runtime chat model is required")
	}
	if len(input.Messages) == 0 || len(input.Messages) > maxChatMessages {
		return errors.New("runtime chat messages must contain 1 to 32 entries")
	}
	if !input.ResponseFormat.Valid() {
		return errors.New("runtime chat response format is invalid")
	}
	for _, message := range input.Messages {
		role := strings.TrimSpace(message.Role)
		if role != "user" && role != "assistant" && role != "system" {
			return errors.New("runtime chat message role is invalid")
		}
		if !utf8.ValidString(message.Content) || len(message.Content) == 0 ||
			len(message.Content) > MaxChatContentBytes {
			return errors.New("runtime chat message content must contain 1 to 65536 UTF-8 bytes")
		}
	}
	return nil
}

var (
	_ Compatibility = (*Client)(nil)
	_ AgentPatcher  = (*Client)(nil)
)

// maxManifestBytes mirrors the pinned upstream limit for POST /api/agents.
const maxManifestBytes = 1 << 20

// SpawnResponse is the 201 body of POST /api/agents.
type SpawnResponse struct {
	AgentID   uuid.UUID `json:"agent_id"`
	Name      string    `json:"name"`
	RequestID string    `json:"-"`
}

// Provisioner is the narrow seam the orchestrator bootstrap depends on. Kept
// separate from Runtime so run dispatch cannot accidentally create agents.
type Provisioner interface {
	GetAgent(context.Context, uuid.UUID) (AgentDetail, error)
	SpawnAgent(context.Context, string) (SpawnResponse, error)
}

// AgentPatcher is the provisioning write seam: what a bootstrap needs to
// correct an agent's model or prompt in place. The same *Client satisfies it;
// handlers/agents keeps its own Configurer alias for the editor route.
type AgentPatcher interface {
	PatchAgent(context.Context, uuid.UUID, PatchAgentRequest) error
}

// maxSystemPromptBytes bounds an authored prompt well below the manifest limit.
const maxSystemPromptBytes = 20000

// PatchAgentRequest is the subset of upstream agent configuration Berry
// authors. A nil field is omitted from the request rather than sent empty, so
// an unset field is left untouched instead of cleared.
type PatchAgentRequest struct {
	SystemPrompt *string
	Description  *string
	// Provider and Model move together: a model id is only meaningful against
	// the provider that serves it, so setting one without the other would
	// produce a pairing the runtime cannot resolve.
	Provider *string
	Model    *string
}

// AgentReply is one completed agent turn from POST /api/agents/{id}/message.
type AgentReply struct {
	Response     string  `json:"response"`
	InputTokens  int64   `json:"input_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	Iterations   int     `json:"iterations"`
	CostUSD      float64 `json:"cost_usd"`
	RequestID    string  `json:"-"`
}

// CatalogModel is one selectable LLM from GET /api/models.
//
// Cost and context are carried through because choosing a model is a spend
// decision as much as a capability one: the difference between tiers is two
// orders of magnitude per million tokens.
type CatalogModel struct {
	ID              string  `json:"id"`
	DisplayName     string  `json:"display_name"`
	Provider        string  `json:"provider"`
	Tier            string  `json:"tier"`
	ContextWindow   int64   `json:"context_window"`
	MaxOutputTokens int64   `json:"max_output_tokens"`
	InputCostPerM   float64 `json:"input_cost_per_m"`
	OutputCostPerM  float64 `json:"output_cost_per_m"`
	SupportsTools   bool    `json:"supports_tools"`
	SupportsVision  bool    `json:"supports_vision"`
	Available       bool    `json:"available"`
}

// Catalog is the narrow seam for reading selectable models.
type Catalog interface {
	ListModelCatalog(context.Context) ([]CatalogModel, error)
}
