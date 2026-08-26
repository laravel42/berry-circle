package automationruns

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/orchestration"
	"github.com/laravel42/berry-circle/server/internal/orchestration/orchestrationtest"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// The run stream replays ledger frames in the workflow envelope and closes
// on the terminal event; the list refuses an unknown status before reading.
func TestRunStreamReplaysLedgerAndClosesOnTerminalEvent(t *testing.T) {
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	runID, automationID, workspaceID := uuid.New(), uuid.New(), uuid.New()
	stepID := "notify"
	store := &fakeStore{
		run: automationrepo.Run{ID: runID, AutomationID: automationID, WorkspaceID: workspaceID, Status: automationrepo.RunSucceeded, CreatedAt: now},
		events: []automationrepo.RunEvent{
			{ID: uuid.New(), Type: "workflow.run.started", OccurredAt: now, WorkspaceID: workspaceID, AutomationID: automationID, RunID: runID, Sequence: 0, Payload: json.RawMessage(`{}`)},
			{ID: uuid.New(), Type: "workflow.step.succeeded", OccurredAt: now, WorkspaceID: workspaceID, AutomationID: automationID, RunID: runID, StepID: &stepID, Sequence: 1, Payload: json.RawMessage(`{}`)},
			{ID: uuid.New(), Type: "workflow.run.succeeded", OccurredAt: now, WorkspaceID: workspaceID, AutomationID: automationID, RunID: runID, Sequence: 2, Payload: json.RawMessage(`{}`)},
		},
	}
	mount, err := NewMount(Options{Store: store, Sessions: sessions{}, Authorization: fakeAuthorizer{}, Clock: func() time.Time { return now }, NewID: uuid.New,
		Heartbeat: 10 * time.Millisecond, PollInterval: time.Millisecond})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/"+runID.String()+"/events", nil)
	request.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	response := httptest.NewRecorder()
	mount.Handler.ServeHTTP(response, request)
	body := response.Body.String()
	if response.Code != http.StatusOK || !strings.HasPrefix(body, "retry: 3000\n\n") ||
		strings.Count(body, "event: workflow.") != 3 || !strings.Contains(body, `"stepId":"notify"`) ||
		!strings.Contains(body, `"workflowRunId":"`+runID.String()+`"`) || !strings.Contains(body, `"sequence":2`) {
		t.Fatalf("stream = %d %q", response.Code, body)
	}
	request = httptest.NewRequest(http.MethodGet, "/?workspaceId="+workspaceID.String()+"&status=exploded", nil)
	request.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	response = httptest.NewRecorder()
	mount.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("bad status filter = %d", response.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "/"+runID.String(), nil)
	request.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	response = httptest.NewRecorder()
	mount.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"workflowId":"`+automationID.String()+`"`) || !strings.Contains(response.Body.String(), `"steps":[]`) {
		t.Fatalf("detail = %d %s", response.Code, response.Body.String())
	}
}

type fakeStore struct {
	run       automationrepo.Run
	events    []automationrepo.RunEvent
	cancelled []uuid.UUID
}

func (store *fakeStore) ListRuns(context.Context, automationrepo.RunListFilter, *automationrepo.RunCursor, int) ([]automationrepo.Run, error) {
	return []automationrepo.Run{store.run}, nil
}
func (store *fakeStore) GetRun(context.Context, uuid.UUID) (automationrepo.Run, error) {
	return store.run, nil
}
func (store *fakeStore) GetRunWithSteps(context.Context, uuid.UUID) (automationrepo.Run, []automationrepo.StepRun, error) {
	return store.run, []automationrepo.StepRun{}, nil
}
func (store *fakeStore) Cancel(_ context.Context, runID uuid.UUID, _ *uuid.UUID, now time.Time, _ func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error) {
	if store.run.Status.Terminal() {
		return automationrepo.Run{}, automationrepo.Event{}, automationrepo.ErrRunTerminal
	}
	store.cancelled = append(store.cancelled, runID)
	run := store.run
	run.Status = automationrepo.RunCancelled
	run.CompletedAt = &now
	return run, automationrepo.Event{ID: uuid.New(), Type: "workflow.run.cancelled", WorkspaceID: run.WorkspaceID, OccurredAt: now}, nil
}

type fakeCanceller struct {
	cancelled []uuid.UUID
}

func (canceller *fakeCanceller) Cancel(_ context.Context, runID uuid.UUID) error {
	canceller.cancelled = append(canceller.cancelled, runID)
	return nil
}
func (store *fakeStore) ResolveRunCursor(context.Context, uuid.UUID, uuid.UUID, time.Time) (int64, error) {
	return 0, nil
}
func (store *fakeStore) ListRunEvents(_ context.Context, _ uuid.UUID, after int64, _ time.Time, _ int) ([]automationrepo.RunEvent, error) {
	var out []automationrepo.RunEvent
	for _, event := range store.events {
		if event.Sequence > after {
			out = append(out, event)
		}
	}
	return out, nil
}

type fakeAuthorizer struct{}

func (fakeAuthorizer) AuthorizeWorkspace(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Role, error) {
	return identity.RoleMember, nil
}
func (fakeAuthorizer) AuthorizeAutomationRun(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: identity.RoleMember}, nil
}

type sessions struct{}

func (sessions) ResolveSession(context.Context, string) (auth.User, error) {
	return auth.User{ID: uuid.New(), Role: auth.RoleMember}, nil
}

// Cancelling a run cancels the row, then tells the executor to stop waiting:
// the in-process canceller records the id; the Temporal starter signals an
// orchestration that, having already finished, is not there — which is not
// an error, because the row is what was cancelled.
func TestCancelSignalsTheExecutorAfterTheRow(t *testing.T) {
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	for _, mode := range []string{"in-process", "temporal"} {
		t.Run(mode, func(t *testing.T) {
			runID := uuid.New()
			store := &fakeStore{run: automationrepo.Run{ID: runID, AutomationID: uuid.New(), WorkspaceID: uuid.New(), Status: automationrepo.RunWaiting, CreatedAt: now}}
			recorder := &fakeCanceller{}
			var canceller automationrun.Canceller = recorder
			if mode == "temporal" {
				client := orchestrationtest.NewClient(&orchestration.Activities{})
				t.Cleanup(client.Close)
				starter, err := orchestration.NewAutomationStarter(client, "berry-runs")
				if err != nil {
					t.Fatalf("NewAutomationStarter() error = %v", err)
				}
				canceller = starter
			}
			mount, err := NewMount(Options{Store: store, Sessions: sessions{}, Authorization: fakeAuthorizer{}, Clock: func() time.Time { return now }, NewID: uuid.New, Canceller: canceller})
			if err != nil {
				t.Fatalf("NewMount() error = %v", err)
			}
			request := httptest.NewRequest(http.MethodPost, "/"+runID.String()+"/cancel", nil)
			request.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
			response := httptest.NewRecorder()
			mount.Handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"cancelled"`) || len(store.cancelled) != 1 {
				t.Fatalf("cancel = %d %s (rows %v)", response.Code, response.Body.String(), store.cancelled)
			}
			if mode == "in-process" && (len(recorder.cancelled) != 1 || recorder.cancelled[0] != runID) {
				t.Fatalf("canceller = %v, want %s", recorder.cancelled, runID)
			}
			store.run.Status = automationrepo.RunCancelled
			response = httptest.NewRecorder()
			mount.Handler.ServeHTTP(response, request)
			if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "RUN_TERMINAL") {
				t.Fatalf("second cancel = %d %s", response.Code, response.Body.String())
			}
		})
	}
}
