package core

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

type stubGrants struct {
	grants []Grant
	err    error
	// calls records the workspace each lookup was made for, so a test can prove
	// the store is never asked about a workspace other than the caller's.
	calls []uuid.UUID
}

func (stub *stubGrants) GrantsFor(
	_ context.Context, workspaceID uuid.UUID, agentID *uuid.UUID, provider string,
) ([]Grant, error) {
	stub.calls = append(stub.calls, workspaceID)
	if stub.err != nil {
		return nil, stub.err
	}
	var out []Grant
	for _, grant := range stub.grants {
		if grant.WorkspaceID == workspaceID && grant.Provider == provider {
			out = append(out, grant)
		}
	}
	_ = agentID
	return out, nil
}

type stubConnections struct {
	byWorkspace map[uuid.UUID]Connection
}

func (stub stubConnections) Connection(
	_ context.Context, workspaceID uuid.UUID, provider string,
) (Connection, error) {
	connection, ok := stub.byWorkspace[workspaceID]
	if !ok || connection.Provider != provider {
		return Connection{}, ErrNoConnection
	}
	return connection, nil
}

func readTool() Tool {
	return Tool{Name: "github.get_issue", Provider: "github", Effect: EffectRead}
}

func sendTool() Tool {
	return Tool{
		Name: "gmail.send_message", Provider: "gmail",
		Effect: EffectExternalSideEffect, RequiresApproval: true,
	}
}

func connected(provider string) Connection {
	return Connection{Provider: provider, Status: StatusConnected}
}

func TestAGrantPermitsAToolAtOrBelowItsEffect(t *testing.T) {
	workspace := uuid.New()
	authorizer := PermissionAuthorizer{
		Grants: &stubGrants{grants: []Grant{
			{WorkspaceID: workspace, Provider: "github", Tool: "github.get_issue", MaxEffect: EffectRead},
		}},
		Connections: stubConnections{byWorkspace: map[uuid.UUID]Connection{
			workspace: connected("github"),
		}},
	}
	decision, err := authorizer.Authorize(
		context.Background(), ExecutionContext{WorkspaceID: workspace}, readTool())
	if err != nil {
		t.Fatalf("Authorize: %v", err)
	}
	if !decision.Allowed {
		t.Errorf("read tool with a read grant was refused: %s", decision.Reason)
	}
}

// The central guarantee: a read grant cannot execute a write.
func TestAGrantCannotBeEscalated(t *testing.T) {
	workspace := uuid.New()
	authorizer := PermissionAuthorizer{
		Grants: &stubGrants{grants: []Grant{
			{WorkspaceID: workspace, Provider: "github", Tool: Wildcard, MaxEffect: EffectRead},
		}},
		Connections: stubConnections{byWorkspace: map[uuid.UUID]Connection{
			workspace: connected("github"),
		}},
	}
	write := Tool{Name: "github.create_issue", Provider: "github", Effect: EffectWrite}
	decision, err := authorizer.Authorize(
		context.Background(), ExecutionContext{WorkspaceID: workspace}, write)
	if err != nil {
		t.Fatalf("Authorize: %v", err)
	}
	if decision.Allowed {
		t.Error("a read-only wildcard grant executed a write tool")
	}
}

// An agent must not reach a provider connected by a different workspace.
func TestAnAgentCannotUseAnotherWorkspacesConnection(t *testing.T) {
	mine, theirs := uuid.New(), uuid.New()
	grants := &stubGrants{grants: []Grant{
		// A grant exists, but in the other workspace.
		{WorkspaceID: theirs, Provider: "github", Tool: Wildcard, MaxEffect: EffectWrite},
	}}
	authorizer := PermissionAuthorizer{
		Grants: grants,
		Connections: stubConnections{byWorkspace: map[uuid.UUID]Connection{
			theirs: connected("github"),
		}},
	}
	decision, err := authorizer.Authorize(
		context.Background(), ExecutionContext{WorkspaceID: mine}, readTool())
	if err != nil {
		t.Fatalf("Authorize: %v", err)
	}
	if decision.Allowed {
		t.Error("a workspace with no connection was allowed to call the provider")
	}
	for _, asked := range grants.calls {
		if asked == theirs {
			t.Error("the grant store was queried for another workspace")
		}
	}
}

