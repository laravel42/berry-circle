// Package hooks receives workflow hook deliveries on /api/v1/hooks.
//
// It is a separate mount without a session on purpose: the token in the
// URL is the credential, presented by systems that hold no Berry session.
// That makes the route a public trust boundary, and it behaves like one —
// the token is compared by digest, the body is capped, deliveries are
// rate-limited per workflow, and an unknown, paused or mis-tokened workflow
// is indistinguishable from a missing one.
package hooks

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

const (
	// maxBody caps an untrusted delivery.
	maxBody = 1 << 20
	// DeliveriesPerMinute is the per-workflow budget.
	DeliveriesPerMinute = 60
	rateWindow          = time.Minute
	deliveryHeader      = "X-Berry-Delivery-Id"
)

// tokenPattern is the shape the rotate route mints (32 random bytes,
// base64url); anything else is refused before the database is asked.
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,256}$`)

// Store is the workflow persistence a delivery touches.
type Store interface {
	WebhookSecretMatches(context.Context, uuid.UUID, string) (automationrepo.Automation, bool, error)
	CreateRun(context.Context, automationrepo.CreateRunParams) (automationrepo.Run, bool, error)
	RecordHookDelivery(context.Context, uuid.UUID, uuid.UUID, string, time.Time) (bool, error)
}

// Options are explicit process dependencies.
type Options struct {
	Store   Store
	Starter automationrun.Starter
	// Limiter bounds deliveries per workflow; nil uses an in-process window.
	Limiter httpapi.RateLimiter
	Clock   func() time.Time
	NewID   func() uuid.UUID
	Logger  *slog.Logger
}

type handler struct {
	options Options
}

// NewMount validates dependencies and builds the hooks subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	switch {
	case options.Store == nil:
		return httpapi.Mount{}, errors.New("hook handler store is nil")
	case options.Starter == nil:
		return httpapi.Mount{}, errors.New("hook handler starter is nil")
	case options.Clock == nil:
		return httpapi.Mount{}, errors.New("hook handler clock is nil")
	case options.NewID == nil:
		return httpapi.Mount{}, errors.New("hook handler ID generator is nil")
	}
	if options.Limiter == nil {
		options.Limiter = httpapi.NewMemoryRateLimiter(options.Clock)
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	target := &handler{options: options}
	router := httpapi.NewSubrouter()
	router.Post("/workflows/{workflowId}/{token}", target.receive)
	return httpapi.Mount{Prefix: "/api/v1/hooks", Handler: router}, nil
}

// payload is what the run's trigger scope reads: trigger.input is the JSON
// body (null when the delivery had none), beside the query string, the
// content type and the delivery id.
type payload struct {
	Input       json.RawMessage   `json:"input"`
	Query       map[string]string `json:"query"`
	ContentType string            `json:"contentType,omitempty"`
	DeliveryID  string            `json:"deliveryId,omitempty"`
	ReceivedAt  string            `json:"receivedAt"`
}

func (handler *handler) receive(response http.ResponseWriter, request *http.Request) {
	automationID, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, "workflowId"))
	token := chi.URLParam(request, "token")
	if !ok || !tokenPattern.MatchString(token) {
		writeNotFound(response, request)
		return
	}
	// Rate-limited by the id in the URL, before the token is checked, so a
	// caller guessing tokens spends its budget on refusals.
	decision, err := handler.options.Limiter.Allow(request.Context(), "hook:"+automationID.String(), DeliveriesPerMinute, rateWindow)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	if !decision.Allowed {
		retry := max(int(time.Until(decision.ResetAt).Seconds()), 1)
		response.Header().Set("Retry-After", strconv.Itoa(retry))
		httpapi.WriteError(response, request, http.StatusTooManyRequests, "RATE_LIMITED",
			"This workflow is receiving deliveries faster than it accepts them.", nil)
		return
	}
	item, matched, err := handler.options.Store.WebhookSecretMatches(request.Context(), automationID, token)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	if !matched || item.Status != automationrepo.StatusActive {
		writeNotFound(response, request)
		return
	}
	deliveryID := strings.TrimSpace(request.Header.Get(deliveryHeader))
	if len(deliveryID) > automationrepo.MaxHookDeliveryIDLength {
		httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_REQUEST",
			deliveryHeader+" is at most "+strconv.Itoa(automationrepo.MaxHookDeliveryIDLength)+" characters.", nil)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxBody))
	if err != nil {
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			httpapi.WriteError(response, request, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE",
				"A delivery is at most 1 MiB.", nil)
			return
		}
		httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_BODY", "Request body could not be read.", nil)
		return
	}
	input := json.RawMessage(`null`)
	if trimmed := strings.TrimSpace(string(body)); trimmed != "" {
		if !json.Valid([]byte(trimmed)) {
			httpapi.WriteError(response, request, http.StatusBadRequest, "INVALID_BODY", "Request body is not valid JSON.", nil)
			return
		}
		input = json.RawMessage(trimmed)
	}
	now := handler.options.Clock().UTC()
	query := map[string]string{}
	for key, values := range request.URL.Query() {
		if len(values) > 0 {
			query[key] = values[0]
		}
	}
	encoded, err := json.Marshal(payload{
		Input: input, Query: query, ContentType: request.Header.Get("Content-Type"), DeliveryID: deliveryID,
		ReceivedAt: now.Format(time.RFC3339Nano),
	})
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	runID := handler.options.NewID()
	params := automationrepo.CreateRunParams{
		ID: runID, AutomationID: item.ID, TriggerType: automation.TriggerWebhook, Payload: encoded,
		RequestedBy: item.CreatedBy, RequestID: "hook:" + runID.String(), CreatedAt: now,
	}
	if deliveryID != "" {
		// The delivery id is the run's source key: a redelivery finds the run
		// it already created instead of starting a second one.
		key := "hook:" + deliveryID
		params.SourceEventKey = &key
		params.RequestID = key
	}
	run, created, err := handler.options.Store.CreateRun(request.Context(), params)
	if err != nil {
		if errors.Is(err, automationrepo.ErrNotActive) || errors.Is(err, automationrepo.ErrNotFound) {
			writeNotFound(response, request)
			return
		}
		workmanagement.WriteInternal(response, request)
		return
	}
	if deliveryID != "" {
		// The ingest ledger the provider ingestors share; the run key above
		// is what deduplicates, so a failure here is logged, not surfaced.
		if _, err := handler.options.Store.RecordHookDelivery(request.Context(), item.ID, item.WorkspaceID, deliveryID, now); err != nil {
			handler.options.Logger.Warn("hook delivery not recorded", "workflowId", item.ID, "deliveryId", deliveryID, "error", err)
		}
	}
	if !created {
		httpapi.WriteJSON(response, http.StatusOK, map[string]string{"runId": run.ID.String()})
		return
	}
	// The run is durable; a starter that refuses the handoff leaves it
	// pending for reconciliation, so the delivery is still accepted.
	if err := handler.options.Starter.Start(context.WithoutCancel(request.Context()), run.ID); err != nil {
		handler.options.Logger.Error("hook workflow run not started", "runId", run.ID, "workflowId", item.ID, "error", err)
	}
	response.Header().Set("Location", "/api/v1/workflow-runs/"+run.ID.String())
	httpapi.WriteJSON(response, http.StatusAccepted, map[string]string{"runId": run.ID.String()})
}

// writeNotFound is the one answer for every way a delivery can fail to
// name an active workflow with this token.
func writeNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusNotFound, "NOT_FOUND", "Workflow not found.", nil)
}

// Mounts follows the shared registry convention and fails fast on invalid wiring.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic("construct hook handlers: " + err.Error())
	}
	return []httpapi.Mount{mount}
}
