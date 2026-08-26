package modelgateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// RoleSpec is the provider/model pair a role runs on. Deployment choices:
// Berry never picks an LLM for an operator.
type RoleSpec struct {
	Provider string
	Model    string
}

// Configured reports whether both halves are set.
func (spec RoleSpec) Configured() bool {
	return strings.TrimSpace(spec.Provider) != "" && strings.TrimSpace(spec.Model) != ""
}

// RoleSpecs is the per-role configuration plus the manifest limits every
// role agent is spawned with.
type RoleSpecs struct {
	Classifier RoleSpec
	Planner    RoleSpec
	Repair     RoleSpec
	Critic     RoleSpec
	// MaxOutputTokens is the manifest's [model] max_tokens. The runtime
	// default of 4096 truncates a plan of any size.
	MaxOutputTokens int
	// TokensPerHour is the manifest's [resources] max_llm_tokens_per_hour;
	// zero means DefaultTokensPerHour.
	TokensPerHour int64
}

// For returns the spec of one role.
func (specs RoleSpecs) For(role Role) RoleSpec {
	switch role {
	case RoleClassifier:
		return specs.Classifier
	case RolePlanner:
		return specs.Planner
	case RoleRepair:
		return specs.Repair
	case RoleCritic:
		return specs.Critic
	}
	return RoleSpec{}
}

// Prompt is a role's system prompt with the version recorded on every call.
type Prompt struct {
	Version string
	Text    string
}

// DefaultTokensPerHour is the hourly LLM token budget a role agent is spawned
// with. The bundled manifests carry 100k–200k, which one plan pipeline can
// exhaust; a role agent serves every workspace, so its cap is generous and
// spend is visible per call in planner_events instead.
const DefaultTokensPerHour int64 = 4_000_000

// DefaultMaxOutputTokens mirrors PLANNER_MAX_OUTPUT_TOKENS' default.
const DefaultMaxOutputTokens = 16384

// maxSystemPromptBytes mirrors the runtime patch bound in openfang.
const maxSystemPromptBytes = 20000

