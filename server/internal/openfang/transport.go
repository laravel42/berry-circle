package openfang

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// RetryClass makes retry safety explicit at every upstream call site.
type RetryClass string

const (
	RetryRead            RetryClass = "read"
	RetryIdempotentWrite RetryClass = "idempotent-write"
	RetryUnsafe          RetryClass = "unsafe"
)

// ErrorKind is a stable internal classification for upstream failures.
type ErrorKind string

const (
	ErrorBadRequest  ErrorKind = "bad_request"
	ErrorAuth        ErrorKind = "authentication"
	ErrorNotFound    ErrorKind = "not_found"
	ErrorRateLimited ErrorKind = "rate_limited"
	ErrorBadResponse ErrorKind = "bad_response"
	ErrorUnavailable ErrorKind = "unavailable"
)

// UpstreamError intentionally excludes raw response bodies and credentials.
type UpstreamError struct {
	Kind       ErrorKind
	StatusCode int
	RequestID  string
	Retryable  bool
}

func (err *UpstreamError) Error() string {
	if err.StatusCode > 0 {
		return fmt.Sprintf("runtime dependency returned HTTP %d (%s)", err.StatusCode, err.Kind)
	}
	return fmt.Sprintf("runtime dependency request failed (%s)", err.Kind)
}

// Transport is the server-side execution-substrate HTTP boundary.
type Transport interface {
	Do(context.Context, *http.Request, RetryClass) (*http.Response, error)
}

// Client sends traced, authenticated requests without exposing its API key.
type Client struct {
	baseURL     *url.URL
	apiKey      string
	httpClient  *http.Client
	logger      *slog.Logger
	tracer      trace.Tracer
	maxAttempts int
	baseBackoff time.Duration
	maxBackoff  time.Duration

	requestTimeout time.Duration
	streamTimeout  time.Duration
	chatTimeout    time.Duration
	maxJSONBytes   int64
	maxStreamBytes int64
	maxEventBytes  int
}

// New constructs an upstream transport.
func New(
	baseURL, apiKey string,
	httpClient *http.Client,
	logger *slog.Logger,
) (*Client, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("OPENFANG_BASE_URL is invalid")
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Client{
		baseURL:     parsed,
		apiKey:      apiKey,
		httpClient:  httpClient,
		logger:      logger,
		tracer:      otel.Tracer("berry/internal/openfang"),
		maxAttempts: 3,
		baseBackoff: 100 * time.Millisecond,
		maxBackoff:  2 * time.Second,

		requestTimeout: 30 * time.Second,
		streamTimeout:  15 * time.Minute,
		chatTimeout:    5 * time.Minute,
		maxJSONBytes:   1024 * 1024,
		maxStreamBytes: 8 * 1024 * 1024,
		maxEventBytes:  128 * 1024,
	}, nil
}

// NewJSONRequest builds a server-side request relative to the configured base.
func (client *Client) NewJSONRequest(
	ctx context.Context,
	method, requestPath string,
	body any,
) (*http.Request, error) {
	if client == nil || client.baseURL == nil {
		return nil, errors.New("runtime dependency transport is not configured")
	}
	relative, err := url.Parse(requestPath)
	if err != nil || relative.IsAbs() || !strings.HasPrefix(relative.Path, "/") ||
		relative.Host != "" {
		return nil, errors.New("runtime dependency path is invalid")
	}
	target := *client.baseURL
	target.Path = strings.TrimRight(client.baseURL.Path, "/") + relative.Path
	target.RawPath = ""
	target.RawQuery = relative.RawQuery

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode runtime dependency request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), reader)
	if err != nil {
		return nil, errors.New("build runtime dependency request")
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return request, nil
}

