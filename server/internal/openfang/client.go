package openfang

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const maxMessageBytes = 64 * 1024

// Runtime is the typed OpenFang surface consumed by Berry's product layer.
// Implementations must never retry DispatchMessage or StopAgent.
type Runtime interface {
	ListAgents(context.Context) ([]AgentSummary, error)
	GetAgent(context.Context, uuid.UUID) (AgentDetail, error)
	DispatchMessage(context.Context, uuid.UUID, MessageRequest) (EventStream, error)
	StopAgent(context.Context, uuid.UUID) (StopResponse, error)
}

// EventStream is the lifecycle-safe typed stream consumed by run workers.
type EventStream interface {
	Next() (StreamEvent, error)
	RequestID() string
	Close() error
}

// AgentIdentity contains only display-safe upstream identity fields.
type AgentIdentity struct {
	Emoji     *string `json:"emoji"`
	AvatarURL *string `json:"avatar_url"`
	Color     *string `json:"color"`
}

// AgentSummary is the pinned GET /api/agents response projection.
type AgentSummary struct {
	ID            uuid.UUID
	Name          string
	State         string
	Mode          string
	CreatedAt     time.Time
	LastActive    time.Time
	ModelProvider string
	ModelName     string
	ModelTier     string
	AuthStatus    string
	Ready         bool
	IsInferencing bool
	Profile       *string
	Identity      AgentIdentity
}

// AgentDetail intentionally omits system prompts and provider credentials.
type AgentDetail struct {
	ID           uuid.UUID
	Name         string
	State        string
	Mode         string
	Profile      *string
	CreatedAt    time.Time
	SessionID    uuid.UUID
	Model        AgentModel
	Capabilities AgentCapabilities
	Description  string
	// SystemPrompt is the instruction set applied to every task this agent
	// runs. Present only on the detail response, never on the list.
	SystemPrompt string
	Tags         []string
	Identity     AgentIdentity
	// Limits is the manifest limit snapshot; nil when not reported.
	Limits *AgentLimits
}

// AgentLimits are the manifest limits the runtime exposes on the detail
// response when it does: the per-reply token cap and the hourly LLM token
// budget. Nil when the pinned runtime does not report them.
type AgentLimits struct {
	MaxTokens           *int64 `json:"maxTokens"`
	MaxLLMTokensPerHour *int64 `json:"maxLLMTokensPerHour"`
}

// AgentModel is display metadata, not provider configuration.
type AgentModel struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// AgentCapabilities is the pinned detail response capability projection.
type AgentCapabilities struct {
	Tools   []string `json:"tools"`
	Network []string `json:"network"`
}

// MessageRequest is a single unsafe dispatch. RequestID is forwarded for
// correlation and never included in the JSON message body.
type MessageRequest struct {
	Message    string
	SenderID   *string
	SenderName *string
	RequestID  string
}

// StopResponse is the bounded pinned cancellation response.
type StopResponse struct {
	Status          string `json:"status"`
	Message         string `json:"message"`
	HandDeactivated bool   `json:"hand_deactivated,omitempty"`
	HandID          string `json:"hand_id,omitempty"`
	InstanceID      string `json:"instance_id,omitempty"`
	RequestID       string `json:"-"`
}

// Confirmed reports whether the upstream response confirms active execution
// was stopped. "No active run" deliberately requires reconciliation.
func (response StopResponse) Confirmed() bool {
	return response.Status == "ok" &&
		(response.Message == "Run cancelled" ||
			response.Message == "Hand deactivated" ||
			response.HandDeactivated)
}

type agentSummaryWire struct {
	ID            string        `json:"id"`
	Name          string        `json:"name"`
	State         string        `json:"state"`
	Mode          string        `json:"mode"`
	CreatedAt     string        `json:"created_at"`
	LastActive    string        `json:"last_active"`
	ModelProvider string        `json:"model_provider"`
	ModelName     string        `json:"model_name"`
	ModelTier     string        `json:"model_tier"`
	AuthStatus    string        `json:"auth_status"`
	Ready         bool          `json:"ready"`
	IsInferencing bool          `json:"is_inferencing"`
	Profile       *string       `json:"profile"`
	Identity      AgentIdentity `json:"identity"`
}

