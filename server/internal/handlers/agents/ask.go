package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/jsonschema"
	"github.com/laravel42/berry-circle/server/internal/modelgateway"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// POST /api/v1/agents/{agentId}/ask: one bounded question to a workspace
// agent, answered as a single JSON value the caller's schema describes.
//
// The call is one chat completion on the runtime's OpenAI-compatible route
// with the agent as the model and a JSON-object response format, exactly
// like the planner roles. It is a paid, unsafe call attempted once: an
// answer that does not decode or does not match the schema is recorded
// and refused, never re-asked. Every ask is an agent_asks row with its
// usage and cost so the spend is visible whether or not the answer was
// usable.

const (
	// MaxAskPromptBytes bounds the prompt; the schema travels in the same
	// message and the runtime caps one message at 64 KiB.
	MaxAskPromptBytes = 48 * 1024
	maxAskSchemaBytes = 8 * 1024
	// askTimeout bounds one completion; the route is a request handler
	// waiting on one HTTP response.
	askTimeout = 5 * time.Minute
)

// AskRecord is one ask as the ledger keeps it.
type AskRecord struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	AgentID       uuid.UUID
	RequestedBy   uuid.UUID
	RequestID     string
	Status        string
	PromptBytes   int
	Answer        json.RawMessage
	FailureCode   string
	Failure       string
	ModelProvider string
	ModelName     string
	InputTokens   int64
	OutputTokens  int64
	CostMicros    *int64
	Currency      string
	UpstreamID    string
	CreatedAt     time.Time
	CompletedAt   time.Time
}

// AskStore persists asks.
type AskStore interface {
	RecordAsk(context.Context, AskRecord) error
}

// PriceLookup prices the agent's model; nil cost when unknown.
type PriceLookup interface {
	Price(ctx context.Context, provider, model string) (modelgateway.Price, bool)
}

type askBody struct {
	Prompt string          `json:"prompt"`
	Schema json.RawMessage `json:"schema"`
}

type askUsage struct {
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	CostMicros   *int64  `json:"costMicros"`
	Currency     *string `json:"currency"`
}

type askModel struct {
	Provider *string `json:"provider"`
	Name     *string `json:"name"`
}

type askResource struct {
	ID        uuid.UUID       `json:"id"`
	AgentID   uuid.UUID       `json:"agentId"`
	Answer    json.RawMessage `json:"answer"`
	Usage     askUsage        `json:"usage"`
	Model     askModel        `json:"model"`
	CreatedAt string          `json:"createdAt"`
}

