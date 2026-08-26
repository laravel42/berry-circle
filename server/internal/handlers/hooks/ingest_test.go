package hooks

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

type fakeResolver struct {
	accounts  map[string]uuid.UUID // provider + ":" + account
	repos     map[int64]uuid.UUID
	connected map[uuid.UUID][]string
}

func (resolver fakeResolver) WorkspaceForAccount(_ context.Context, provider, account string) (uuid.UUID, error) {
	if id, ok := resolver.accounts[provider+":"+account]; ok {
		return id, nil
	}
	return uuid.Nil, ErrNoWorkspace
}

func (resolver fakeResolver) WorkspaceForGitHubRepository(_ context.Context, repositoryID int64) (uuid.UUID, error) {
	if id, ok := resolver.repos[repositoryID]; ok {
		return id, nil
	}
	return uuid.Nil, ErrNoWorkspace
}

func (resolver fakeResolver) WorkspaceConnected(_ context.Context, workspaceID uuid.UUID, provider string) (bool, error) {
	for _, connected := range resolver.connected[workspaceID] {
		if connected == provider {
			return true, nil
		}
	}
	return false, nil
}

type fakeIngestor struct {
	mu       sync.Mutex
	ingested []automationrepo.IngestParams
	seen     map[string]bool
}

func (ingestor *fakeIngestor) IngestWebhook(_ context.Context, params automationrepo.IngestParams) (automationrepo.Event, bool, error) {
	ingestor.mu.Lock()
	defer ingestor.mu.Unlock()
	if ingestor.seen == nil {
		ingestor.seen = map[string]bool{}
	}
	key := params.Provider + ":" + params.DeliveryID
	if ingestor.seen[key] {
		return automationrepo.Event{}, false, nil
	}
	ingestor.seen[key] = true
	ingestor.ingested = append(ingestor.ingested, params)
	return automationrepo.Event{ID: uuid.New(), Type: automationrepo.WebhookReceivedTopic, WorkspaceID: params.WorkspaceID}, true, nil
}

const (
	githubSecret = "gh-secret"
	slackSecret  = "slack-secret"
	linearSecret = "linear-secret"
)

func hexHMAC(secret string, parts ...string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	for _, part := range parts {
		mac.Write([]byte(part))
	}
	return hex.EncodeToString(mac.Sum(nil))
}

func ingestMount(t *testing.T, now time.Time, secrets IngestSecrets, resolver WorkspaceResolver, ingestor Ingestor) http.Handler {
	t.Helper()
	mount, err := NewMount(Options{
		Store: newStore(), Starter: &fakeStarter{}, Clock: func() time.Time { return now }, NewID: uuid.New,
		Secrets: secrets, Resolver: resolver, Ingestor: ingestor,
	})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	return mount.Handler
}

