package hooks

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/orchestration"
	"github.com/laravel42/berry-circle/server/internal/orchestration/orchestrationtest"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

const goodToken = "c2VjcmV0LXRva2VuLWZvci10ZXN0cy1vbmx5"

type fakeStore struct {
	mu         sync.Mutex
	item       automationrepo.Automation
	runs       []automationrepo.CreateRunParams
	deliveries []string
}

func (store *fakeStore) WebhookSecretMatches(_ context.Context, id uuid.UUID, token string) (automationrepo.Automation, bool, error) {
	if id != store.item.ID || token != goodToken {
		return automationrepo.Automation{}, false, nil
	}
	return store.item, true, nil
}

func (store *fakeStore) CreateRun(_ context.Context, params automationrepo.CreateRunParams) (automationrepo.Run, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.item.Status != automationrepo.StatusActive {
		return automationrepo.Run{}, false, automationrepo.ErrNotActive
	}
	for _, existing := range store.runs {
		if existing.SourceEventKey != nil && params.SourceEventKey != nil && *existing.SourceEventKey == *params.SourceEventKey {
			return automationrepo.Run{ID: existing.ID, Status: automationrepo.RunPending}, false, nil
		}
	}
	store.runs = append(store.runs, params)
	return automationrepo.Run{ID: params.ID, WorkspaceID: store.item.WorkspaceID, AutomationID: params.AutomationID, Status: automationrepo.RunPending, TriggerType: params.TriggerType, TriggerPayload: params.Payload}, true, nil
}

func (store *fakeStore) RecordHookDelivery(_ context.Context, _ uuid.UUID, _ uuid.UUID, deliveryID string, _ time.Time) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.deliveries = append(store.deliveries, deliveryID)
	return true, nil
}

type fakeStarter struct {
	mu      sync.Mutex
	started []uuid.UUID
}

func (starter *fakeStarter) Start(_ context.Context, runID uuid.UUID) error {
	starter.mu.Lock()
	defer starter.mu.Unlock()
	starter.started = append(starter.started, runID)
	return nil
}

func (starter *fakeStarter) Resume(context.Context, uuid.UUID, automationrun.ResumeSignal) error {
	return nil
}

func newStore() *fakeStore {
	creator := uuid.New()
	return &fakeStore{item: automationrepo.Automation{
		ID: uuid.New(), WorkspaceID: uuid.New(), Status: automationrepo.StatusActive, HasWebhookSecret: true, CreatedBy: &creator,
		Trigger: automationrepo.Trigger{Type: automation.TriggerWebhook},
	}}
}

func newMount(t *testing.T, store *fakeStore, starter automationrun.Starter, now time.Time) http.Handler {
	t.Helper()
	mount, err := NewMount(Options{Store: store, Starter: starter, Clock: func() time.Time { return now }, NewID: uuid.New})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	if mount.Prefix != "/api/v1/hooks" {
		t.Fatalf("prefix = %s", mount.Prefix)
	}
	return mount.Handler
}

func deliver(handler http.Handler, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

// The mount has no session: a bad token is a 404, never a 401, and so is a
// paused workflow or a malformed id.
func TestHooksRefuseWithoutRevealingAnything(t *testing.T) {
	store := newStore()
	mount := newMount(t, store, &fakeStarter{}, time.Now())
	base := "/workflows/" + store.item.ID.String()
	for name, path := range map[string]string{
		"wrong token":    base + "/" + strings.Repeat("x", 32),
		"short token":    base + "/abc",
		"unknown id":     "/workflows/" + uuid.NewString() + "/" + goodToken,
		"malformed id":   "/workflows/not-a-uuid/" + goodToken,
		"uppercase uuid": "/workflows/" + strings.ToUpper(store.item.ID.String()) + "/" + goodToken,
	} {
		if response := deliver(mount, path, `{}`, nil); response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "NOT_FOUND") {
			t.Fatalf("%s = %d %s", name, response.Code, response.Body.String())
		}
	}
	store.item.Status = automationrepo.StatusPaused
	if response := deliver(mount, base+"/"+goodToken, `{}`, nil); response.Code != http.StatusNotFound {
		t.Fatalf("paused = %d", response.Code)
	}
	if len(store.runs) != 0 {
		t.Fatalf("runs created by refused deliveries: %+v", store.runs)
	}
}

