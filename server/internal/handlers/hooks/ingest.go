package hooks

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/integrations/webhooks"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

// Provider ingestors: POST /api/v1/hooks/{provider} for github, slack and
// linear. Each verifies the provider's signature with the deployment's
// secret before the body is parsed, resolves the workspace the delivery
// belongs to, deduplicates on the provider's delivery id and writes one
// integration.webhook.received fact; the trigger dispatcher then matches
// integration triggers on (provider, event). Nothing is retried: a
// delivery is recorded once and a redelivery answers 200 with no new fact.
//
// Every refusal that would tell a caller whether a secret is configured,
// whether a signature was close, or whether a workspace exists is the same
// 404, like the workflow hook route.

const (
	// maxIngestBody bounds a provider delivery. The fact's payload becomes a
	// run's trigger payload, which the ledger caps at 256 KiB.
	maxIngestBody = 256 << 10
	// IngestsPerMinute is the per-provider budget on this replica.
	IngestsPerMinute = 600
)

// IngestSecrets are the per-provider signing secrets; an empty secret
// leaves that provider's route answering 404.
type IngestSecrets struct {
	GitHub string
	Slack  string
	Linear string
}

func (secrets IngestSecrets) configured() bool {
	return secrets.GitHub != "" || secrets.Slack != "" || secrets.Linear != ""
}

// ErrNoWorkspace means no workspace owns the account or repository a
// delivery names.
var ErrNoWorkspace = errors.New("hooks: no workspace for this delivery")

// WorkspaceResolver routes a verified delivery to the workspace that owns
// the provider connection it came from.
type WorkspaceResolver interface {
	// WorkspaceForAccount finds the workspace whose live connection to the
	// provider is bound to the external account (a Slack team, a Linear
	// organisation, a GitHub installation).
	WorkspaceForAccount(ctx context.Context, provider, externalAccountID string) (uuid.UUID, error)
	// WorkspaceForGitHubRepository finds the workspace of the project linked
	// to the repository.
	WorkspaceForGitHubRepository(ctx context.Context, repositoryID int64) (uuid.UUID, error)
	// WorkspaceConnected reports whether the workspace has a live connection
	// to the provider, for deliveries that name their workspace in the URL.
	WorkspaceConnected(ctx context.Context, workspaceID uuid.UUID, provider string) (bool, error)
}

// Ingestor records deliveries and the facts they become.
type Ingestor interface {
	IngestWebhook(context.Context, automationrepo.IngestParams) (automationrepo.Event, bool, error)
}

// delivery is what a provider parser extracts from a verified body.
type delivery struct {
	id      string
	event   string
	account string
	// repositoryID is set for GitHub deliveries that name a repository.
	repositoryID int64
	// challenge is set for a Slack URL verification handshake, which is
	// answered directly and never ingested.
	challenge string
}

func (handler *handler) ingest(response http.ResponseWriter, request *http.Request) {
	provider := chi.URLParam(request, "provider")
	secret, parse := handler.provider(provider)
	if secret == "" || parse == nil || handler.options.Resolver == nil || handler.options.Ingestor == nil {
		writeNotFound(response, request)
		return
	}
	decision, err := handler.options.Limiter.Allow(request.Context(), "ingest:"+provider, IngestsPerMinute, rateWindow)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	if !decision.Allowed {
		retry := max(int(time.Until(decision.ResetAt).Seconds()), 1)
		response.Header().Set("Retry-After", strconv.Itoa(retry))
		httpapi.WriteError(response, request, http.StatusTooManyRequests, "RATE_LIMITED",
			"This provider is delivering faster than Berry accepts.", nil)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxIngestBody))
	if err != nil {
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			httpapi.WriteError(response, request, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE",
				"A delivery is at most 256 KiB.", nil)
			return
		}
		httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_BODY", "Request body could not be read.", nil)
		return
	}
	now := handler.options.Clock().UTC()
	if err := verify(provider, secret, body, request.Header, now); err != nil {
		writeNotFound(response, request)
		return
	}
	if !json.Valid(body) {
		httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_BODY", "Request body is not valid JSON.", nil)
		return
	}
	parsed, err := parse(body, request.Header)
	if err != nil {
		httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_BODY", err.Error(), nil)
		return
	}
	if parsed.challenge != "" {
		httpapi.WriteJSON(response, http.StatusOK, map[string]string{"challenge": parsed.challenge})
		return
	}
	workspaceID, err := handler.resolve(request, provider, parsed)
	if err != nil {
		if errors.Is(err, ErrNoWorkspace) {
			writeNotFound(response, request)
			return
		}
		workmanagement.WriteInternal(response, request)
		return
	}
	event, created, err := handler.options.Ingestor.IngestWebhook(request.Context(), automationrepo.IngestParams{
		Provider: provider, DeliveryID: parsed.id, WorkspaceID: workspaceID, Event: parsed.event,
		Payload: json.RawMessage(body), ReceivedAt: now, NewID: handler.options.NewID,
	})
	if err != nil {
		handler.options.Logger.Error("webhook delivery not ingested", "provider", provider, "deliveryId", parsed.id, "error", err)
		httpapi.WriteError(response, request, http.StatusServiceUnavailable, "DEPENDENCY_UNAVAILABLE",
			"The delivery could not be recorded; deliver it again.", nil)
		return
	}
	if !created {
		httpapi.WriteJSON(response, http.StatusOK, map[string]string{"deliveryId": parsed.id, "status": "duplicate"})
		return
	}
	httpapi.WriteJSON(response, http.StatusAccepted, map[string]string{"deliveryId": parsed.id, "eventId": event.ID.String(), "event": parsed.event})
}

type parser func(body []byte, header http.Header) (delivery, error)

