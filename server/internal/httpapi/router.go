package httpapi

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/laravel42/berry-circle/server/internal/observability"
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)

// Mount lets a domain package contribute one disjoint route subtree.
type Mount struct {
	Prefix  string
	Handler http.Handler
}

// Registry collects domain mounts without a central package importing domains.
type Registry struct {
	mounts []Mount
}

// Register adds a non-overlapping mount.
func (registry *Registry) Register(mount Mount) error {
	if mount.Handler == nil {
		return errors.New("route mount handler is nil")
	}
	prefix, err := normalizePrefix(mount.Prefix)
	if err != nil {
		return err
	}
	for _, existing := range registry.mounts {
		if overlaps(existing.Prefix, prefix) {
			return fmt.Errorf(
				"route mount %q overlaps existing mount %q",
				prefix,
				existing.Prefix,
			)
		}
	}
	registry.mounts = append(registry.mounts, Mount{
		Prefix:  prefix,
		Handler: mount.Handler,
	})
	return nil
}

// Options configure only shared HTTP behavior.
type Options struct {
	Logger         *slog.Logger
	Metrics        *observability.HTTPMetrics
	TrustedOrigins []string
	// AllowPrivateBrowserOrigins reflects the frontend through a reverse proxy
	// in development/test (loopback and RFC1918 HTTP origins). Production
	// stays on the explicit allow-list.
	AllowPrivateBrowserOrigins bool
	NewRequestID               func() string
}

// NewSubrouter gives domain mounts the same 404/405 envelope as the root.
func NewSubrouter() chi.Router {
	router := chi.NewRouter()
	router.NotFound(func(response http.ResponseWriter, request *http.Request) {
		WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			"Route not found.",
			nil,
		)
	})
	router.MethodNotAllowed(func(response http.ResponseWriter, request *http.Request) {
		WriteError(
			response,
			request,
			http.StatusMethodNotAllowed,
			"METHOD_NOT_ALLOWED",
			"Method not allowed.",
			nil,
		)
	})
	return router
}

// Handler freezes the registry into a Chi router.
func (registry *Registry) Handler(options Options) http.Handler {
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.NewRequestID == nil {
		options.NewRequestID = func() string {
			return "req_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		}
	}

	router := chi.NewRouter()
	router.Use(requestIDMiddleware(options.NewRequestID))
	router.Use(traceMiddleware())
	router.Use(accessMiddleware(options.Logger, options.Metrics))
	router.Use(recoveryMiddleware(options.Logger))
	router.Use(securityHeaders)
	router.Use(corsMiddleware(options.TrustedOrigins, options.AllowPrivateBrowserOrigins))

	mounts := slices.Clone(registry.mounts)
	slices.SortFunc(mounts, func(left, right Mount) int {
		return strings.Compare(left.Prefix, right.Prefix)
	})
	for _, mount := range mounts {
		router.Mount(mount.Prefix, mount.Handler)
	}
	router.NotFound(func(response http.ResponseWriter, request *http.Request) {
		WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			"Route not found.",
			nil,
		)
	})
	router.MethodNotAllowed(func(response http.ResponseWriter, request *http.Request) {
		WriteError(
			response,
			request,
			http.StatusMethodNotAllowed,
			"METHOD_NOT_ALLOWED",
			"Method not allowed.",
			nil,
		)
	})
	return router
}

func normalizePrefix(prefix string) (string, error) {
	if prefix == "" || prefix[0] != '/' || strings.ContainsAny(prefix, "?#") {
		return "", errors.New("route mount prefix must be an absolute path")
	}
	if prefix != "/" {
		prefix = strings.TrimRight(prefix, "/")
	}
	if strings.Contains(prefix, "//") || strings.Contains(prefix, "..") {
		return "", errors.New("route mount prefix is not canonical")
	}
	return prefix, nil
}

func overlaps(first, second string) bool {
	return first == second ||
		first == "/" ||
		second == "/" ||
		strings.HasPrefix(first, second+"/") ||
		strings.HasPrefix(second, first+"/")
}

func requestIDMiddleware(generate func() string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			requestID := request.Header.Get("X-Request-Id")
			if !requestIDPattern.MatchString(requestID) {
				requestID = generate()
			}
			ctx := context.WithValue(request.Context(), requestIDKey, requestID)
			response.Header().Set("X-Request-Id", requestID)
			next.ServeHTTP(response, request.WithContext(ctx))
		})
	}
}

func traceMiddleware() func(http.Handler) http.Handler {
	tracer := otel.Tracer("berry/internal/httpapi")
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			ctx := otel.GetTextMapPropagator().Extract(
				request.Context(),
				propagation.HeaderCarrier(request.Header),
			)
			ctx, span := tracer.Start(
				ctx,
				"http.request",
				trace.WithSpanKind(trace.SpanKindServer),
				trace.WithAttributes(attribute.String("http.request.method", request.Method)),
			)
			defer span.End()
			if span.SpanContext().IsValid() {
				response.Header().Set("X-Trace-Id", span.SpanContext().TraceID().String())
			}
			next.ServeHTTP(response, request.WithContext(ctx))
		})
	}
}

