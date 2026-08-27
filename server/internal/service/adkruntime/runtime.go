// Package adkruntime dispatches a run to Berry's TypeScript server instead of
// to OpenFang.
//
// It exists only for the length of the migration. The TypeScript server owns
// agent execution now — it runs the ADK agent, writes the run ledger and posts
// the result — but the orchestration that decides when a run happens is still
// Temporal here, in Go. This is the wire between the two: one POST that
// returns when the run is over.
//
// It goes away with the Go worker. Nothing else should be built on it.
package adkruntime

import (
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

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

// Store is the sliver of the run ledger this package needs: the ability to
// record a failure the TypeScript server never got the chance to record.
type Store interface {
	Fail(context.Context, runs.FailParams) (runs.Run, runs.Event, error)
}

// Options configures the runtime.
type Options struct {
	// BaseURL is the TypeScript server's origin, e.g. http://berry-api-ts:4100.
	BaseURL string
	// Token authenticates this worker to it. Required: the endpoint refuses
	// every request without one, so a blank token is a misconfiguration that
	// would fail every run rather than run them unauthenticated.
	Token  string
	Store  Store
	Client *http.Client
	Clock  func() time.Time
	NewID  func() uuid.UUID
	Logger *slog.Logger
}

// Runtime executes runs through the TypeScript server.
type Runtime struct {
	baseURL string
	token   string
	store   Store
	client  *http.Client
	clock   func() time.Time
	newID   func() uuid.UUID
	logger  *slog.Logger
}

// New validates configuration up front so a misconfigured worker fails at
// startup rather than on the first run it is asked to execute.
func New(options Options) (*Runtime, error) {
	parsed, err := url.Parse(strings.TrimSpace(options.BaseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("agent runtime base URL is invalid")
	}
	if strings.TrimSpace(options.Token) == "" {
		return nil, errors.New("agent runtime token is required")
	}
	if options.Store == nil {
		return nil, errors.New("agent runtime store is nil")
	}
	runtime := &Runtime{
		baseURL: strings.TrimRight(parsed.String(), "/"),
		token:   options.Token,
		store:   options.Store,
		client:  options.Client,
		clock:   options.Clock,
		newID:   options.NewID,
		logger:  options.Logger,
	}
	if runtime.client == nil {
		// No overall timeout: a run legitimately takes as long as the agent
		// takes, and the activity's own start-to-close timeout is what bounds
		// it. Only reaching the server is bounded here.
		runtime.client = &http.Client{
			Transport: &http.Transport{
				ResponseHeaderTimeout: 0,
				IdleConnTimeout:       90 * time.Second,
			},
		}
	}
	if runtime.clock == nil {
		runtime.clock = time.Now
	}
	if runtime.newID == nil {
		runtime.newID = uuid.New
	}
	if runtime.logger == nil {
		runtime.logger = slog.Default()
	}
	return runtime, nil
}

// Execute runs one agent and returns when the run has finished.
//
// It returns nothing, matching the seam it replaces: every outcome is already
// in the ledger by the time this returns, and the ledger is authoritative.
// The one case this has to handle itself is never reaching the server at all —
// then nothing wrote anything, and a run left queued would sit in the task
// forever.
func (runtime *Runtime) Execute(ctx context.Context, runID uuid.UUID) {
	response, err := runtime.post(ctx, runID)
	if err != nil {
		runtime.fail(runID, err)
		return
	}
	runtime.logger.Info(
		"agent run finished",
		"runId", runID,
		"status", response.Status,
		"toolCalls", response.ToolCalls,
		"totalTokens", response.Usage.TotalTokens,
	)
}

type outcome struct {
	Status    string `json:"status"`
	ToolCalls int    `json:"toolCalls"`
	Usage     struct {
		TotalTokens int64 `json:"totalTokens"`
	} `json:"usage"`
}

func (runtime *Runtime) post(ctx context.Context, runID uuid.UUID) (outcome, error) {
	endpoint := fmt.Sprintf("%s/internal/runs/%s/execute", runtime.baseURL, runID)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return outcome{}, fmt.Errorf("build agent run request: %w", err)
	}
	request.Header.Set("X-Berry-Internal-Token", runtime.token)
	request.Header.Set("Accept", "application/json")

	response, err := runtime.client.Do(request)
	if err != nil {
		return outcome{}, fmt.Errorf("reach agent runtime: %w", err)
	}
	defer func() {
		_ = response.Body.Close()
	}()

	// Bounded: this body is an outcome, and a runtime answering with megabytes
	// is a runtime that should not be able to exhaust the worker's memory.
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return outcome{}, fmt.Errorf("read agent run response: %w", err)
	}
	if response.StatusCode == http.StatusConflict {
		// The run was already claimed or already terminal. Somebody else owns
		// its ledger, so this must not write to it.
		return outcome{}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return outcome{}, fmt.Errorf(
			"agent runtime returned %d: %s",
			response.StatusCode,
			strings.TrimSpace(string(body)),
		)
	}

	var decoded outcome
	if err := json.Unmarshal(body, &decoded); err != nil {
		// The run itself may well have succeeded — the ledger, not this body,
		// says so — but the worker cannot report what it cannot read.
		return outcome{}, fmt.Errorf("decode agent run response: %w", err)
	}
	return decoded, nil
}

// fail records the one failure the TypeScript server cannot: the request that
// never arrived.
//
// Marked for reconciliation rather than retried. The request may have reached
// the server and started an agent before the connection broke, so trying again
// risks running the same task twice — which duplicates paid work and every
// tool side effect it had.
func (runtime *Runtime) fail(runID uuid.UUID, cause error) {
	runtime.logger.Error("agent run dispatch failed", "runId", runID, "error", cause)

	// A fresh context: the one that failed may already be cancelled, and a
	// failure that cannot be written is a run stuck queued forever.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, _, err := runtime.store.Fail(ctx, runs.FailParams{
		RunID:   runID,
		EventID: runtime.newID(),
		Failure: runs.Failure{
			Code:      "AGENT_RUNTIME_UNAVAILABLE",
			Message:   "The agent runtime could not be reached.",
			Retryable: false,
		},
		FailedAt:  runtime.clock().UTC(),
		Reconcile: true,
	}); err != nil {
		runtime.logger.Error("recording agent run failure failed", "runId", runID, "error", err)
	}
}

// Dispatcher is the run seam Temporal's activities use, implemented by
// *runadmission.Service.
type Dispatcher interface {
	Admit(context.Context, runs.AdmitParams) (runs.Run, error)
	Execute(context.Context, uuid.UUID)
	Cancel(context.Context, uuid.UUID, uuid.UUID) (runs.Run, error)
}

// Redirect returns a dispatcher that admits and cancels exactly as before but
// executes through the TypeScript server.
//
// Only execution moves. Admission decides whether a run may happen and
// cancellation records intent against the ledger; both are Berry's own
// bookkeeping and have nothing to do with which runtime the agent runs in.
func Redirect(base Dispatcher, runtime *Runtime) Dispatcher {
	return redirected{Dispatcher: base, runtime: runtime}
}

type redirected struct {
	Dispatcher
	runtime *Runtime
}

func (dispatcher redirected) Execute(ctx context.Context, runID uuid.UUID) {
	dispatcher.runtime.Execute(ctx, runID)
}
