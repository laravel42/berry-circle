// Package infobip adapts Infobip's messaging and WebRTC APIs.
//
// Infobip is transport, not a system of record. Berry owns conversations,
// participants, and messages; this package moves a message to someone who is
// away from their computer, and mints the short-lived token a browser needs to
// join a call. Nothing here is authoritative — if Infobip is unavailable, the
// in-app conversation still works.
//
// Credential boundary, identical to the OpenFang rule: INFOBIP_API_KEY is
// server-side configuration. It is never logged, never persisted in product
// rows, and never sent to a browser. The one thing a browser does receive is a
// WebRTC token, which is the point of that endpoint: it is scoped to a single
// identity and expires, so it is safe to hand out in a way the API key never is.
package infobip

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Channel is a delivery channel Berry can reach a person on.
type Channel string

const (
	ChannelWhatsApp Channel = "WHATSAPP"
	ChannelSMS      Channel = "SMS"
	ChannelViber    Channel = "VIBER"
	ChannelTelegram Channel = "TELEGRAM"
	ChannelEmail    Channel = "EMAIL"
	ChannelLiveChat Channel = "LIVE_CHAT"
)

// maxResponseBytes bounds a provider response so a misbehaving upstream cannot
// exhaust memory.
const maxResponseBytes = 1 << 20

// Client talks to one Infobip account.
type Client struct {
	baseURL    string
	apiKey     string
	sender     map[Channel]string
	httpClient *http.Client
	logger     *slog.Logger
	timeout    time.Duration
}

// Options configures the client. Base URL is per-account — Infobip issues a
// personalised host — so it is required rather than defaulted.
type Options struct {
	BaseURL string
	APIKey  string
	// Sender address per channel: the WhatsApp sender, the SMS originator.
	Senders    map[Channel]string
	HTTPClient *http.Client
	Logger     *slog.Logger
	Timeout    time.Duration
}

// New validates configuration up front so a bad base URL fails at boot rather
// than the first time someone is away from their desk.
func New(options Options) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(options.BaseURL))
	if err != nil || parsed.Host == "" ||
		(parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
		return nil, errors.New("INFOBIP_BASE_URL is invalid")
	}
	if strings.TrimSpace(options.APIKey) == "" {
		return nil, errors.New("INFOBIP_API_KEY is required")
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	senders := make(map[Channel]string, len(options.Senders))
	for channel, sender := range options.Senders {
		if trimmed := strings.TrimSpace(sender); trimmed != "" {
			senders[channel] = trimmed
		}
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return &Client{
		baseURL:    parsed.String(),
		apiKey:     options.APIKey,
		sender:     senders,
		httpClient: client,
		logger:     logger,
		timeout:    timeout,
	}, nil
}

// Error is a classified provider failure. It never carries a response body:
// upstream errors can echo request content, and this is logged.
type Error struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
}

func (err *Error) Error() string {
	return fmt.Sprintf("infobip: %s (status %d)", err.Message, err.Status)
}

// WebRTCToken is a short-lived browser credential for one identity.
type WebRTCToken struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expirationTime"`
}

// IssueWebRTCToken mints a call token for one Berry identity.
//
// Identity must be stable and unique per participant, because it is how the
// media platform tells participants apart in a group call. Berry passes its own
// user id rather than an email or phone number: the identity ends up in a token
// held by a browser, so it should not carry personal contact details.
//
// Safe to retry — minting a token creates no conversation and sends nothing.
func (client *Client) IssueWebRTCToken(
	ctx context.Context,
	identity, displayName string,
	ttl time.Duration,
) (WebRTCToken, error) {
	identity = strings.TrimSpace(identity)
	if len(identity) < 3 || len(identity) > 64 {
		return WebRTCToken{}, errors.New("webrtc identity must be 3-64 characters")
	}
	body := map[string]any{"identity": identity}
	// The provider requires at least 5 characters, so a short display name is
	// dropped rather than sent and rejected.
	if name := strings.TrimSpace(displayName); len(name) >= 5 && len(name) <= 50 {
		body["displayName"] = name
	}
	if ttl > 0 {
		if ttl > 24*time.Hour {
			ttl = 24 * time.Hour
		}
		body["timeToLive"] = int(ttl.Seconds())
	}

	var token WebRTCToken
	if err := client.do(ctx, http.MethodPost, "/webrtc/1/token", body, &token); err != nil {
		return WebRTCToken{}, err
	}
	if token.Token == "" {
		return WebRTCToken{}, &Error{Status: 0, Code: "BAD_RESPONSE", Message: "empty webrtc token"}
	}
	return token, nil
}