// EnsureRoleAgents makes every role callable, mirroring the orchestrator
// bootstrap: read the recorded agent, probe it, spawn one only on a
// definitive 404, correct provider/model/prompt drift in place, and warn
// when the manifest limits differ (only a re-spawn changes those; nothing
// here deletes an agent). Failure is never fatal: a role that cannot be
// provisioned stays offline and the plan routes answer PLANNER_UNAVAILABLE,
// which is visible and safe.
func EnsureRoleAgents(
	ctx context.Context,
	store Store,
	provisioner openfang.Provisioner,
	patcher openfang.AgentPatcher,
	specs RoleSpecs,
	prompts map[Role]Prompt,
	newID func() uuid.UUID,
	logger *slog.Logger,
) error {
	if store == nil {
		return errors.New("role agent store is nil")
	}
	if provisioner == nil {
		return errors.New("role agent provisioner is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if newID == nil {
		newID = uuid.New
	}
	if specs.MaxOutputTokens <= 0 {
		specs.MaxOutputTokens = DefaultMaxOutputTokens
	}
	if specs.TokensPerHour <= 0 {
		specs.TokensPerHour = DefaultTokensPerHour
	}
	for _, role := range Roles {
		if err := ensureRole(ctx, store, provisioner, patcher, specs, role, prompts[role], newID, logger); err != nil {
			// One role failing must not stop the others.
			logger.Warn("role agent provisioning failed", "role", role, "error", err)
		}
	}
	return nil
}

func ensureRole(
	ctx context.Context,
	store Store,
	provisioner openfang.Provisioner,
	patcher openfang.AgentPatcher,
	specs RoleSpecs,
	role Role,
	prompt Prompt,
	newID func() uuid.UUID,
	logger *slog.Logger,
) error {
	spec := specs.For(role)
	if !spec.Configured() {
		logger.Warn("role agent provisioning skipped: no provider/model configured", "role", role)
		return nil
	}
	if strings.TrimSpace(prompt.Text) == "" || prompt.Version == "" {
		return errors.New("role prompt is missing")
	}
	now := time.Now()
	recorded, err := store.Get(ctx, role)
	switch {
	case errors.Is(err, ErrNotFound):
		return spawnRole(ctx, store, provisioner, specs, spec, role, prompt, newID, now, logger)
	case err != nil:
		return err
	}
	detail, err := provisioner.GetAgent(ctx, recorded.OpenFangAgentID)
	if err != nil {
		if isMissingUpstream(err) {
			logger.Info("role agent missing upstream; spawning a new one", "role", role, "upstreamAgentId", recorded.OpenFangAgentID)
			return spawnRole(ctx, store, provisioner, specs, spec, role, prompt, newID, now, logger)
		}
		// A transport or auth failure is not proof of absence; spawning on
		// that assumption would duplicate the agent on every restart.
		_ = store.SetStatus(ctx, role, StatusOffline, now)
		return fmt.Errorf("probe role agent: %w", err)
	}
	if recorded.ManifestRevision != ManifestRevision {
		// The manifest shape changed since this agent was spawned (a limit,
		// the history cap). Limits cannot be patched, so the role is replaced:
		// the old agent goes first so a crash in between leaks nothing, and
		// the row keeps pointing at it until the new one is recorded.
		deleter, ok := provisioner.(openfang.AgentDeleter)
		if !ok {
			logger.Warn("role agent manifest is outdated and the runtime seam cannot delete; keeping it",
				"role", role, "recordedRevision", recorded.ManifestRevision, "wantRevision", ManifestRevision)
		} else {
			if err := deleter.DeleteAgent(ctx, recorded.OpenFangAgentID); err != nil && !isMissingUpstream(err) {
				_ = store.SetStatus(ctx, role, StatusOffline, now)
				return fmt.Errorf("replace role agent: %w", err)
			}
			logger.Info("role agent manifest outdated; re-spawning", "role", role,
				"recordedRevision", recorded.ManifestRevision, "wantRevision", ManifestRevision, "upstreamAgentId", recorded.OpenFangAgentID)
			return spawnRole(ctx, store, provisioner, specs, spec, role, prompt, newID, now, logger)
		}
	}
	if driftsFrom(detail, spec, prompt) {
		if patcher == nil {
			logger.Warn("role agent drifted and no patcher is configured", "role", role)
		} else {
			provider, model, system := strings.TrimSpace(spec.Provider), strings.TrimSpace(spec.Model), prompt.Text
			if err := patcher.PatchAgent(ctx, recorded.OpenFangAgentID, openfang.PatchAgentRequest{
				SystemPrompt: &system, Provider: &provider, Model: &model,
			}); err != nil {
				_ = store.SetStatus(ctx, role, StatusOffline, now)
				return fmt.Errorf("patch role agent: %w", err)
			}
			logger.Info("role agent updated in place", "role", role, "provider", provider, "model", model, "promptVersion", prompt.Version)
		}
	}
	updated := recorded
	updated.Provider = strings.TrimSpace(spec.Provider)
	updated.Model = strings.TrimSpace(spec.Model)
	updated.PromptVersion = prompt.Version
	updated.Status = StatusAvailable
	if detail.Limits != nil {
		if detail.Limits.MaxTokens != nil {
			updated.MaxTokens = detail.Limits.MaxTokens
		}
		if detail.Limits.MaxLLMTokensPerHour != nil {
			updated.MaxLLMTokensPerHour = detail.Limits.MaxLLMTokensPerHour
		}
	}
	if differs(updated.MaxTokens, int64(specs.MaxOutputTokens)) || differs(updated.MaxLLMTokensPerHour, specs.TokensPerHour) {
		logger.Warn(
			"role agent limits differ from configuration; re-spawn to change",
			"role", role, "maxTokens", deref(updated.MaxTokens), "wantMaxTokens", specs.MaxOutputTokens,
			"maxLLMTokensPerHour", deref(updated.MaxLLMTokensPerHour), "wantMaxLLMTokensPerHour", specs.TokensPerHour,
		)
	}
	return store.Upsert(ctx, updated, now)
}

func spawnRole(
	ctx context.Context,
	store Store,
	provisioner openfang.Provisioner,
	specs RoleSpecs,
	spec RoleSpec,
	role Role,
	prompt Prompt,
	newID func() uuid.UUID,
	now time.Time,
	logger *slog.Logger,
) error {
	// OpenFang enforces unique names across its flat agent list; a random
	// suffix keeps two Berry deployments sharing one runtime apart.
	name := fmt.Sprintf("berry-%s-%s", role, newID().String()[:8])
	manifest, err := Manifest(name, role, spec, prompt, specs.MaxOutputTokens, specs.TokensPerHour)
	if err != nil {
		return err
	}
	// POST /api/agents is an unsafe create with no idempotency key: the
	// absence check ran first, the spawn happens once, and the id is
	// recorded immediately. A crash in between leaks one upstream agent,
	// which is recoverable; skipping the check would duplicate every boot.
	spawned, err := provisioner.SpawnAgent(ctx, manifest)
	if err != nil {
		return fmt.Errorf("spawn role agent: %w", err)
	}
	maxTokens := int64(specs.MaxOutputTokens)
	tokensPerHour := specs.TokensPerHour
	agent := RoleAgent{
		Role: role, OpenFangAgentID: spawned.AgentID, UpstreamName: name,
		Provider: strings.TrimSpace(spec.Provider), Model: strings.TrimSpace(spec.Model), PromptVersion: prompt.Version,
		MaxTokens: &maxTokens, MaxLLMTokensPerHour: &tokensPerHour, ManifestRevision: ManifestRevision, Status: StatusAvailable,
	}
	if err := store.Upsert(ctx, agent, now); err != nil {
		return err
	}
	logger.Info("role agent provisioned", "role", role, "upstreamAgentId", spawned.AgentID, "name", name,
		"provider", agent.Provider, "model", agent.Model, "promptVersion", prompt.Version)
	return nil
}

// driftsFrom reports whether the upstream agent runs a different model or
// prompt than configured. Whitespace at the ends is not drift.
func driftsFrom(detail openfang.AgentDetail, spec RoleSpec, prompt Prompt) bool {
	if strings.TrimSpace(detail.Model.Provider) != strings.TrimSpace(spec.Provider) {
		return true
	}
	if strings.TrimSpace(detail.Model.Model) != strings.TrimSpace(spec.Model) {
		return true
	}
	return strings.TrimSpace(detail.SystemPrompt) != strings.TrimSpace(prompt.Text)
}

func differs(value *int64, want int64) bool {
	return value != nil && *value != want
}

func deref(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

// isMissingUpstream distinguishes "this agent does not exist" from every
// other failure. Only a definitive 404 authorises a spawn.
func isMissingUpstream(err error) bool {
	var upstream *openfang.UpstreamError
	if errors.As(err, &upstream) {
		return upstream.Kind == openfang.ErrorNotFound
	}
	return false
}

// ManifestRevision names the shape of the manifest this binary spawns. It is
// recorded on the role row; a role whose recorded revision differs is
// re-spawned, because the runtime neither reports manifest limits back nor
// lets them be patched. Bump it whenever Manifest's limits or keys change.
const ManifestRevision = "2026-08-26.2"

// RoleHistoryMessages caps the runtime session a role agent keeps between
// calls: one message, i.e. only the task it is answering.
const RoleHistoryMessages = 1

// Manifest builds the TOML the runtime expects for a role agent: a model,
// its output cap, the system prompt, an hourly budget, and no tools. Keys
// live where the bundled manifests put them ([model] max_tokens and
// system_prompt; [resources] max_llm_tokens_per_hour); [schedule] and
// [autonomous] are deliberately absent so the agent never acts unattended.
func Manifest(name string, role Role, spec RoleSpec, prompt Prompt, maxOutputTokens int, tokensPerHour int64) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", errors.New("role agent name is required")
	}
	if !spec.Configured() {
		return "", errors.New("role agent model is not configured")
	}
	if len(prompt.Text) > maxSystemPromptBytes {
		return "", fmt.Errorf("role prompt %s exceeds %d bytes", prompt.Version, maxSystemPromptBytes)
	}
	if maxOutputTokens <= 0 {
		maxOutputTokens = DefaultMaxOutputTokens
	}
	if tokensPerHour <= 0 {
		tokensPerHour = DefaultTokensPerHour
	}
	var builder strings.Builder
	builder.WriteString("name = \"")
	builder.WriteString(tomlEscape(strings.TrimSpace(name)))
	builder.WriteString("\"\n")
	builder.WriteString("description = \"Berry ")
	builder.WriteString(tomlEscape(string(role)))
	builder.WriteString(" model role. No tools.\"\n")
	// Top-level max_history_messages is the only placement the runtime
	// honours (verified on the pinned build: prompt tokens stay flat call
	// after call, while [model]/[memory]/[resources] placements keep growing).
	// A role answers one task per call and must never see its earlier
	// answers, which biased it toward repeating them verbatim.
	builder.WriteString("max_history_messages = ")
	builder.WriteString(strconv.Itoa(RoleHistoryMessages))
	builder.WriteString("\n")
	builder.WriteString("[model]\n")
	builder.WriteString("provider = \"")
	builder.WriteString(tomlEscape(strings.TrimSpace(spec.Provider)))
	builder.WriteString("\"\n")
	builder.WriteString("model = \"")
	builder.WriteString(tomlEscape(strings.TrimSpace(spec.Model)))
	builder.WriteString("\"\n")
	builder.WriteString("max_tokens = ")
	builder.WriteString(strconv.Itoa(maxOutputTokens))
	builder.WriteString("\n")
	builder.WriteString("system_prompt = \"")
	builder.WriteString(tomlEscape(prompt.Text))
	builder.WriteString("\"\n")
	builder.WriteString("[resources]\n")
	builder.WriteString("max_llm_tokens_per_hour = ")
	builder.WriteString(strconv.FormatInt(tokensPerHour, 10))
	builder.WriteString("\n")
	return builder.String(), nil
}

func tomlEscape(value string) string {
	replacer := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"\n", `\n`,
		"\r", `\r`,
		"\t", `\t`,
	)
	return replacer.Replace(value)
}