// A grant naming a different agent is not this agent's to use.
func TestAGrantForAnotherAgentDoesNotApply(t *testing.T) {
	workspace, mine, other := uuid.New(), uuid.New(), uuid.New()
	authorizer := PermissionAuthorizer{
		Grants: &stubGrants{grants: []Grant{
			{WorkspaceID: workspace, AgentID: &other, Provider: "github", Tool: Wildcard, MaxEffect: EffectWrite},
		}},
		Connections: stubConnections{byWorkspace: map[uuid.UUID]Connection{
			workspace: connected("github"),
		}},
	}
	decision, err := authorizer.Authorize(
		context.Background(),
		ExecutionContext{WorkspaceID: workspace, AgentID: &mine},
		readTool(),
	)
	if err != nil {
		t.Fatalf("Authorize: %v", err)
	}
	if decision.Allowed {
		t.Error("one agent used a grant issued to another")
	}
}

func TestAnUnusableConnectionRefuses(t *testing.T) {
	workspace := uuid.New()
	for _, status := range []ConnectionStatus{
		StatusExpired, StatusRevoked, StatusError, StatusDisconnected,
	} {
		authorizer := PermissionAuthorizer{
			Grants: &stubGrants{grants: []Grant{
				{WorkspaceID: workspace, Provider: "github", Tool: Wildcard, MaxEffect: EffectDestructive},
			}},
			Connections: stubConnections{byWorkspace: map[uuid.UUID]Connection{
				workspace: {Provider: "github", Status: status},
			}},
		}
		decision, err := authorizer.Authorize(
			context.Background(), ExecutionContext{WorkspaceID: workspace}, readTool())
		if err != nil {
			t.Fatalf("Authorize(%s): %v", status, err)
		}
		if decision.Allowed {
			t.Errorf("a %s connection was used", status)
		}
	}
}

// Absence denies: adding a provider must not silently widen existing agents.
func TestNoGrantMeansNoAccess(t *testing.T) {
	workspace := uuid.New()
	authorizer := PermissionAuthorizer{
		Grants: &stubGrants{},
		Connections: stubConnections{byWorkspace: map[uuid.UUID]Connection{
			workspace: connected("github"),
		}},
	}
	decision, err := authorizer.Authorize(
		context.Background(), ExecutionContext{WorkspaceID: workspace}, readTool())
	if err != nil {
		t.Fatalf("Authorize: %v", err)
	}
	if decision.Allowed {
		t.Error("a tool with no grant was allowed")
	}
	if decision.Reason == "" {
		t.Error("a refusal must carry a reason for the audit row")
	}
}

// Approval survives the grant: a wildcard destructive grant does not waive it.
func TestApprovalIsNotWaivedByAGenerousGrant(t *testing.T) {
	workspace := uuid.New()
	authorizer := PermissionAuthorizer{
		Grants: &stubGrants{grants: []Grant{
			{WorkspaceID: workspace, Provider: "gmail", Tool: Wildcard, MaxEffect: EffectDestructive},
		}},
		Connections: stubConnections{byWorkspace: map[uuid.UUID]Connection{
			workspace: connected("gmail"),
		}},
	}
	decision, err := authorizer.Authorize(
		context.Background(), ExecutionContext{WorkspaceID: workspace}, sendTool())
	if err != nil {
		t.Fatalf("Authorize: %v", err)
	}
	if !decision.Allowed {
		t.Fatalf("send was refused outright: %s", decision.Reason)
	}
	if !decision.RequiresApproval {
		t.Error("sending mail was allowed without approval")
	}
}

func TestEffectOrdering(t *testing.T) {
	for _, testCase := range []struct {
		effect, limit Effect
		want          bool
	}{
		{EffectRead, EffectRead, true},
		{EffectWrite, EffectRead, false},
		{EffectRead, EffectDestructive, true},
		{EffectExternalSideEffect, EffectWrite, false},
		{EffectDestructive, EffectExternalSideEffect, false},
		{EffectDestructive, EffectDestructive, true},
		// An unclassified effect is never permitted, even by the widest grant.
		{Effect("nonsense"), EffectDestructive, false},
		{EffectRead, Effect("nonsense"), false},
	} {
		if got := testCase.effect.AtMost(testCase.limit); got != testCase.want {
			t.Errorf("%s.AtMost(%s) = %v, want %v",
				testCase.effect, testCase.limit, got, testCase.want)
		}
	}
}
