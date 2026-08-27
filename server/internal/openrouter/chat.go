package openrouter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// One chat completion against OpenRouter, without going through OpenFang.
//
// This is the same call the runtime's OpenAI-compatible route made on Berry's
// behalf, minus the hop. It exists because OpenFang added nothing to it: the
// route forwarded the request to OpenRouter and returned what came back, and
// the only thing Berry lost by calling directly is having to name the model
// itself rather than naming an agent and letting the runtime resolve it.
//
// Streaming, tools and multi-turn agent loops are deliberately absent. Those
// belong to the ADK runtime; this is for the handful of places that ask one
// question and read one answer — a peer review, a planner call, an operator
// probe.

// MaxChatContentBytes bounds one message, matching the limit callers already
// build their prompts against.
const MaxChatContentBytes = 64 * 1024

const maxChatMessages = 32
const defaultChatTimeout = 120 * time.Second

// ChatMessage is one OpenAI-compatible turn.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatResponseFormat asks for a constrained reply shape. Empty omits the field.
type ChatResponseFormat string

// ChatResponseFormatJSONObject asks for a single JSON object. A hint rather
// than a guarantee: not every model honours it, which is why callers that need
// JSON still parse defensively.
const ChatResponseFormatJSONObject ChatResponseFormat = "json_object"

func (format ChatResponseFormat) valid() bool {
	return format == "" || format == ChatResponseFormatJSONObject
}

// ChatCompletionRequest is one non-streaming call.
//
// Model is an OpenRouter model id — `anthropic/claude-sonnet-4.5` — not an
// agent name. That is the one thing that changes for a caller moving off the
// runtime, and it is a simplification: the pairing an agent stores is now used
// directly instead of being resolved by a second system.
type ChatCompletionRequest struct {
	Model          string
	Messages       []ChatMessage
	ResponseFormat ChatResponseFormat
}

// ChatCompletionUsage reports token totals when the provider includes them.
type ChatCompletionUsage struct {
	InputTokens  int `json:"inputTokens"`
	OutputTokens int `json:"outputTokens"`
}

// ChatCompletionResult is Berry's normalized projection of a completion.
type ChatCompletionResult struct {
	Model   string              `json:"model"`
	Content string              `json:"content"`
	Usage   ChatCompletionUsage `json:"usage"`
	// RequestID is the upstream request id, kept for the ledger and never
	// shown to a browser.
	RequestID string `json:"-"`
}

// Error is an OpenRouter call that did not produce a usable answer.
type Error struct {
	Status int
	Detail string
}

func (err *Error) Error() string {
	return fmt.Sprintf("openrouter chat completion failed with %d: %s", err.Status, err.Detail)
}

// Retryable reports whether trying again could plausibly work. Deliberately
// narrow: a retry costs another paid call, so only rate limiting and an
// upstream fault qualify.
func (err *Error) Retryable() bool {
	return err.Status == http.StatusTooManyRequests || err.Status >= 500
}

// CreateChatCompletion performs the unsafe POST exactly once.
//
// Once, not retried, for the same reason the runtime's version was: a
// completion is paid work with no idempotency key, so a repeat on an ambiguous
// failure buys the same answer twice.
func (client *Client) CreateChatCompletion(
	ctx context.Context,
	input ChatCompletionRequest,
) (ChatCompletionResult, error) {
	if client == nil {
		return ChatCompletionResult{}, errors.New("openrouter client is not configured")
	}
	if strings.TrimSpace(client.apiKey) == "" {
		// Refused here rather than sent: OpenRouter answers an unauthenticated
		// chat call with a 401 that reads like a bad key rather than a missing
		// one, and the two are fixed differently.
		return ChatCompletionResult{}, errors.New("openrouter chat requires an API key")
	}
	if err := validateChatRequest(input); err != nil {
		return ChatCompletionResult{}, err
	}

	timeout := client.chatTimeout
	if timeout <= 0 {
		timeout = defaultChatTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	body := struct {
		Model          string        `json:"model"`
		Messages       []ChatMessage `json:"messages"`
		Stream         bool          `json:"stream"`
		ResponseFormat *struct {
			Type string `json:"type"`
		} `json:"response_format,omitempty"`
	}{Model: input.Model, Messages: input.Messages, Stream: false}
	if input.ResponseFormat != "" {
		body.ResponseFormat = &struct {
			Type string `json:"type"`
		}{Type: string(input.ResponseFormat)}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return ChatCompletionResult{}, errors.New("encode openrouter chat request")
	}

	request, err := http.NewRequestWithContext(
		callCtx, http.MethodPost, client.baseURL+"/chat/completions", strings.NewReader(string(encoded)))
	if err != nil {
		return ChatCompletionResult{}, fmt.Errorf("openrouter chat request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.apiKey)
	// Attribution headers OpenRouter uses for its dashboard. Harmless if
	// unset, but a deployment reading its own spend wants to see a name.
	request.Header.Set("X-Title", "Berry")

	response, err := client.http.Do(request)
	if err != nil {
		return ChatCompletionResult{}, fmt.Errorf("openrouter chat completion: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	requestID := response.Header.Get("X-Request-Id")
	// Bounded: a completion is text, and a provider answering with megabytes
	// must not be able to exhaust the process reading it.
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return ChatCompletionResult{}, &Error{Status: response.StatusCode, Detail: "unreadable body"}
	}
	if response.StatusCode != http.StatusOK {
		return ChatCompletionResult{}, &Error{
			Status: response.StatusCode,
			Detail: strings.TrimSpace(string(raw)),
		}
	}

	var wire struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return ChatCompletionResult{}, &Error{Status: response.StatusCode, Detail: "unusable response"}
	}
	// OpenRouter reports some provider failures as a 200 carrying an error
	// object. Reading only the choices would turn one of those into an empty
	// answer, which every caller then has to guess about.
	if wire.Error != nil {
		return ChatCompletionResult{}, &Error{Status: response.StatusCode, Detail: wire.Error.Message}
	}
	if len(wire.Choices) == 0 {
		return ChatCompletionResult{}, &Error{Status: response.StatusCode, Detail: "no choices"}
	}
	content := wire.Choices[0].Message.Content
	if !utf8.ValidString(content) {
		return ChatCompletionResult{}, &Error{Status: response.StatusCode, Detail: "invalid UTF-8"}
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

func validateChatRequest(input ChatCompletionRequest) error {
	if strings.TrimSpace(input.Model) == "" || !utf8.ValidString(input.Model) {
		return errors.New("openrouter chat model is required")
	}
	if len(input.Messages) == 0 || len(input.Messages) > maxChatMessages {
		return errors.New("openrouter chat messages must contain 1 to 32 entries")
	}
	if !input.ResponseFormat.valid() {
		return errors.New("openrouter chat response format is invalid")
	}
	for _, message := range input.Messages {
		switch strings.TrimSpace(message.Role) {
		case "user", "assistant", "system":
		default:
			return errors.New("openrouter chat message role is invalid")
		}
		if !utf8.ValidString(message.Content) || len(message.Content) == 0 ||
			len(message.Content) > MaxChatContentBytes {
			return errors.New("openrouter chat message content must contain 1 to 65536 UTF-8 bytes")
		}
	}
	return nil
}
