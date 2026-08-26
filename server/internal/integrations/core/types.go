// Package core is Berry's provider-independent integration layer.
//
// Agents never touch a provider SDK. They reach a provider through the runtime's
// MCP servers, and Berry decides — per workspace, per agent, per tool — whether
// that is allowed, supplies the credential, and records what happened. This
// package holds the vocabulary all of that is expressed in, so nothing outside
// it needs a provider-specific branch.
//
// The same shape admits a future Composio adapter: it would register like any
// other Provider and agents would not change.
package core

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Effect classifies what calling a tool does in the outside world.
//
// Ordered deliberately: a grant carries the strongest effect it permits, and a
// tool is refused when its effect exceeds that, so comparison is what enforces
// "read-only means read-only".
type Effect string

const (
	// EffectRead observes and changes nothing.
	EffectRead Effect = "read"
	// EffectWrite changes state inside the provider, reversibly.
	EffectWrite Effect = "write"
	// EffectExternalSideEffect reaches people outside Berry — a posted message,
	// a sent email. Not undoable by deleting a record.
	EffectExternalSideEffect Effect = "external_side_effect"
	// EffectDestructive removes or irreversibly alters something.
	EffectDestructive Effect = "destructive"
)

var effectRank = map[Effect]int{
	EffectRead:               0,
	EffectWrite:              1,
	EffectExternalSideEffect: 2,
	EffectDestructive:        3,
}

// Valid reports whether the effect is one this package defines.
func (effect Effect) Valid() bool {
	_, ok := effectRank[effect]
	return ok
}

// AtMost reports whether this effect is permitted by a grant of `limit`.
// An unknown effect is never permitted: a tool that fails to classify itself
// must not inherit the weakest rule.
func (effect Effect) AtMost(limit Effect) bool {
	own, ok := effectRank[effect]
	if !ok {
		return false
	}
	allowed, ok := effectRank[limit]
	if !ok {
		return false
	}
	return own <= allowed
}

// ConnectionStatus is the lifecycle of a workspace's link to a provider.
type ConnectionStatus string

const (
	StatusConnected    ConnectionStatus = "connected"
	StatusExpired      ConnectionStatus = "expired"
	StatusRevoked      ConnectionStatus = "revoked"
	StatusError        ConnectionStatus = "error"
	StatusDisconnected ConnectionStatus = "disconnected"
)

// Usable reports whether a call may be attempted on this connection.
func (status ConnectionStatus) Usable() bool {
	return status == StatusConnected
}

// Connection is a workspace's authorised link to one provider.
//
// It deliberately carries no token. Credentials live sealed in the repository
// and are opened only at the moment of use, so a Connection can be logged,
// serialised or returned to a caller without leaking one.
type Connection struct {
	ID                  uuid.UUID
	WorkspaceID         uuid.UUID
	Provider            string
	ConnectedByUserID   *uuid.UUID
	ExternalAccountID   string
	ExternalAccountName string
	ExpiresAt           *time.Time
	Scopes              []string
	Metadata            map[string]any
	Status              ConnectionStatus
	StatusDetail        string
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// NeedsRefresh reports whether the access token should be renewed before use.
// The margin means a token is not handed to a provider seconds before it dies.
func (connection Connection) NeedsRefresh(now time.Time, margin time.Duration) bool {
	if connection.ExpiresAt == nil {
		return false
	}
	return !connection.ExpiresAt.After(now.Add(margin))
}

// ToolKind distinguishes what a tool is used for inside a workflow: a trigger
// starts a run when the provider reports something, an action is called by a
// step. The registry rejects any other value.
type ToolKind string

const (
	// ToolAction is a callable operation; the default when a tool says nothing.
	ToolAction ToolKind = "action"
	// ToolTrigger is an event source a workflow trigger may subscribe to.
	ToolTrigger ToolKind = "trigger"
)

// Valid reports whether the kind is one this package defines. Empty is valid
// and reads as action so providers written before kinds existed still register.
func (kind ToolKind) Valid() bool {
	return kind == "" || kind == ToolAction || kind == ToolTrigger
}

// Normalized maps the empty kind to action.
func (kind ToolKind) Normalized() ToolKind {
	if kind == "" {
		return ToolAction
	}
	return kind
}

// Tool is one agent-callable operation on a provider.
type Tool struct {
	// Name is provider-prefixed and stable: "github.create_pull_request".
	Name string
	// Description is what an agent reads to choose the tool.
	Description string
	// InputSchema and OutputSchema are JSON Schema documents.
	InputSchema  map[string]any
	OutputSchema map[string]any
	// Effect classifies the call. Required: a tool with an invalid effect is
	// rejected at registration rather than defaulting to read.
	Effect Effect
	// RequiresApproval forces a human decision before the call, regardless of
	// the granting permission. Sending mail is the motivating case.
	RequiresApproval bool
	// EnabledByDefault is false for anything a workspace should opt into.
	// Destructive tools are never enabled by default.
	EnabledByDefault bool
	// Provider owns the tool.
	Provider string
	// Kind says whether a workflow uses the tool as a trigger or an action.
	// Empty reads as action.
	Kind ToolKind
	// ConnectionRequired is true when the tool runs through a workspace
	// connection to the provider and false for providers Berry executes
	// itself, which is what lets a workflow over Berry's own tools validate
	// and activate with nothing connected.
	ConnectionRequired bool
}

// Operation is the part of the name after the provider prefix, which is how a
// workflow definition refers to the tool.
func (tool Tool) Operation() string {
	_, operation, _ := strings.Cut(tool.Name, ".")
	return operation
}

// Provider is one integration Berry can offer.
//
// Deliberately narrow: it describes and authorises, and does not execute.
// Execution happens in the runtime's MCP server for the provider, which is why
// there is no Execute here — adding one would invite a second, divergent path
// to the same provider.
type Provider interface {
	// ID is the stable identifier used in tool names, routes and the database.
	ID() string
	// Name is what a person reads in settings.
	Name() string
	// Description is one line for the settings card.
	Description() string
	// Tools are every operation this provider offers, whether or not a given
	// workspace has granted them.
	Tools() []Tool
	// Scopes are the OAuth scopes to request.
	Scopes() []string
	// MCPServer describes how the runtime should reach this provider for a
	// connection. Berry supplies the credential; it never proxies the calls.
	MCPServer(credential string) MCPServerConfig
}

// MCPServerConfig is what Berry writes into an agent's runtime manifest so the
// agent gains the provider's tools.
//
// The credential travels in Env rather than Args because a process argument is
// visible to anything that can list processes, while an environment variable is
// at least confined to the child.
type MCPServerConfig struct {
	Name      string
	Transport string
	Command   string
	Args      []string
	Env       map[string]string
	URL       string
	Headers   map[string]string
}

// ExecutionContext is who is asking, and on whose behalf.
type ExecutionContext struct {
	WorkspaceID uuid.UUID
	AgentID     *uuid.UUID
	UserID      *uuid.UUID
	RunID       *uuid.UUID
}

// Authorizer decides whether a call may proceed.
type Authorizer interface {
	Authorize(ctx context.Context, exec ExecutionContext, tool Tool) (Decision, error)
}

// Decision is the outcome of an authorisation check.
type Decision struct {
	Allowed          bool
	RequiresApproval bool
	// Reason is safe to show a person and to write to an audit row. It explains
	// a refusal without naming what a caller would need to change to bypass it.
	Reason string
}