// A matching token creates a webhook run whose trigger scope carries the
// body as input, the query and the delivery id; the run is started — on the
// in-process pool, or through the real Temporal starter over the test
// suite — and a redelivery answers 200 with the run it already created.
func TestHooksCreateAndStartRuns(t *testing.T) {
	for _, mode := range []string{"in-process", "temporal"} {
		t.Run(mode, func(t *testing.T) {
			store := newStore()
			recorder := &fakeStarter{}
			runner := orchestrationtest.NewRunner()
			var (
				starter automationrun.Starter = recorder
				client  *orchestrationtest.Client
			)
			if mode == "temporal" {
				client = orchestrationtest.NewClient(&orchestration.Activities{Automations: runner, AutomationRuns: runner})
				t.Cleanup(client.Close)
				temporal, err := orchestration.NewAutomationStarter(client, "berry-runs")
				if err != nil {
					t.Fatalf("NewAutomationStarter() error = %v", err)
				}
				starter = temporal
			}
			now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
			mount := newMount(t, store, starter, now)
			path := "/workflows/" + store.item.ID.String() + "/" + goodToken + "?source=stripe"
			response := deliver(mount, path, `{"amount": 1200}`, map[string]string{"X-Berry-Delivery-Id": "evt_1"})
			if response.Code != http.StatusAccepted || len(store.runs) != 1 {
				t.Fatalf("delivery = %d %s (runs %d)", response.Code, response.Body.String(), len(store.runs))
			}
			run := store.runs[0]
			var body map[string]string
			_ = json.Unmarshal(response.Body.Bytes(), &body)
			if body["runId"] != run.ID.String() || response.Header().Get("Location") != "/api/v1/workflow-runs/"+run.ID.String() {
				t.Fatalf("response = %s %s", response.Header().Get("Location"), response.Body.String())
			}
			var trigger map[string]any
			_ = json.Unmarshal(run.Payload, &trigger)
			if run.TriggerType != automation.TriggerWebhook || run.SourceEventKey == nil || *run.SourceEventKey != "hook:evt_1" ||
				run.RequestedBy == nil || *run.RequestedBy != *store.item.CreatedBy ||
				trigger["input"].(map[string]any)["amount"] != float64(1200) || trigger["query"].(map[string]any)["source"] != "stripe" ||
				trigger["deliveryId"] != "evt_1" || trigger["contentType"] != "application/json" {
				t.Fatalf("run = %+v payload %s", run, run.Payload)
			}
			if store.deliveries[0] != "evt_1" {
				t.Fatalf("deliveries = %v", store.deliveries)
			}
			if mode == "temporal" {
				if executed := runner.Executed(); len(executed) != 1 || executed[0] != run.ID || client.Starts() != 1 {
					t.Fatalf("temporal executed = %v, starts = %d", executed, client.Starts())
				}
			} else if len(recorder.started) != 1 || recorder.started[0] != run.ID {
				t.Fatalf("started = %v", recorder.started)
			}
			again := deliver(mount, path, `{"amount": 1200}`, map[string]string{"X-Berry-Delivery-Id": "evt_1"})
			if again.Code != http.StatusOK || !strings.Contains(again.Body.String(), run.ID.String()) || len(store.runs) != 1 {
				t.Fatalf("redelivery = %d %s (runs %d)", again.Code, again.Body.String(), len(store.runs))
			}
			if mode == "in-process" && len(recorder.started) != 1 {
				t.Fatalf("redelivery started a run again: %v", recorder.started)
			}
			// No delivery id, no body: a fresh run with a null input.
			bare := deliver(mount, "/workflows/"+store.item.ID.String()+"/"+goodToken, "", nil)
			if bare.Code != http.StatusAccepted || len(store.runs) != 2 || !strings.Contains(string(store.runs[1].Payload), `"input":null`) || store.runs[1].SourceEventKey != nil {
				t.Fatalf("bare delivery = %d %s payload %s", bare.Code, bare.Body.String(), store.runs[1].Payload)
			}
		})
	}
}

// Bodies are bounded and must be JSON; the delivery id is bounded; and a
// workflow receives at most sixty deliveries a minute.
func TestHooksBoundTheirInput(t *testing.T) {
	store := newStore()
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	clock := &now
	mount, err := NewMount(Options{Store: store, Starter: &fakeStarter{}, Clock: func() time.Time { return *clock }, NewID: uuid.New,
		Limiter: httpapi.NewMemoryRateLimiter(func() time.Time { return *clock })})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	path := "/workflows/" + store.item.ID.String() + "/" + goodToken
	if response := deliver(mount.Handler, path, `{"broken":`, nil); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "INVALID_BODY") {
		t.Fatalf("invalid json = %d %s", response.Code, response.Body.String())
	}
	if response := deliver(mount.Handler, path, `{"big":"`+strings.Repeat("x", maxBody)+`"}`, nil); response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized = %d %s", response.Code, response.Body.String())
	}
	if response := deliver(mount.Handler, path, `{}`, map[string]string{"X-Berry-Delivery-Id": strings.Repeat("d", automationrepo.MaxHookDeliveryIDLength+1)}); response.Code != http.StatusBadRequest {
		t.Fatalf("long delivery id = %d %s", response.Code, response.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("refused deliveries created runs: %d", len(store.runs))
	}
	// Three refusals already spent budget; the window is per workflow.
	for index := range DeliveriesPerMinute - 3 {
		if response := deliver(mount.Handler, path, `{}`, nil); response.Code != http.StatusAccepted {
			t.Fatalf("delivery %d = %d %s", index, response.Code, response.Body.String())
		}
	}
	limited := deliver(mount.Handler, path, `{}`, nil)
	if limited.Code != http.StatusTooManyRequests || !strings.Contains(limited.Body.String(), "RATE_LIMITED") || limited.Header().Get("Retry-After") == "" {
		t.Fatalf("over budget = %d %s retry-after %q", limited.Code, limited.Body.String(), limited.Header().Get("Retry-After"))
	}
	*clock = now.Add(2 * time.Minute)
	if response := deliver(mount.Handler, path, `{}`, nil); response.Code != http.StatusAccepted {
		t.Fatalf("next window = %d %s", response.Code, response.Body.String())
	}
}