// OutboundMessage is one Berry message being delivered off-platform.
type OutboundMessage struct {
	Channel Channel
	// Recipient address: E.164 number, email, or platform handle.
	To string
	// Overrides the configured sender for this channel when set.
	From string
	Text string
}

// SendResult identifies the delivered message so an inbound echo or a delivery
// receipt can be matched back to the Berry row.
type SendResult struct {
	MessageID string `json:"messageId"`
}

// SendMessage delivers one message over a channel.
//
// NOT automatically retried by this package. Messaging APIs have no idempotency
// key here, so a retry after an ambiguous response can deliver the message
// twice — and a duplicate message to a user's phone is a visible product defect,
// not a silent one. Callers decide, with the Berry message row as the
// deduplication record.
func (client *Client) SendMessage(
	ctx context.Context,
	message OutboundMessage,
) (SendResult, error) {
	if message.Channel == "" || strings.TrimSpace(message.To) == "" {
		return SendResult{}, errors.New("outbound message channel and recipient are required")
	}
	if strings.TrimSpace(message.Text) == "" {
		return SendResult{}, errors.New("outbound message text is required")
	}
	from := strings.TrimSpace(message.From)
	if from == "" {
		from = client.sender[message.Channel]
	}
	if from == "" {
		return SendResult{}, fmt.Errorf(
			"no configured sender for channel %s", message.Channel,
		)
	}

	body := map[string]any{
		"channel":     string(message.Channel),
		"from":        from,
		"to":          strings.TrimSpace(message.To),
		"contentType": "TEXT",
		"content":     map[string]any{"text": message.Text},
	}
	var result SendResult
	if err := client.do(
		ctx, http.MethodPost, "/messages-api/1/messages", body, &result,
	); err != nil {
		return SendResult{}, err
	}
	return result, nil
}

func (client *Client) do(
	ctx context.Context,
	method, path string,
	body any,
	target any,
) error {
	callCtx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()

	encoded, err := json.Marshal(body)
	if err != nil {
		return errors.New("encode infobip request")
	}
	request, err := http.NewRequestWithContext(
		callCtx, method, client.baseURL+path, bytes.NewReader(encoded),
	)
	if err != nil {
		return errors.New("build infobip request")
	}
	// Infobip's API-key scheme. Set per request and never logged.
	request.Header.Set("Authorization", "App "+client.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := client.httpClient.Do(request)
	if err != nil {
		return &Error{Code: "UNAVAILABLE", Message: "infobip request failed", Retryable: true}
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		_ = response.Body.Close()
	}()

	if response.StatusCode >= 400 {
		return classify(response.StatusCode)
	}
	if target == nil {
		return nil
	}
	if err := json.NewDecoder(
		io.LimitReader(response.Body, maxResponseBytes),
	).Decode(target); err != nil {
		return &Error{
			Status:  response.StatusCode,
			Code:    "BAD_RESPONSE",
			Message: "infobip response could not be parsed",
		}
	}
	return nil
}

// classify maps a status to a stable code without echoing the provider body,
// which can contain request content.
func classify(status int) *Error {
	switch {
	case status == http.StatusUnauthorized, status == http.StatusForbidden:
		return &Error{Status: status, Code: "AUTH", Message: "infobip rejected the credential"}
	case status == http.StatusNotFound:
		return &Error{Status: status, Code: "NOT_FOUND", Message: "infobip resource not found"}
	case status == http.StatusTooManyRequests:
		return &Error{
			Status: status, Code: "RATE_LIMITED",
			Message: "infobip rate limit reached", Retryable: true,
		}
	case status >= 500:
		return &Error{
			Status: status, Code: "UNAVAILABLE",
			Message: "infobip is unavailable", Retryable: true,
		}
	default:
		return &Error{Status: status, Code: "BAD_REQUEST", Message: "infobip rejected the request"}
	}
}