// Do performs a bounded retry only when both class and HTTP method are safe.
// Unsafe POST dispatch is attempted exactly once.
func (client *Client) Do(
	ctx context.Context,
	request *http.Request,
	class RetryClass,
) (*http.Response, error) {
	if client == nil || client.httpClient == nil {
		return nil, errors.New("runtime dependency transport is not configured")
	}
	retry, err := retryAllowed(request.Method, class)
	if err != nil {
		return nil, err
	}
	attempts := 1
	if retry {
		attempts = client.maxAttempts
		if request.Body != nil && request.GetBody == nil {
			return nil, errors.New("retryable runtime request body cannot be replayed")
		}
	}

	ctx, span := client.tracer.Start(
		ctx,
		"runtime.http",
		trace.WithAttributes(
			attribute.String("http.request.method", request.Method),
			attribute.String("berry.retry_class", string(class)),
		),
	)
	defer span.End()

	var last *UpstreamError
	for attempt := 1; attempt <= attempts; attempt++ {
		current := request.Clone(ctx)
		if request.Body != nil {
			if request.GetBody == nil {
				current.Body = request.Body
			} else {
				body, err := request.GetBody()
				if err != nil {
					return nil, errors.New("recreate runtime dependency request body")
				}
				current.Body = body
			}
		}
		if client.apiKey != "" {
			current.Header.Set("Authorization", "Bearer "+client.apiKey)
		}
		otel.GetTextMapPropagator().Inject(
			current.Context(),
			propagation.HeaderCarrier(current.Header),
		)

		response, err := client.httpClient.Do(current)
		if err != nil {
			if response != nil && response.Body != nil {
				_ = response.Body.Close()
			}
			last = &UpstreamError{Kind: ErrorUnavailable, Retryable: retry}
			if !retry || attempt == attempts {
				return nil, last
			}
			if err := wait(ctx, client.backoff(attempt)); err != nil {
				return nil, err
			}
			continue
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return response, nil
		}

		upstreamErr := classify(response)
		last = upstreamErr
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		_ = response.Body.Close()
		if !retry || !upstreamErr.Retryable || attempt == attempts {
			return nil, upstreamErr
		}
		delay := client.backoff(attempt)
		if response.StatusCode == http.StatusTooManyRequests {
			if parsed := retryAfter(response.Header.Get("Retry-After"), time.Now()); parsed > 0 {
				delay = min(parsed, client.maxBackoff)
			}
		}
		client.logger.Warn(
			"retrying safe runtime dependency request",
			"attempt",
			attempt,
			"retryClass",
			class,
			"status",
			response.StatusCode,
		)
		if err := wait(ctx, delay); err != nil {
			return nil, err
		}
	}
	return nil, last
}

func retryAllowed(method string, class RetryClass) (bool, error) {
	switch class {
	case RetryRead:
		if method != http.MethodGet && method != http.MethodHead {
			return false, errors.New("read retry class requires GET or HEAD")
		}
		return true, nil
	case RetryIdempotentWrite:
		// PUT is idempotent by definition; PATCH is not, in general — a patch
		// that increments a value changes state on every application. The class
		// is therefore the caller's assertion about the specific endpoint, and
		// is only correct for a PATCH that sets absolute values. Anything with
		// relative semantics belongs in RetryUnsafe.
		if method != http.MethodPut && method != http.MethodPatch {
			return false, errors.New("idempotent-write retry class requires PUT or PATCH")
		}
		return true, nil
	case RetryUnsafe:
		return false, nil
	default:
		return false, errors.New("unknown runtime dependency retry class")
	}
}

func classify(response *http.Response) *UpstreamError {
	err := &UpstreamError{
		StatusCode: response.StatusCode,
		RequestID:  response.Header.Get("X-Request-Id"),
	}
	switch response.StatusCode {
	case http.StatusBadRequest, http.StatusForbidden, http.StatusRequestEntityTooLarge:
		err.Kind = ErrorBadRequest
	case http.StatusUnauthorized:
		err.Kind = ErrorAuth
	case http.StatusNotFound:
		err.Kind = ErrorNotFound
	case http.StatusTooManyRequests:
		err.Kind = ErrorRateLimited
		err.Retryable = true
	default:
		if response.StatusCode >= 500 {
			err.Kind = ErrorUnavailable
			err.Retryable = true
		} else {
			err.Kind = ErrorBadResponse
		}
	}
	return err
}

func (client *Client) backoff(attempt int) time.Duration {
	multiplier := 1 << min(attempt-1, 8)
	base := min(time.Duration(multiplier)*client.baseBackoff, client.maxBackoff)
	jitter := time.Duration(rand.Int64N(max(int64(base/4), 1)))
	return min(base+jitter, client.maxBackoff)
}

func retryAfter(raw string, now time.Time) time.Duration {
	if seconds, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if instant, err := http.ParseTime(raw); err == nil && instant.After(now) {
		return instant.Sub(now)
	}
	return 0
}

func wait(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