// provider selects the secret and parser for a route; unknown providers
// have neither.
func (handler *handler) provider(name string) (string, parser) {
	switch name {
	case "github":
		return handler.options.Secrets.GitHub, parseGitHub
	case "slack":
		return handler.options.Secrets.Slack, parseSlack
	case "linear":
		return handler.options.Secrets.Linear, parseLinear
	}
	return "", nil
}

func verify(provider, secret string, body []byte, header http.Header, now time.Time) error {
	switch provider {
	case "github":
		return webhooks.VerifyGitHub(secret, body, header.Get("X-Hub-Signature-256"))
	case "slack":
		return webhooks.VerifySlack(secret, body, header.Get("X-Slack-Request-Timestamp"), header.Get("X-Slack-Signature"), now)
	case "linear":
		return webhooks.VerifyHMACSHA256Hex(secret, body, header.Get("Linear-Signature"))
	}
	return webhooks.ErrInvalidSignature
}

// resolve routes the delivery: a workspace named in the URL must hold a
// live connection to the provider; otherwise the account or repository the
// payload names decides.
func (handler *handler) resolve(request *http.Request, provider string, parsed delivery) (uuid.UUID, error) {
	ctx := request.Context()
	resolver := handler.options.Resolver
	if raw := request.URL.Query().Get("workspaceId"); raw != "" {
		workspaceID, ok := workmanagement.ParseCanonicalUUID(raw)
		if !ok {
			return uuid.Nil, ErrNoWorkspace
		}
		connected, err := resolver.WorkspaceConnected(ctx, workspaceID, provider)
		if err != nil {
			return uuid.Nil, err
		}
		if !connected {
			return uuid.Nil, ErrNoWorkspace
		}
		return workspaceID, nil
	}
	if parsed.repositoryID != 0 {
		workspaceID, err := resolver.WorkspaceForGitHubRepository(ctx, parsed.repositoryID)
		if err == nil {
			return workspaceID, nil
		}
		if !errors.Is(err, ErrNoWorkspace) {
			return uuid.Nil, err
		}
	}
	if parsed.account == "" {
		return uuid.Nil, ErrNoWorkspace
	}
	return resolver.WorkspaceForAccount(ctx, provider, parsed.account)
}

func parseGitHub(body []byte, header http.Header) (delivery, error) {
	id := strings.TrimSpace(header.Get("X-GitHub-Delivery"))
	kind := strings.TrimSpace(header.Get("X-GitHub-Event"))
	if id == "" || len(id) > 200 || kind == "" || len(kind) > 100 {
		return delivery{}, errors.New("X-GitHub-Delivery and X-GitHub-Event are required.")
	}
	var payload struct {
		Action     string `json:"action"`
		Repository struct {
			ID    int64 `json:"id"`
			Owner struct {
				ID int64 `json:"id"`
			} `json:"owner"`
		} `json:"repository"`
		Installation struct {
			ID int64 `json:"id"`
		} `json:"installation"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return delivery{}, errors.New("Request body is not a GitHub event.")
	}
	event := kind
	if payload.Action != "" {
		event += "." + payload.Action
	}
	parsed := delivery{id: id, event: event, repositoryID: payload.Repository.ID}
	switch {
	case payload.Installation.ID != 0:
		parsed.account = strconv.FormatInt(payload.Installation.ID, 10)
	case payload.Repository.Owner.ID != 0:
		parsed.account = strconv.FormatInt(payload.Repository.Owner.ID, 10)
	}
	return parsed, nil
}

func parseSlack(body []byte, _ http.Header) (delivery, error) {
	var payload struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
		TeamID    string `json:"team_id"`
		EventID   string `json:"event_id"`
		Event     struct {
			Type string `json:"type"`
		} `json:"event"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return delivery{}, errors.New("Request body is not a Slack event.")
	}
	switch payload.Type {
	case "url_verification":
		if payload.Challenge == "" {
			return delivery{}, errors.New("A URL verification carries a challenge.")
		}
		return delivery{challenge: payload.Challenge}, nil
	case "event_callback":
		if payload.EventID == "" || payload.Event.Type == "" || len(payload.EventID) > 200 || len(payload.Event.Type) > 100 {
			return delivery{}, errors.New("An event callback names event_id and event.type.")
		}
		return delivery{id: payload.EventID, event: payload.Event.Type, account: payload.TeamID}, nil
	}
	return delivery{}, errors.New("Only url_verification and event_callback deliveries are accepted.")
}

func parseLinear(body []byte, header http.Header) (delivery, error) {
	var payload struct {
		Action         string `json:"action"`
		Type           string `json:"type"`
		OrganizationID string `json:"organizationId"`
		WebhookID      string `json:"webhookId"`
		Timestamp      int64  `json:"webhookTimestamp"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return delivery{}, errors.New("Request body is not a Linear event.")
	}
	if payload.Action == "" || payload.Type == "" || len(payload.Action) > 50 || len(payload.Type) > 50 {
		return delivery{}, errors.New("A Linear event names action and type.")
	}
	id := strings.TrimSpace(header.Get("Linear-Delivery"))
	if id == "" {
		if payload.WebhookID == "" || payload.Timestamp == 0 {
			return delivery{}, errors.New("A Linear event carries Linear-Delivery or webhookId and webhookTimestamp.")
		}
		id = payload.WebhookID + ":" + strconv.FormatInt(payload.Timestamp, 10)
	}
	if len(id) > 200 {
		return delivery{}, errors.New("Linear-Delivery is at most 200 characters.")
	}
	return delivery{id: id, event: strings.ToLower(payload.Type) + "." + strings.ToLower(payload.Action), account: payload.OrganizationID}, nil
}