type agentDetailWire struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	State        string            `json:"state"`
	Mode         string            `json:"mode"`
	Profile      *string           `json:"profile"`
	CreatedAt    string            `json:"created_at"`
	SessionID    string            `json:"session_id"`
	Model        AgentModel        `json:"model"`
	Capabilities AgentCapabilities `json:"capabilities"`
	Description  string            `json:"description"`
	SystemPrompt string            `json:"system_prompt"`
	Tags         []string          `json:"tags"`
	Identity     AgentIdentity     `json:"identity"`
	// The pinned runtime exposes manifest limits either at the top level or
	// under a limits object depending on the build; both are read.
	MaxTokens           *int64 `json:"max_tokens"`
	MaxLLMTokensPerHour *int64 `json:"max_llm_tokens_per_hour"`
	Limits              *struct {
		MaxTokens           *int64 `json:"max_tokens"`
		MaxLLMTokensPerHour *int64 `json:"max_llm_tokens_per_hour"`
	} `json:"limits"`
}

// limits folds the two wire placements into one snapshot.
func (wire agentDetailWire) limits() *AgentLimits {
	maxTokens, perHour := wire.MaxTokens, wire.MaxLLMTokensPerHour
	if wire.Limits != nil {
		if maxTokens == nil {
			maxTokens = wire.Limits.MaxTokens
		}
		if perHour == nil {
			perHour = wire.Limits.MaxLLMTokensPerHour
		}
	}
	if maxTokens == nil && perHour == nil {
		return nil
	}
	return &AgentLimits{MaxTokens: maxTokens, MaxLLMTokensPerHour: perHour}
}

// ListAgents performs a bounded, retryable read and validates UUID/time fields.
func (client *Client) ListAgents(ctx context.Context) ([]AgentSummary, error) {
	var wire []agentSummaryWire
	requestID, err := client.readJSON(ctx, "/api/agents", &wire)
	if err != nil {
		return nil, err
	}
	result := make([]AgentSummary, 0, len(wire))
	for _, item := range wire {
		id, createdAt, lastActive, err := validateAgentSummary(item)
		if err != nil {
			return nil, badResponse(requestID)
		}
		result = append(result, AgentSummary{
			ID:            id,
			Name:          item.Name,
			State:         item.State,
			Mode:          item.Mode,
			CreatedAt:     createdAt,
			LastActive:    lastActive,
			ModelProvider: item.ModelProvider,
			ModelName:     item.ModelName,
			ModelTier:     item.ModelTier,
			AuthStatus:    item.AuthStatus,
			Ready:         item.Ready,
			IsInferencing: item.IsInferencing,
			Profile:       item.Profile,
			Identity:      item.Identity,
		})
	}
	return result, nil
}

// GetAgent performs a bounded, retryable read of display-safe runtime detail.
func (client *Client) GetAgent(ctx context.Context, agentID uuid.UUID) (AgentDetail, error) {
	if agentID == uuid.Nil {
		return AgentDetail{}, errors.New("runtime agent ID is required")
	}
	var wire agentDetailWire
	requestID, err := client.readJSON(ctx, "/api/agents/"+agentID.String(), &wire)
	if err != nil {
		return AgentDetail{}, err
	}
	id, err := parseCanonicalUUID(wire.ID)
	if err != nil || id != agentID {
		return AgentDetail{}, badResponse(requestID)
	}
	createdAt, err := time.Parse(time.RFC3339, wire.CreatedAt)
	if err != nil {
		return AgentDetail{}, badResponse(requestID)
	}
	sessionID, err := parseCanonicalUUID(wire.SessionID)
	if err != nil {
		return AgentDetail{}, badResponse(requestID)
	}
	if strings.TrimSpace(wire.Name) == "" || !utf8.ValidString(wire.Name) {
		return AgentDetail{}, badResponse(requestID)
	}
	if wire.Capabilities.Tools == nil {
		wire.Capabilities.Tools = []string{}
	}
	if wire.Capabilities.Network == nil {
		wire.Capabilities.Network = []string{}
	}
	if wire.Tags == nil {
		wire.Tags = []string{}
	}
	return AgentDetail{
		ID:           id,
		Name:         wire.Name,
		State:        wire.State,
		Mode:         wire.Mode,
		Profile:      wire.Profile,
		CreatedAt:    createdAt.UTC(),
		SessionID:    sessionID,
		Model:        wire.Model,
		Capabilities: wire.Capabilities,
		Description:  wire.Description,
		SystemPrompt: wire.SystemPrompt,
		Tags:         wire.Tags,
		Identity:     wire.Identity,
		Limits:       wire.limits(),
	}, nil
}

