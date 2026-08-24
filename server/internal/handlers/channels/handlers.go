// Package channels receives inbound messages from channel providers.
//
// This endpoint is reachable from the public internet and creates messages
// attributed to a Berry user — a user whose approval starts agent work. It is
// therefore treated as a trust boundary, not a convenience callback.
package channels

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/repository/conversations"
)

// maxWebhookBody bounds an untrusted request.
const maxWebhookBody = 1 << 20

// Store is the durable seam. Implemented by *conversations.Repository.
type Store interface {
	RecordInbound(
		context.Context,
		conversations.InboundMessage,
		time.Time,
	) (conversations.Recorded, error)
}

// Options configures the webhook mount.
type Options struct {
	Store  Store
	Secret string
	Clock  func() time.Time
	Logger *slog.Logger
}

// NewMount validates configuration so a webhook cannot be exposed without a
// secret. An unauthenticated inbound endpoint would let anyone post as any user.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Store == nil {
		return httpapi.Mount{}, errors.New("channel webhook store is nil")
	}
	if len(strings.TrimSpace(options.Secret)) < 16 {
		return httpapi.Mount{}, errors.New("channel webhook secret is missing or too short")
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	return httpapi.Mount{
		Prefix:  "/api/v1/channels/inbound",
		Handler: inboundHandler(options),
	}, nil
}

// inboundPayload is the subset of a provider callback Berry consumes. Unknown
// fields are ignored rather than rejected: providers add fields, and a brief
// arriving from a phone should not fail because of an unrelated addition.
type inboundPayload struct {
	Results []inboundResult `json:"results"`
}

type inboundResult struct {
	MessageID string `json:"messageId"`
	From      string `json:"from"`
	Channel   string `json:"channel"`
	Message   struct {
		Text string `json:"text"`
	} `json:"message"`
	Content struct {
		Text string `json:"text"`
	} `json:"content"`
	Text string `json:"text"`
}

// text tolerates the several shapes providers use for a plain text body.
func (result inboundResult) text() string {
	for _, candidate := range []string{
		result.Message.Text, result.Content.Text, result.Text,
	} {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func inboundHandler(options Options) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			httpapi.WriteError(
				response, request, http.StatusMethodNotAllowed,
				"METHOD_NOT_ALLOWED", "Method not allowed.", nil,
			)
			return
		}
		if !authorized(request, options.Secret) {
			// Deliberately not specific: an attacker probing this endpoint
			// learns nothing about why the secret was wrong.
			httpapi.WriteError(
				response, request, http.StatusUnauthorized,
				"UNAUTHORIZED", "Invalid webhook credential.", nil,
			)
			return
		}

		body, err := io.ReadAll(io.LimitReader(request.Body, maxWebhookBody))
		if err != nil {
			httpapi.WriteError(
				response, request, http.StatusBadRequest,
				"INVALID_BODY", "Request body could not be read.", nil,
			)
			return
		}
		var payload inboundPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			httpapi.WriteError(
				response, request, http.StatusBadRequest,
				"INVALID_BODY", "Request body is not valid JSON.", nil,
			)
			return
		}

		accepted, ignored := 0, 0
		for _, result := range payload.Results {
			text := result.text()
			if text == "" || strings.TrimSpace(result.MessageID) == "" {
				ignored++
				continue
			}
			_, err := options.Store.RecordInbound(
				request.Context(),
				conversations.InboundMessage{
					Channel:    strings.ToUpper(strings.TrimSpace(result.Channel)),
					Address:    result.From,
					Body:       text,
					ExternalID: result.MessageID,
				},
				options.Clock().UTC(),
			)
			switch {
			case err == nil:
				accepted++
			case errors.Is(err, conversations.ErrUnknownSender):
				// Expected, not a fault: a stranger messaged the business
				// number. Dropping it is correct — attributing it to a user
				// would let anyone speak as them.
				ignored++
				options.Logger.Info(
					"inbound message from unknown address ignored",
					"channel", result.Channel,
				)
			default:
				// A storage failure must return non-2xx so the provider retries;
				// idempotency on the provider message id makes that safe.
				options.Logger.Error("inbound message could not be recorded", "error", err)
				httpapi.WriteError(
					response, request, http.StatusServiceUnavailable,
					"UNAVAILABLE", "Message could not be recorded.", nil,
				)
				return
			}
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]int{
			"accepted": accepted,
			"ignored":  ignored,
		})
	})
}

// authorized compares the shared secret in constant time, so a timing
// difference cannot be used to recover it byte by byte.
func authorized(request *http.Request, secret string) bool {
	presented := strings.TrimSpace(request.Header.Get("X-Berry-Webhook-Secret"))
	if presented == "" {
		if header := request.Header.Get("Authorization"); header != "" {
			presented = strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		}
	}
	if presented == "" {
		return false
	}
	// Hashing first keeps the comparison constant-time regardless of length,
	// which a raw hmac.Equal on differing lengths would leak.
	presentedSum := sha256.Sum256([]byte(presented))
	expectedSum := sha256.Sum256([]byte(secret))
	return hmac.Equal(presentedSum[:], expectedSum[:])
}