// GitHub: the signature is checked over the raw body with the deployment
// secret; the delivery id deduplicates; the repository routes the delivery
// to the project's workspace; the fact names provider, event and payload.
func TestGitHubIngestVerifiesRoutesAndDeduplicates(t *testing.T) {
	now := time.Date(2026, time.August, 26, 9, 0, 0, 0, time.UTC)
	workspaceID, other := uuid.New(), uuid.New()
	ingestor := &fakeIngestor{}
	mount := ingestMount(t, now, IngestSecrets{GitHub: githubSecret},
		fakeResolver{repos: map[int64]uuid.UUID{42: workspaceID}, connected: map[uuid.UUID][]string{other: {"github"}}}, ingestor)
	body := `{"action":"opened","issue":{"number":7,"title":"Bug"},"repository":{"id":42,"owner":{"id":9}},"installation":{"id":77}}`
	headers := func(signature, delivery string) map[string]string {
		return map[string]string{"X-Hub-Signature-256": signature, "X-GitHub-Delivery": delivery, "X-GitHub-Event": "issues"}
	}
	good := "sha256=" + hexHMAC(githubSecret, body)

	if response := deliver(mount, "/github", body, headers("sha256="+hexHMAC("wrong", body), "d1")); response.Code != http.StatusNotFound {
		t.Fatalf("bad signature = %d %s", response.Code, response.Body.String())
	}
	if response := deliver(mount, "/github", body, headers("sha1=abc", "d1")); response.Code != http.StatusNotFound {
		t.Fatalf("sha1 signature = %d", response.Code)
	}
	if response := deliver(mount, "/github", body, map[string]string{"X-Hub-Signature-256": good, "X-GitHub-Event": "issues"}); response.Code != http.StatusBadRequest {
		t.Fatalf("missing delivery id = %d %s", response.Code, response.Body.String())
	}
	if len(ingestor.ingested) != 0 {
		t.Fatalf("refused deliveries were ingested: %+v", ingestor.ingested)
	}
	response := deliver(mount, "/github", body, headers(good, "d1"))
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"event":"issues.opened"`) {
		t.Fatalf("accepted = %d %s", response.Code, response.Body.String())
	}
	if len(ingestor.ingested) != 1 {
		t.Fatalf("ingested = %+v", ingestor.ingested)
	}
	params := ingestor.ingested[0]
	if params.Provider != "github" || params.DeliveryID != "d1" || params.WorkspaceID != workspaceID || params.Event != "issues.opened" ||
		string(params.Payload) != body || !params.ReceivedAt.Equal(now) {
		t.Fatalf("params = %+v", params)
	}
	if response := deliver(mount, "/github", body, headers(good, "d1")); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "duplicate") {
		t.Fatalf("redelivery = %d %s", response.Code, response.Body.String())
	}
	if len(ingestor.ingested) != 1 {
		t.Fatalf("redelivery ingested again: %+v", ingestor.ingested)
	}
	// An unknown repository and account is nobody's delivery.
	unknown := `{"action":"opened","repository":{"id":1,"owner":{"id":2}},"installation":{"id":3}}`
	if response := deliver(mount, "/github", unknown, headers("sha256="+hexHMAC(githubSecret, unknown), "d2")); response.Code != http.StatusNotFound {
		t.Fatalf("unknown repository = %d", response.Code)
	}
	// The URL may name the workspace, which must hold a live connection.
	if response := deliver(mount, "/github?workspaceId="+other.String(), unknown, headers("sha256="+hexHMAC(githubSecret, unknown), "d3")); response.Code != http.StatusAccepted {
		t.Fatalf("named workspace = %d %s", response.Code, response.Body.String())
	}
	if last := ingestor.ingested[len(ingestor.ingested)-1]; last.WorkspaceID != other {
		t.Fatalf("named workspace routed to %s", last.WorkspaceID)
	}
	if response := deliver(mount, "/github?workspaceId="+uuid.NewString(), unknown, headers("sha256="+hexHMAC(githubSecret, unknown), "d4")); response.Code != http.StatusNotFound {
		t.Fatalf("named workspace without a connection = %d", response.Code)
	}
	// A push has no action: the event is the header alone.
	push := `{"ref":"refs/heads/main","repository":{"id":42}}`
	response = deliver(mount, "/github", push, map[string]string{"X-Hub-Signature-256": "sha256=" + hexHMAC(githubSecret, push), "X-GitHub-Delivery": "d5", "X-GitHub-Event": "push"})
	if response.Code != http.StatusAccepted || ingestor.ingested[len(ingestor.ingested)-1].Event != "push" {
		t.Fatalf("push = %d %s", response.Code, response.Body.String())
	}
}

// Slack: v0 request signing with a five-minute window, the URL
// verification handshake answered without ingesting, and the team routing
// the event.
func TestSlackIngestHandshakesAndRoutesByTeam(t *testing.T) {
	now := time.Date(2026, time.August, 26, 9, 0, 0, 0, time.UTC)
	workspaceID := uuid.New()
	ingestor := &fakeIngestor{}
	mount := ingestMount(t, now, IngestSecrets{Slack: slackSecret}, fakeResolver{accounts: map[string]uuid.UUID{"slack:T1": workspaceID}}, ingestor)
	sign := func(body string, at time.Time) map[string]string {
		timestamp := strconv.FormatInt(at.Unix(), 10)
		return map[string]string{
			"X-Slack-Request-Timestamp": timestamp,
			"X-Slack-Signature":         "v0=" + hexHMAC(slackSecret, "v0:"+timestamp+":", body),
		}
	}
	handshake := `{"type":"url_verification","challenge":"abc123","token":"t"}`
	response := deliver(mount, "/slack", handshake, sign(handshake, now))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"challenge":"abc123"`) || len(ingestor.ingested) != 0 {
		t.Fatalf("handshake = %d %s", response.Code, response.Body.String())
	}
	event := `{"type":"event_callback","team_id":"T1","event_id":"Ev1","event":{"type":"message","text":"hi","channel":"C1"}}`
	if response := deliver(mount, "/slack", event, sign(event, now.Add(-6*time.Minute))); response.Code != http.StatusNotFound {
		t.Fatalf("stale timestamp = %d", response.Code)
	}
	if response := deliver(mount, "/slack", event, sign(event, now)); response.Code != http.StatusAccepted {
		t.Fatalf("event = %d %s", response.Code, response.Body.String())
	}
	if len(ingestor.ingested) != 1 || ingestor.ingested[0].Event != "message" || ingestor.ingested[0].DeliveryID != "Ev1" || ingestor.ingested[0].WorkspaceID != workspaceID {
		t.Fatalf("ingested = %+v", ingestor.ingested)
	}
	foreign := `{"type":"event_callback","team_id":"T9","event_id":"Ev2","event":{"type":"message"}}`
	if response := deliver(mount, "/slack", foreign, sign(foreign, now)); response.Code != http.StatusNotFound {
		t.Fatalf("unknown team = %d", response.Code)
	}
	if response := deliver(mount, "/slack", event, sign(event, now)); response.Code != http.StatusOK {
		t.Fatalf("redelivery = %d", response.Code)
	}
}