// DispatchMessage performs the unsafe POST exactly once and returns a bounded
// stream reader. How the body ends (EOF before any done is interrupted) is
// surfaced by MessageStream.Next.
func (client *Client) DispatchMessage(
	ctx context.Context,
	agentID uuid.UUID,
	input MessageRequest,
) (EventStream, error) {
	if agentID == uuid.Nil {
		return nil, errors.New("runtime agent ID is required")
	}
	if !utf8.ValidString(input.Message) || len(input.Message) == 0 ||
		len(input.Message) > maxMessageBytes {
		return nil, errors.New("runtime message must contain 1 to 65536 UTF-8 bytes")
	}
	streamCtx, cancel := context.WithTimeout(ctx, client.streamTimeout)
	request, err := client.NewJSONRequest(
		streamCtx,
		http.MethodPost,
		"/api/agents/"+agentID.String()+"/message/stream",
		struct {
			Message    string  `json:"message"`
			SenderID   *string `json:"sender_id,omitempty"`
			SenderName *string `json:"sender_name,omitempty"`
		}{
			Message:    input.Message,
			SenderID:   input.SenderID,
			SenderName: input.SenderName,
		},
	)
	if err != nil {
		cancel()
		return nil, err
	}
	request.Header.Set("Accept", "text/event-stream")
	if validForwardedRequestID(input.RequestID) {
		request.Header.Set("X-Request-Id", input.RequestID)
	}
	response, err := client.Do(streamCtx, request, RetryUnsafe)
	if err != nil {
		cancel()
		return nil, err
	}
	requestID := response.Header.Get("X-Request-Id")
	if response.StatusCode != http.StatusOK || !isEventStream(response.Header.Get("Content-Type")) {
		_ = response.Body.Close()
		cancel()
		return nil, badResponse(requestID)
	}
	return newMessageStream(
		streamCtx,
		cancel,
		response.Body,
		requestID,
		client.maxStreamBytes,
		client.maxEventBytes,
	), nil
}

// StopAgent sends the pinned unsafe stop request exactly once.
func (client *Client) StopAgent(ctx context.Context, agentID uuid.UUID) (StopResponse, error) {
	if agentID == uuid.Nil {
		return StopResponse{}, errors.New("runtime agent ID is required")
	}
	callCtx, cancel := context.WithTimeout(ctx, client.requestTimeout)
	defer cancel()
	request, err := client.NewJSONRequest(
		callCtx,
		http.MethodPost,
		"/api/agents/"+agentID.String()+"/stop",
		nil,
	)
	if err != nil {
		return StopResponse{}, err
	}
	response, err := client.Do(callCtx, request, RetryUnsafe)
	if err != nil {
		return StopResponse{}, err
	}
	defer response.Body.Close()
	var result StopResponse
	if err := decodeBoundedJSON(response.Body, client.maxJSONBytes, &result); err != nil ||
		result.Status == "" || result.Message == "" {
		return StopResponse{}, badResponse(response.Header.Get("X-Request-Id"))
	}
	result.RequestID = response.Header.Get("X-Request-Id")
	return result, nil
}

func (client *Client) readJSON(ctx context.Context, path string, target any) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, client.requestTimeout)
	defer cancel()
	request, err := client.NewJSONRequest(callCtx, http.MethodGet, path, nil)
	if err != nil {
		return "", err
	}
	response, err := client.Do(callCtx, request, RetryRead)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	requestID := response.Header.Get("X-Request-Id")
	if response.StatusCode != http.StatusOK {
		return requestID, badResponse(requestID)
	}
	if err := decodeBoundedJSON(response.Body, client.maxJSONBytes, target); err != nil {
		return requestID, badResponse(requestID)
	}
	return requestID, nil
}

