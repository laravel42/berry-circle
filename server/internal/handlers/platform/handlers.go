// Package platform exposes process health and safe public capabilities.
package platform

import (
	"context"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

// Checker is implemented by database and required-Valkey readiness probes.
type Checker interface {
	Check(context.Context) error
}

// Capabilities contains only browser-safe booleans.
type Capabilities struct {
	AgentExecution bool `json:"agentExecution"`
	Metrics        bool `json:"metrics"`
	Realtime       bool `json:"realtime"`
	Storage        bool `json:"storage"`
	Valkey         bool `json:"valkey"`
	// Planner is true when role agents can be provisioned; Workflows when
	// workflows can be activated; WorkflowEngine when the external engine
	// (Activepieces) is configured.
	Planner        bool `json:"planner"`
	Workflows      bool `json:"workflows"`
	WorkflowEngine bool `json:"workflowEngine"`
}

// Options supplies operational dependencies.
type Options struct {
	Database Checker
	Valkey   Checker
	Realtime Checker
	// Checks are additional named readiness probes (the trigger dispatcher,
	// for one). A failing check makes /readyz report NOT_READY under its
	// name, exactly like the fixed three.
	Checks         map[string]Checker
	MetricsEnabled bool
	Gatherer       prometheus.Gatherer
	Capabilities   Capabilities
}

// Mounts returns disjoint registrations for the shared router.
func Mounts(options Options) []httpapi.Mount {
	return []httpapi.Mount{
		{Prefix: "/health", Handler: healthHandler()},
		{Prefix: "/ready", Handler: readyHandler(options)},
		{Prefix: "/readyz", Handler: readyHandler(options)},
		{Prefix: "/metrics", Handler: metricsHandler(options)},
		{Prefix: "/api/v1/config", Handler: configHandler(options.Capabilities)},
	}
}

func healthHandler() http.Handler {
	router := httpapi.NewSubrouter()
	router.Get("/", func(response http.ResponseWriter, _ *http.Request) {
		httpapi.WriteJSON(response, http.StatusOK, map[string]string{"status": "ok"})
	})
	return router
}

func readyHandler(options Options) http.Handler {
	router := httpapi.NewSubrouter()
	router.Get("/", func(response http.ResponseWriter, request *http.Request) {
		databaseReady := options.Database != nil &&
			options.Database.Check(request.Context()) == nil
		valkeyReady := options.Valkey == nil ||
			options.Valkey.Check(request.Context()) == nil
		realtimeReady := options.Realtime == nil ||
			options.Realtime.Check(request.Context()) == nil
		checks := map[string]bool{
			"database": databaseReady,
			"realtime": realtimeReady,
			"valkey":   valkeyReady,
		}
		ready := databaseReady && valkeyReady && realtimeReady
		for name, checker := range options.Checks {
			passed := checker == nil || checker.Check(request.Context()) == nil
			checks[name] = passed
			ready = ready && passed
		}
		if !ready {
			httpapi.WriteError(
				response,
				request,
				http.StatusServiceUnavailable,
				"NOT_READY",
				"Service is not ready.",
				map[string]any{"checks": checks},
			)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{
			"status": "ready",
			"checks": checks,
		})
	})
	return router
}

func metricsHandler(options Options) http.Handler {
	router := httpapi.NewSubrouter()
	if !options.MetricsEnabled || options.Gatherer == nil {
		router.Get("/", func(response http.ResponseWriter, request *http.Request) {
			httpapi.WriteError(
				response,
				request,
				http.StatusNotFound,
				"NOT_FOUND",
				"Route not found.",
				nil,
			)
		})
		return router
	}
	handler := promhttp.HandlerFor(options.Gatherer, promhttp.HandlerOpts{})
	router.Get("/", handler.ServeHTTP)
	return router
}

func configHandler(capabilities Capabilities) http.Handler {
	router := httpapi.NewSubrouter()
	router.Get("/", func(response http.ResponseWriter, _ *http.Request) {
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{
			"capabilities": capabilities,
		})
	})
	return router
}