// Linear: a plain hex HMAC over the body, the delivery header as the id,
// type and action as the event, the organisation as the route.
func TestLinearIngestRoutesByOrganisation(t *testing.T) {
	now := time.Date(2026, time.August, 26, 9, 0, 0, 0, time.UTC)
	workspaceID := uuid.New()
	ingestor := &fakeIngestor{}
	mount := ingestMount(t, now, IngestSecrets{Linear: linearSecret}, fakeResolver{accounts: map[string]uuid.UUID{"linear:org-1": workspaceID}}, ingestor)
	body := `{"action":"create","type":"Issue","organizationId":"org-1","webhookId":"w1","webhookTimestamp":1756198800000,"data":{"id":"i1","title":"Bug"}}`
	headers := map[string]string{"Linear-Signature": hexHMAC(linearSecret, body), "Linear-Delivery": "8b4d2a1e-1c0f-4c1e-9a3b-0c9d1e2f3a4b"}
	if response := deliver(mount, "/linear", body, map[string]string{"Linear-Signature": hexHMAC("nope", body)}); response.Code != http.StatusNotFound {
		t.Fatalf("bad signature = %d", response.Code)
	}
	if response := deliver(mount, "/linear", body, headers); response.Code != http.StatusAccepted {
		t.Fatalf("event = %d %s", response.Code, response.Body.String())
	}
	if len(ingestor.ingested) != 1 || ingestor.ingested[0].Event != "issue.create" || ingestor.ingested[0].DeliveryID != headers["Linear-Delivery"] || ingestor.ingested[0].WorkspaceID != workspaceID {
		t.Fatalf("ingested = %+v", ingestor.ingested)
	}
	// Without the header the webhook id and timestamp make the id.
	if response := deliver(mount, "/linear", body, map[string]string{"Linear-Signature": hexHMAC(linearSecret, body)}); response.Code != http.StatusAccepted || ingestor.ingested[1].DeliveryID != "w1:1756198800000" {
		t.Fatalf("header-less delivery = %d %+v", response.Code, ingestor.ingested)
	}
	foreign := `{"action":"update","type":"Issue","organizationId":"org-9"}`
	if response := deliver(mount, "/linear", foreign, map[string]string{"Linear-Signature": hexHMAC(linearSecret, foreign), "Linear-Delivery": "d9"}); response.Code != http.StatusNotFound {
		t.Fatalf("unknown organisation = %d", response.Code)
	}
}

// A provider without a secret, an unknown provider, and a deployment with
// no secrets at all answer 404 — never 500 — and an oversized body is
// refused before the signature is checked.
func TestIngestRefusalsAreOpaque(t *testing.T) {
	now := time.Now()
	ingestor := &fakeIngestor{}
	mount := ingestMount(t, now, IngestSecrets{GitHub: githubSecret}, fakeResolver{}, ingestor)
	body := `{"type":"event_callback","team_id":"T1","event_id":"Ev1","event":{"type":"message"}}`
	for name, path := range map[string]string{"unconfigured slack": "/slack", "unknown provider": "/stripe", "unconfigured linear": "/linear"} {
		if response := deliver(mount, path, body, nil); response.Code != http.StatusNotFound {
			t.Fatalf("%s = %d %s", name, response.Code, response.Body.String())
		}
	}
	huge := `{"pad":"` + strings.Repeat("x", maxIngestBody) + `"}`
	if response := deliver(mount, "/github", huge, map[string]string{"X-Hub-Signature-256": "sha256=" + hexHMAC(githubSecret, huge), "X-GitHub-Delivery": "d", "X-GitHub-Event": "push"}); response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized = %d", response.Code)
	}
	bare, err := NewMount(Options{Store: newStore(), Starter: &fakeStarter{}, Clock: func() time.Time { return now }, NewID: uuid.New})
	if err != nil {
		t.Fatal(err)
	}
	if response := deliver(bare.Handler, "/github", body, nil); response.Code != http.StatusNotFound {
		t.Fatalf("no secrets = %d", response.Code)
	}
	if len(ingestor.ingested) != 0 {
		t.Fatalf("refused deliveries were ingested: %+v", ingestor.ingested)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatal(err)
	}
}