func decodeBoundedJSON(reader io.Reader, limit int64, target any) error {
	if limit < 1 {
		return errors.New("invalid runtime response limit")
	}
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || int64(len(body)) > limit {
		return errors.New("runtime response exceeded its safe limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(target); err != nil {
		return errors.New("runtime response contained invalid JSON")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("runtime response contained multiple JSON values")
	}
	return nil
}

func validateAgentSummary(
	item agentSummaryWire,
) (uuid.UUID, time.Time, time.Time, error) {
	id, err := parseCanonicalUUID(item.ID)
	if err != nil || strings.TrimSpace(item.Name) == "" || !utf8.ValidString(item.Name) {
		return uuid.Nil, time.Time{}, time.Time{}, errors.New("invalid runtime agent summary")
	}
	createdAt, err := time.Parse(time.RFC3339, item.CreatedAt)
	if err != nil {
		return uuid.Nil, time.Time{}, time.Time{}, err
	}
	lastActive, err := time.Parse(time.RFC3339, item.LastActive)
	if err != nil {
		return uuid.Nil, time.Time{}, time.Time{}, err
	}
	return id, createdAt.UTC(), lastActive.UTC(), nil
}

func parseCanonicalUUID(raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(raw)
	if err != nil || id == uuid.Nil || !strings.EqualFold(id.String(), raw) {
		return uuid.Nil, errors.New("invalid canonical UUID")
	}
	return id, nil
}

func badResponse(requestID string) *UpstreamError {
	return &UpstreamError{
		Kind:       ErrorBadResponse,
		RequestID:  requestID,
		StatusCode: http.StatusBadGateway,
	}
}

func isEventStream(raw string) bool {
	mediaType, _, err := mime.ParseMediaType(raw)
	return err == nil && strings.EqualFold(mediaType, "text/event-stream")
}

func validForwardedRequestID(value string) bool {
	if len(value) < 8 || len(value) > 128 || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character < 0x21 || character > 0x7e {
			return false
		}
	}
	return true
}

var _ Runtime = (*Client)(nil)

func safeRuntimeError(operation string, err error) error {
	if err == nil {
		return nil
	}
	var upstream *UpstreamError
	if errors.As(err, &upstream) {
		return upstream
	}
	return fmt.Errorf("%s: %w", operation, err)
}

// SpawnAgent registers a new agent with the runtime from a TOML manifest.
//
// This is an UNSAFE create: the pinned contract documents no idempotency key,
// so a repeated call produces a second agent. It is attempted exactly once and
// callers must confirm absence before invoking it. Berry uses it only to
// provision the built-in orchestrator, guarded by a durable check that the
// workspace's recorded upstream agent is genuinely missing.
func (client *Client) SpawnAgent(
	ctx context.Context,
	manifestTOML string,
) (SpawnResponse, error) {
	manifest := strings.TrimSpace(manifestTOML)
	if manifest == "" {
		return SpawnResponse{}, errors.New("runtime agent manifest is required")
	}
	if len(manifest) > maxManifestBytes {
		return SpawnResponse{}, errors.New("runtime agent manifest is too large")
	}
	callCtx, cancel := context.WithTimeout(ctx, client.requestTimeout)
	defer cancel()
	request, err := client.NewJSONRequest(
		callCtx,
		http.MethodPost,
		"/api/agents",
		map[string]string{"manifest_toml": manifest},
	)
	if err != nil {
		return SpawnResponse{}, err
	}
	response, err := client.Do(callCtx, request, RetryUnsafe)
	if err != nil {
		return SpawnResponse{}, err
	}
	defer response.Body.Close()
	var result SpawnResponse
	if err := decodeBoundedJSON(
		response.Body,
		client.maxJSONBytes,
		&result,
	); err != nil || result.AgentID == uuid.Nil {
		return SpawnResponse{}, badResponse(response.Header.Get("X-Request-Id"))
	}
	result.RequestID = response.Header.Get("X-Request-Id")
	return result, nil
}

