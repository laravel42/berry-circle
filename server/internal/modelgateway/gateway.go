// Package modelgateway routes the planner's model roles — classifier,
// planner, repair, critic — through lean agents Berry provisions on the
// runtime (D6). A role is an agent name on OpenFang's OpenAI-compatible chat
// route, so every call carries the agent's configured provider and model,
// answers as one JSON object, and is recorded with its usage. Nothing here
// retries a paid call: the bounded repair loop in the planner is the one
// recorded exception (ADR-0007) and each of its rounds is a new request.
package modelgateway

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// Role is one logical model role.
type Role string

// The four roles. Order matters for provisioning: the classifier is the
// cheapest and runs first in every pipeline.
const (
	RoleClassifier Role = "classifier"
	RolePlanner    Role = "planner"
	RoleRepair     Role = "repair"
	RoleCritic     Role = "critic"
)

// Roles lists every role in provisioning order.
var Roles = []Role{RoleClassifier, RolePlanner, RoleRepair, RoleCritic}

// Valid reports whether the role is one of the four.
func (role Role) Valid() bool {
	switch role {
	case RoleClassifier, RolePlanner, RoleRepair, RoleCritic:
		return true
	}
	return false
}

// Request is one task for a role: a single user message the agent's system
// prompt frames. SchemaName names what the reply must decode as and is
// recorded, never sent.
type Request struct {
	User       string
	SchemaName string
}

// Reply is what came back, with everything the ledger records.
type Reply struct {
	Content       string
	InputTokens   int64
	OutputTokens  int64
	Provider      string
	Model         string
	PromptVersion string
	RequestID     string
	// CostMicros is usage priced through the catalog, nil when the model's
	// price is unknown.
	CostMicros *int64
	Duration   time.Duration
}

var (
	// ErrRoleUnavailable means the role has no available agent: provisioning
	// failed or never ran. Callers answer PLANNER_UNAVAILABLE.
	ErrRoleUnavailable = errors.New("model role is not available")
	// ErrRateLimited means the upstream refused the call for quota; the
	// planner surfaces ROLE_RATE_LIMITED and never retries.
	ErrRateLimited = errors.New("model role is rate limited")
	// ErrRequestTooLarge means the task exceeds the one-message bound.
	ErrRequestTooLarge = errors.New("model request exceeds the message bound")
	// ErrEmptyReply means the upstream answered with nothing to parse.
	ErrEmptyReply = errors.New("model reply is empty")
)

// Gateway is what the planner calls.
type Gateway interface {
	// Complete sends one task to a role and returns the reply.
	Complete(ctx context.Context, role Role, request Request) (Reply, error)
	// Ready reports whether every role can be called; the error names the
	// first role that cannot.
	Ready(ctx context.Context) error
}

// RoleReader reads provisioned role agents.
type RoleReader interface {
	Get(ctx context.Context, role Role) (RoleAgent, error)
	List(ctx context.Context) ([]RoleAgent, error)
}

// Price is a model's list price per million tokens.
type Price struct {
	InputPerMillion  float64
	OutputPerMillion float64
}

// PriceLookup answers what a model costs; ok is false when unknown.
type PriceLookup interface {
	Price(ctx context.Context, provider, model string) (Price, bool)
}

// OpenFangGateway completes role calls through the runtime's chat route.
type OpenFangGateway struct {
	chat   openfang.Compatibility
	roles  RoleReader
	prices PriceLookup
	clock  func() time.Time
}

// NewOpenFang builds the gateway. Prices may be nil, in which case cost is
// never filled.
func NewOpenFang(chat openfang.Compatibility, roles RoleReader, prices PriceLookup) (*OpenFangGateway, error) {
	if chat == nil {
		return nil, errors.New("model gateway chat client is nil")
	}
	if roles == nil {
		return nil, errors.New("model gateway role reader is nil")
	}
	return &OpenFangGateway{chat: chat, roles: roles, prices: prices, clock: time.Now}, nil
}

// Complete sends the task as one user message with a JSON-object response
// format and prices the usage.
func (gateway *OpenFangGateway) Complete(ctx context.Context, role Role, request Request) (Reply, error) {
	if !role.Valid() {
		return Reply{}, fmt.Errorf("model role %q is unknown", role)
	}
	task := strings.TrimSpace(request.User)
	if task == "" {
		return Reply{}, errors.New("model request is empty")
	}
	if len(task) > openfang.MaxChatContentBytes {
		return Reply{}, ErrRequestTooLarge
	}
	agent, err := gateway.roles.Get(ctx, role)
	if errors.Is(err, ErrNotFound) {
		return Reply{}, ErrRoleUnavailable
	}
	if err != nil {
		return Reply{}, err
	}
	if agent.Status != StatusAvailable {
		return Reply{}, ErrRoleUnavailable
	}
	started := gateway.clock()
	result, err := gateway.chat.CreateChatCompletion(ctx, openfang.ChatCompletionRequest{
		Model:          agent.UpstreamName,
		Messages:       []openfang.ChatMessage{{Role: "user", Content: task}},
		ResponseFormat: openfang.ChatResponseFormatJSONObject,
	})
	duration := gateway.clock().Sub(started)
	if err != nil {
		var upstream *openfang.UpstreamError
		if errors.As(err, &upstream) && upstream.Kind == openfang.ErrorRateLimited {
			return Reply{Provider: agent.Provider, Model: agent.Model, PromptVersion: agent.PromptVersion, RequestID: upstream.RequestID, Duration: duration}, ErrRateLimited
		}
		return Reply{Provider: agent.Provider, Model: agent.Model, PromptVersion: agent.PromptVersion, Duration: duration}, err
	}
	reply := Reply{
		Content:       result.Content,
		InputTokens:   int64(result.Usage.InputTokens),
		OutputTokens:  int64(result.Usage.OutputTokens),
		Provider:      agent.Provider,
		Model:         agent.Model,
		PromptVersion: agent.PromptVersion,
		RequestID:     result.RequestID,
		Duration:      duration,
	}
	if gateway.prices != nil {
		if price, ok := gateway.prices.Price(ctx, agent.Provider, agent.Model); ok {
			micros := CostMicros(reply.InputTokens, reply.OutputTokens, price)
			reply.CostMicros = &micros
		}
	}
	if strings.TrimSpace(reply.Content) == "" {
		return reply, ErrEmptyReply
	}
	return reply, nil
}

// Ready checks that every role has an available agent.
func (gateway *OpenFangGateway) Ready(ctx context.Context) error {
	agents, err := gateway.roles.List(ctx)
	if err != nil {
		return err
	}
	byRole := make(map[Role]RoleAgent, len(agents))
	for _, agent := range agents {
		byRole[agent.Role] = agent
	}
	for _, role := range Roles {
		agent, ok := byRole[role]
		if !ok || agent.Status != StatusAvailable {
			return fmt.Errorf("%w: %s", ErrRoleUnavailable, role)
		}
	}
	return nil
}

// CostMicros prices usage in micro-dollars: a per-million price times tokens
// is exactly the cost in millionths of a dollar.
func CostMicros(inputTokens, outputTokens int64, price Price) int64 {
	cost := float64(inputTokens)*price.InputPerMillion + float64(outputTokens)*price.OutputPerMillion
	if cost < 0 || math.IsNaN(cost) || math.IsInf(cost, 0) {
		return 0
	}
	return int64(math.Round(cost))
}

var _ Gateway = (*OpenFangGateway)(nil)