// askHandler serves the route. Mounted only when the mount has a chat
// client; the ask store is optional so a deployment without the ledger
// migration still answers, at the cost of an unrecorded spend logged as a
// warning.
func askHandler(store Store, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		agentID, err := core.ParseUUID(chi.URLParam(request, "agentId"))
		if err != nil {
			writeNotFound(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := options.Authorization.AuthorizeAgent(request.Context(), user.ID, agentID, identity.PermissionWrite)
		if !writeAgentAuthorization(response, request, err, false) {
			return
		}
		body, _, ok := workmanagement.DecodeJSON[askBody](response, request)
		if !ok {
			return
		}
		prompt := strings.TrimSpace(body.Prompt)
		var fields []httpapi.FieldError
		if prompt == "" || len(prompt) > MaxAskPromptBytes {
			fields = append(fields, httpapi.FieldError{Path: "/prompt", Code: "invalid", Message: "prompt is 1 to 49152 bytes."})
		}
		var schema map[string]any
		switch {
		case len(body.Schema) == 0:
			fields = append(fields, httpapi.FieldError{Path: "/schema", Code: "required", Message: "schema is the JSON Schema the answer must match."})
		case len(body.Schema) > maxAskSchemaBytes:
			fields = append(fields, httpapi.FieldError{Path: "/schema", Code: "too_big", Message: "schema is at most 8 KiB."})
		case json.Unmarshal(body.Schema, &schema) != nil || schema == nil:
			fields = append(fields, httpapi.FieldError{Path: "/schema", Code: "invalid_type", Message: "schema is a JSON Schema object."})
		default:
			if err := jsonschema.Validate(schema); err != nil {
				fields = append(fields, httpapi.FieldError{Path: "/schema", Code: "invalid", Message: "schema is not a JSON Schema Berry can apply: " + err.Error()})
			}
		}
		if len(fields) > 0 {
			workmanagement.WriteValidation(response, request, fields...)
			return
		}
		found, err := store.Get(request.Context(), agentID, scope.WorkspaceID)
		if errors.Is(err, ErrNotFound) {
			writeNotFound(response, request)
			return
		}
		if err != nil {
			writeInternal(response, request)
			return
		}
		if found.ArchivedAt != nil || (found.Status != "available" && found.Status != "busy") {
			httpapi.WriteError(response, request, http.StatusPreconditionFailed, "AGENT_UNAVAILABLE",
				"The agent is not available on the runtime.", map[string]string{"status": found.Status})
			return
		}
		record := AskRecord{
			ID: options.NewID(), WorkspaceID: scope.WorkspaceID, AgentID: found.ID, RequestedBy: user.ID,
			RequestID: httpapi.RequestID(request.Context()), PromptBytes: len(prompt),
			CreatedAt: options.Clock().UTC(),
		}
		if found.ModelProvider != nil {
			record.ModelProvider = *found.ModelProvider
		}
		if found.ModelName != nil {
			record.ModelName = *found.ModelName
		}
		message := prompt + "\n\nAnswer with a single JSON value matching this JSON Schema and nothing else:\n" + string(body.Schema)
		callCtx, cancel := context.WithTimeout(request.Context(), askTimeout)
		defer cancel()
		result, err := options.Chat.CreateChatCompletion(callCtx, openfang.ChatCompletionRequest{
			Model:          found.Name,
			Messages:       []openfang.ChatMessage{{Role: "user", Content: message}},
			ResponseFormat: openfang.ChatResponseFormatJSONObject,
		})
		record.CompletedAt = options.Clock().UTC()
		if err != nil {
			var upstream *openfang.UpstreamError
			if errors.As(err, &upstream) {
				record.UpstreamID = upstream.RequestID
			}
			record.Status, record.FailureCode, record.Failure = "failed", "AGENT_CALL_FAILED", "The agent did not answer."
			options.recordAsk(request.Context(), record)
			if errors.As(err, &upstream) && upstream.Kind == openfang.ErrorRateLimited {
				httpapi.WriteError(response, request, http.StatusTooManyRequests, "RATE_LIMITED",
					"The agent's model is rate limited; try again later.", nil)
				return
			}
			writeDependencyError(response, request, err)
			return
		}
		record.InputTokens, record.OutputTokens, record.UpstreamID = int64(result.Usage.InputTokens), int64(result.Usage.OutputTokens), result.RequestID
		if options.Prices != nil && record.ModelProvider != "" && record.ModelName != "" {
			if price, ok := options.Prices.Price(request.Context(), record.ModelProvider, record.ModelName); ok {
				micros := modelgateway.CostMicros(record.InputTokens, record.OutputTokens, price)
				record.CostMicros, record.Currency = &micros, "USD"
			}
		}
		answer, hint := decodeAnswer(result.Content, schema)
		if hint != "" {
			record.Status, record.FailureCode, record.Failure = "failed", "ANSWER_INVALID", hint
			options.recordAsk(request.Context(), record)
			httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "ANSWER_INVALID",
				"The agent's answer does not match the schema.", map[string]any{
					"hint": hint, "askId": record.ID.String(), "usage": usageResource(record),
				})
			return
		}
		record.Status, record.Answer = "succeeded", answer
		options.recordAsk(request.Context(), record)
		httpapi.WriteJSON(response, http.StatusOK, askResource{
			ID: record.ID, AgentID: found.ID, Answer: answer, Usage: usageResource(record),
			Model:     askModel{Provider: nullable(record.ModelProvider), Name: nullable(record.ModelName)},
			CreatedAt: record.CreatedAt.Format(time.RFC3339Nano),
		})
	}
}

func (options Options) recordAsk(ctx context.Context, record AskRecord) {
	if options.Asks == nil {
		return
	}
	if err := options.Asks.RecordAsk(context.WithoutCancel(ctx), record); err != nil {
		logger := options.Logger
		if logger != nil {
			logger.Warn("agent ask not recorded", "askId", record.ID, "agentId", record.AgentID, "error", err)
		}
	}
}

func usageResource(record AskRecord) askUsage {
	return askUsage{InputTokens: record.InputTokens, OutputTokens: record.OutputTokens, CostMicros: record.CostMicros, Currency: nullable(record.Currency)}
}

func nullable(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// decodeAnswer reads the reply as JSON, tolerating a code fence or prose
// around it, and checks it against the schema. The hint names what went
// wrong in the terms a caller can act on; the reply itself is never echoed.
func decodeAnswer(content string, schema map[string]any) (json.RawMessage, string) {
	text := strings.TrimSpace(content)
	if strings.HasPrefix(text, "```") {
		text = strings.TrimPrefix(text, "```json")
		text = strings.TrimPrefix(text, "```")
		text = strings.TrimSuffix(text, "```")
		text = strings.TrimSpace(text)
	}
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		start := strings.IndexAny(text, "{[")
		end := strings.LastIndexAny(text, "}]")
		if start < 0 || end <= start || json.Unmarshal([]byte(text[start:end+1]), &value) != nil {
			return nil, "The answer is not a JSON value."
		}
		text = text[start : end+1]
	}
	if err := jsonschema.Check(value, schema); err != nil {
		return nil, err.Error()
	}
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > 256<<10 {
		return nil, "The answer is too large to record."
	}
	return encoded, ""
}