// PatchAgent updates mutable agent configuration upstream.
//
// Only the fields Berry authors are sent. The pinned contract's PATCH accepts a
// subset of name, description, model, provider, and system_prompt; anything not
// set here is left untouched rather than cleared, so Berry cannot flatten
// configuration it does not own.
//
// This is an idempotent write — the same body applied twice leaves the same
// state — so unlike agent creation or message dispatch it is safe to retry.
func (client *Client) PatchAgent(
	ctx context.Context,
	agentID uuid.UUID,
	request PatchAgentRequest,
) error {
	if agentID == uuid.Nil {
		return errors.New("runtime agent ID is required")
	}
	body := map[string]string{}
	if request.SystemPrompt != nil {
		if len(*request.SystemPrompt) > maxSystemPromptBytes {
			return errors.New("runtime agent system prompt is too large")
		}
		body["system_prompt"] = *request.SystemPrompt
	}
	if request.Description != nil {
		body["description"] = *request.Description
	}
	if request.Provider != nil && request.Model != nil {
		body["provider"] = *request.Provider
		body["model"] = *request.Model
	}
	if len(body) == 0 {
		return nil
	}

	callCtx, cancel := context.WithTimeout(ctx, client.requestTimeout)
	defer cancel()
	httpRequest, err := client.NewJSONRequest(
		callCtx,
		http.MethodPatch,
		"/api/agents/"+agentID.String(),
		body,
	)
	if err != nil {
		return err
	}
	response, err := client.Do(callCtx, httpRequest, RetryIdempotentWrite)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	return nil
}

// DeleteAgent removes an agent Berry owns from the runtime. Deleting is
// idempotent upstream, so it is classified RetryIdempotentWrite; a 404
// surfaces as an UpstreamError the caller may treat as already gone.
func (client *Client) DeleteAgent(ctx context.Context, agentID uuid.UUID) error {
	if agentID == uuid.Nil {
		return errors.New("runtime agent ID is required")
	}
	callCtx, cancel := context.WithTimeout(ctx, client.requestTimeout)
	defer cancel()
	httpRequest, err := client.NewJSONRequest(callCtx, http.MethodDelete, "/api/agents/"+agentID.String(), nil)
	if err != nil {
		return err
	}
	response, err := client.Do(callCtx, httpRequest, RetryIdempotentWrite)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	return nil
}

// SendAgentMessage runs one agent turn and waits for the whole answer.
//
// The streaming sibling exists for issue runs, where tool activity must stay
// visible as it happens. Chat wants the finished reply, so this uses the
// blocking endpoint and avoids projecting a stream nobody watches.
//
// UNSAFE: this executes the agent and spends provider tokens. Classified
// RetryUnsafe and attempted exactly once — a retry after an ambiguous response
// bills twice and can repeat tool side effects.
func (client *Client) SendAgentMessage(
	ctx context.Context,
	agentID uuid.UUID,
	request MessageRequest,
) (AgentReply, error) {
	if agentID == uuid.Nil {
		return AgentReply{}, errors.New("runtime agent ID is required")
	}
	if strings.TrimSpace(request.Message) == "" {
		return AgentReply{}, errors.New("runtime agent message is required")
	}
	// Chat turns are bounded well above a plain request, since the agent may
	// call tools before it answers, but not by the run stream bound: the
	// caller is a request handler waiting on one HTTP response, and a run's
	// hours-long allowance would pin it on a hung upstream.
	callCtx, cancel := context.WithTimeout(ctx, client.messageTimeout)
	defer cancel()

	body := map[string]any{"message": request.Message}
	if request.SenderID != nil {
		body["sender_id"] = *request.SenderID
	}
	if request.SenderName != nil {
		body["sender_name"] = *request.SenderName
	}
	httpRequest, err := client.NewJSONRequest(
		callCtx,
		http.MethodPost,
		"/api/agents/"+agentID.String()+"/message",
		body,
	)
	if err != nil {
		return AgentReply{}, err
	}
	response, err := client.Do(callCtx, httpRequest, RetryUnsafe)
	if err != nil {
		return AgentReply{}, err
	}
	defer response.Body.Close()

	var reply AgentReply
	if err := decodeBoundedJSON(response.Body, client.maxJSONBytes, &reply); err != nil {
		return AgentReply{}, badResponse(response.Header.Get("X-Request-Id"))
	}
	reply.RequestID = response.Header.Get("X-Request-Id")
	return reply, nil
}

// ListModelCatalog returns the runtime's selectable models.
//
// Distinct from ListModels, which serves the OpenAI-compatible surface and
// reports agents as models. This is the provider catalog an operator picks
// from when choosing what an agent runs on.
func (client *Client) ListModelCatalog(ctx context.Context) ([]CatalogModel, error) {
	var payload struct {
		Models []CatalogModel `json:"models"`
	}
	if _, err := client.readJSON(ctx, "/api/models", &payload); err != nil {
		return nil, err
	}
	return payload.Models, nil
}
