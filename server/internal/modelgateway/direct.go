package modelgateway

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openrouter"
)

// The planner's model roles without a runtime in between.
//
// A role is a provider, a model and a system prompt. OpenFang held all three
// inside an agent it spawned, so Berry named the agent and let the runtime
// supply them; Berry has had all three the whole time — the provider and model
// come from deployment configuration and the prompt is compiled into the
// binary — so the agent was a place to keep a copy of what the caller already
// knew.
//
// Removing it removes the two failure modes that copy created: a role whose
// upstream agent drifted from the spec, and a role that could not be called at
// all because the spawn never happened.

// Completer is the one model call a role makes.
type Completer interface {
	CreateChatCompletion(context.Context, openrouter.ChatCompletionRequest) (openrouter.ChatCompletionResult, error)
}

// DirectGateway completes role calls against the role's own model.
type DirectGateway struct {
	chat    Completer
	roles   RoleReader
	prompts map[Role]Prompt
	prices  PriceLookup
	clock   func() time.Time
}

// NewDirect builds the gateway. Prices may be nil, in which case cost is never
// filled — the same latitude the runtime gateway allows.
func NewDirect(
	chat Completer,
	roles RoleReader,
	prompts map[Role]Prompt,
	prices PriceLookup,
) (*DirectGateway, error) {
	if chat == nil {
		return nil, errors.New("model gateway chat client is nil")
	}
	if roles == nil {
		return nil, errors.New("model gateway role reader is nil")
	}
	if len(prompts) == 0 {
		// A role called without its system prompt is a different role, and the
		// difference would show up as worse output rather than as an error.
		return nil, errors.New("model gateway role prompts are missing")
	}
	return &DirectGateway{
		chat:    chat,
		roles:   roles,
		prompts: prompts,
		prices:  prices,
		clock:   time.Now,
	}, nil
}

// Complete sends the role's prompt and the task, and prices the usage.
func (gateway *DirectGateway) Complete(ctx context.Context, role Role, request Request) (Reply, error) {
	if gateway == nil {
		return Reply{}, errors.New("model gateway is not configured")
	}
	task := strings.TrimSpace(request.User)
	if task == "" {
		return Reply{}, errors.New("model request is empty")
	}
	if len(task) > openrouter.MaxChatContentBytes {
		return Reply{}, ErrRequestTooLarge
	}
	agent, err := gateway.roles.Get(ctx, role)
	if errors.Is(err, ErrNotFound) {
		return Reply{}, ErrRoleUnavailable
	}
	if err != nil {
		return Reply{}, err
	}
	if agent.Status != StatusAvailable || strings.TrimSpace(agent.Model) == "" {
		return Reply{}, ErrRoleUnavailable
	}
	prompt, ok := gateway.prompts[role]
	if !ok || strings.TrimSpace(prompt.Text) == "" {
		return Reply{}, fmt.Errorf("%w: %s has no prompt", ErrRoleUnavailable, role)
	}

	started := gateway.clock()
	result, err := gateway.chat.CreateChatCompletion(ctx, openrouter.ChatCompletionRequest{
		Model: agent.Model,
		Messages: []openrouter.ChatMessage{
			// The prompt the runtime used to hold, sent as the system turn it
			// always was.
			{Role: "system", Content: prompt.Text},
			{Role: "user", Content: task},
		},
		ResponseFormat: openrouter.ChatResponseFormatJSONObject,
	})
	duration := gateway.clock().Sub(started)
	// The reply carries what was attempted even when the attempt failed: the
	// ledger records which model was asked and what it cost in time, and a
	// failed call that names nothing is a row nobody can act on.
	attempted := Reply{
		Provider:      agent.Provider,
		Model:         agent.Model,
		PromptVersion: agent.PromptVersion,
		Duration:      duration,
	}
	if err != nil {
		var upstream *openrouter.Error
		if errors.As(err, &upstream) {
			attempted.RequestID = result.RequestID
			if upstream.Status == 429 {
				return attempted, ErrRateLimited
			}
		}
		return attempted, err
	}

	reply := attempted
	reply.Content = result.Content
	reply.InputTokens = int64(result.Usage.InputTokens)
	reply.OutputTokens = int64(result.Usage.OutputTokens)
	reply.RequestID = result.RequestID
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

// Ready checks that every role can be called.
func (gateway *DirectGateway) Ready(ctx context.Context) error {
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
		if !ok || agent.Status != StatusAvailable || strings.TrimSpace(agent.Model) == "" {
			return fmt.Errorf("%w: %s", ErrRoleUnavailable, role)
		}
		if prompt, ok := gateway.prompts[role]; !ok || strings.TrimSpace(prompt.Text) == "" {
			return fmt.Errorf("%w: %s has no prompt", ErrRoleUnavailable, role)
		}
	}
	return nil
}

// EnsureLocalRoleAgents records each configured role so it can be called.
//
// The counterpart to EnsureRoleAgents with the spawning removed. There is no
// upstream agent to probe, no manifest to compare against and no drift to
// correct: the row holds what the deployment configured, and a change to the
// configuration is applied by writing it.
//
// A role the deployment did not configure is left alone rather than defaulted.
// Berry does not choose an LLM for an operator, and a planner quietly running
// on a model nobody picked is worse than a planner that says it is unavailable.
func EnsureLocalRoleAgents(
	ctx context.Context,
	store Store,
	specs RoleSpecs,
	prompts map[Role]Prompt,
	now func() time.Time,
) error {
	if store == nil {
		return errors.New("model role store is nil")
	}
	if now == nil {
		now = time.Now
	}
	var problems []string
	for _, role := range Roles {
		spec := specs.For(role)
		prompt, hasPrompt := prompts[role]
		if !spec.Configured() || !hasPrompt || strings.TrimSpace(prompt.Text) == "" {
			problems = append(problems, string(role))
			continue
		}
		if err := store.Upsert(ctx, RoleAgent{
			Role: role,
			// Nothing upstream owns this role any more. The columns stay
			// because the table is shared with the runtime path for as long as
			// that path exists; a nil UUID is the honest value for "no agent".
			OpenFangAgentID: uuid.Nil,
			UpstreamName:    string(role),
			Provider:        strings.TrimSpace(spec.Provider),
			Model:           strings.TrimSpace(spec.Model),
			PromptVersion:   prompt.Version,
			// MaxTokens is left unset rather than carried over. It existed to
			// raise the runtime's 4096-token manifest default, which truncated
			// plans; calling the provider directly there is no such default to
			// raise, so writing the number would impose a cap that does not
			// currently exist.
			ManifestRevision: "",
			Status:           StatusAvailable,
		}, now()); err != nil {
			return fmt.Errorf("record model role %s: %w", role, err)
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("model roles are not configured: %s", strings.Join(problems, ", "))
	}
	return nil
}