func accessMiddleware(
	logger *slog.Logger,
	metrics *observability.HTTPMetrics,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			started := time.Now()
			complete := metrics.Begin(request.Method)
			recorder := &statusRecorder{ResponseWriter: response}
			next.ServeHTTP(recorder, request)

			route := chi.RouteContext(request.Context()).RoutePattern()
			if route == "" {
				route = "unmatched"
			}
			statusCode := recorder.statusCode()
			status := strconv.Itoa(statusCode)
			elapsed := time.Since(started)
			complete(route, status, elapsed)
			span := trace.SpanFromContext(request.Context())
			span.SetAttributes(
				attribute.String("http.route", route),
				attribute.Int("http.response.status_code", statusCode),
			)
			logger.Info(
				"http request",
				"requestId",
				RequestID(request.Context()),
				"method",
				request.Method,
				"route",
				route,
				"status",
				statusCode,
				"bytes",
				recorder.bytes,
				"duration",
				elapsed,
			)
		})
	}
}

func recoveryMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			defer func() {
				if recovered := recover(); recovered != nil {
					logger.Error(
						"recovered HTTP panic",
						"requestId",
						RequestID(request.Context()),
						"panicType",
						fmt.Sprintf("%T", recovered),
					)
					WriteError(
						response,
						request,
						http.StatusInternalServerError,
						"INTERNAL",
						"Internal server error.",
						nil,
					)
				}
			}()
			next.ServeHTTP(response, request)
		})
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("X-Frame-Options", "DENY")
		response.Header().Set("Referrer-Policy", "no-referrer")
		response.Header().Set(
			"Content-Security-Policy",
			"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		)
		response.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(response, request)
	})
}

func corsMiddleware(trusted []string, allowPrivate bool) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(trusted))
	for _, origin := range trusted {
		allowed[origin] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			origin := request.Header.Get("Origin")
			if origin == "" {
				next.ServeHTTP(response, request)
				return
			}
			if !sameOrigin(request, origin) {
				_, listed := allowed[origin]
				if !listed && !(allowPrivate && privateBrowserOrigin(origin)) {
					WriteError(
						response,
						request,
						http.StatusForbidden,
						"FORBIDDEN",
						"Origin is not allowed.",
						nil,
					)
					return
				}
			}
			response.Header().Add("Vary", "Origin")
			response.Header().Set("Access-Control-Allow-Origin", origin)
			response.Header().Set("Access-Control-Allow-Credentials", "true")
			response.Header().Set(
				"Access-Control-Expose-Headers",
				"X-Request-Id, X-Trace-Id, Location, Retry-After",
			)
			if request.Method == http.MethodOptions &&
				request.Header.Get("Access-Control-Request-Method") != "" {
				response.Header().Set(
					"Access-Control-Allow-Methods",
					"GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS",
				)
				response.Header().Set(
					"Access-Control-Allow-Headers",
					"Authorization, Content-Type, Idempotency-Key, X-Request-Id",
				)
				response.Header().Set("Access-Control-Max-Age", "600")
				response.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(response, request)
		})
	}
}

func sameOrigin(request *http.Request, rawOrigin string) bool {
	origin, err := url.Parse(rawOrigin)
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") ||
		origin.Host == "" {
		return false
	}
	requestScheme := "http"
	if request.TLS != nil {
		requestScheme = "https"
	}
	return strings.EqualFold(origin.Host, request.Host) &&
		strings.EqualFold(origin.Scheme, requestScheme)
}

func privateBrowserOrigin(rawOrigin string) bool {
	origin, err := url.Parse(rawOrigin)
	if err != nil || origin.Scheme != "http" || origin.User != nil ||
		origin.RawQuery != "" || origin.Fragment != "" ||
		(origin.Path != "" && origin.Path != "/") {
		return false
	}
	host := origin.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	bytes       int
	wroteHeader bool
}

func (recorder *statusRecorder) WriteHeader(status int) {
	if recorder.wroteHeader {
		return
	}
	recorder.wroteHeader = true
	recorder.status = status
	recorder.ResponseWriter.WriteHeader(status)
}

func (recorder *statusRecorder) Write(body []byte) (int, error) {
	if !recorder.wroteHeader {
		recorder.WriteHeader(http.StatusOK)
	}
	written, err := recorder.ResponseWriter.Write(body)
	recorder.bytes += written
	return written, err
}

func (recorder *statusRecorder) Unwrap() http.ResponseWriter {
	return recorder.ResponseWriter
}

func (recorder *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := recorder.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	if !recorder.wroteHeader {
		recorder.status = http.StatusSwitchingProtocols
		recorder.wroteHeader = true
	}
	return hijacker.Hijack()
}

func (recorder *statusRecorder) Flush() {
	if !recorder.wroteHeader {
		recorder.WriteHeader(http.StatusOK)
	}
	if flusher, ok := recorder.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (recorder *statusRecorder) statusCode() int {
	if recorder.status == 0 {
		return http.StatusOK
	}
	return recorder.status
}
