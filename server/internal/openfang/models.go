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
	maxChatMessages     = 32
	maxChatContentBytes = 64 * 1024
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

// ChatCompletionRequest is a non-streaming chat probe against the substrate.
type ChatCompletionRequest struct {
	Model    string
	Messages []ChatMessage
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
	request, err := client.NewJSONRequest(
		callCtx,
		http.MethodPost,
		"/v1/chat/completions",
		struct {
			Model    string        `json:"model"`
			Messages []ChatMessage `json:"messages"`
			Stream   bool          `json:"stream"`
		}{
			Model:    input.Model,
			Messages: input.Messages,
			Stream:   false,
		},
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
	for _, message := range input.Messages {
		role := strings.TrimSpace(message.Role)
		if role != "user" && role != "assistant" && role != "system" {
			return errors.New("runtime chat message role is invalid")
		}
		if !utf8.ValidString(message.Content) || len(message.Content) == 0 ||
			len(message.Content) > maxChatContentBytes {
			return errors.New("runtime chat message content must contain 1 to 65536 UTF-8 bytes")
		}
	}
	return nil
}

var _ Compatibility = (*Client)(nil)

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

// maxSystemPromptBytes bounds an authored prompt well below the manifest limit.
const maxSystemPromptBytes = 20000

// PatchAgentRequest is the subset of upstream agent configuration Berry
// authors. A nil field is omitted from the request rather than sent empty, so
// an unset field is left untouched instead of cleared.
type PatchAgentRequest struct {
	SystemPrompt *string
	Description  *string
}
