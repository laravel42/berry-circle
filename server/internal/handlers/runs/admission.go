package runs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	runrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
)

const (
	maxCreateRunBody = 128 * 1024
	maxInstructions  = 20_000
)

type createRunRequest struct {
	AgentID      *string `json:"agentId"`
	Instructions *string `json:"instructions"`
}

func (handlers *Handlers) createIssueRun(
	response http.ResponseWriter,
	request *http.Request,
) {
	user, ok := auth.UserFromContext(request.Context())
	if !ok {
		writeUnauthenticated(response, request)
		return
	}
	issueID, err := handlers.repository.ResolveIssueID(
		request.Context(),
		chi.URLParam(request, "issueRef"),
	)
	if errors.Is(err, runrepo.ErrNotFound) {
		writeIssueNotFound(response, request)
		return
	}
	if err != nil {
		writeInternal(response, request)
		return
	}
	issueScope, err := handlers.authorization.AuthorizeIssue(
		request.Context(),
		user.ID,
		issueID,
		identity.PermissionRunsDispatch,
	)
	if !writeRunAuthorization(response, request, err, "issue") {
		return
	}
	key, ok := requireIdempotencyKey(response, request)
	if !ok {
		return
	}
	body, decoded, ok := decodeCreateRun(response, request)
	if !ok {
		return
	}
	fingerprint, err := httpapi.FingerprintJSON(body)
	if err != nil {
		writeValidation(response, request, httpapi.FieldError{
			Path: "/", Code: "invalid_json", Message: "Request body must be valid JSON.",
		})
		return
	}
	now := handlers.clock().UTC()
	decision, err := handlers.idempotency.Begin(
		request.Context(),
		httpapi.ActorScope{
			ActorType:     "user",
			ActorID:       user.ID,
			Method:        http.MethodPost,
			CanonicalPath: request.URL.Path,
		},
		key,
		fingerprint,
		now,
	)
	if err != nil {
		writeDurableUnavailable(response, request)
		return
	}
	switch decision.Decision {
	case httpapi.IdempotencyReplay:
		httpapi.Replay(response, decision.Response)
		return
	case httpapi.IdempotencyConflict:
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"IDEMPOTENCY_CONFLICT",
			"Idempotency-Key was already used with a different request body.",
			nil,
		)
		return
	case httpapi.IdempotencyInProgress:
		response.Header().Set("Retry-After", "1")
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"CONFLICT",
			"An identical request is already in progress.",
			nil,
		)
		return
	case httpapi.IdempotencyProceed:
	default:
		writeInternal(response, request)
		return
	}

	var agentID *uuid.UUID
	if decoded.AgentID != nil {
		parsed, err := uuid.Parse(*decoded.AgentID)
		if err != nil || parsed == uuid.Nil || parsed.String() != *decoded.AgentID {
			_ = handlers.idempotency.Abandon(
				context.WithoutCancel(request.Context()),
				decision.ClaimID,
			)
			writeValidation(response, request, httpapi.FieldError{
				Path:    "/agentId",
				Code:    "invalid",
				Message: "agentId must be a canonical UUID.",
			})
			return
		}
		agentID = &parsed
		agentScope, err := handlers.authorization.AuthorizeAgent(
			request.Context(),
			user.ID,
			parsed,
			identity.PermissionRead,
		)
		if !writeRunAuthorization(response, request, err, "agent") {
			_ = handlers.idempotency.Abandon(
				context.WithoutCancel(request.Context()),
				decision.ClaimID,
			)
			return
		}
		if agentScope.WorkspaceID != issueScope.WorkspaceID {
			_ = handlers.idempotency.Abandon(
				context.WithoutCancel(request.Context()),
				decision.ClaimID,
			)
			writeRunAuthorization(response, request, identity.ErrNotFound, "agent")
			return
		}
	}
	run, err := handlers.service.Admit(request.Context(), runrepo.AdmitParams{
		RunID:          handlers.newID(),
		CreatedEventID: handlers.newID(),
		AssignmentID:   handlers.newID(),
		IssueRef:       chi.URLParam(request, "issueRef"),
		WorkspaceID:    issueScope.WorkspaceID,
		AgentID:        agentID,
		Instructions:   decoded.Instructions,
		RequestedBy:    user.ID,
		RequestID:      httpapi.RequestID(request.Context()),
		TraceParent:    boundedHeader(request, "traceparent", 512),
		CreatedAt:      now,
	})
	if err != nil {
		_ = handlers.idempotency.Abandon(
			context.WithoutCancel(request.Context()),
			decision.ClaimID,
		)
		writeAdmissionError(response, request, err)
		return
	}
	payload, err := json.Marshal(serialize(run))
	if err != nil {
		writeInternal(response, request)
		return
	}
	location := "/api/v1/runs/" + run.ID.String()
	stored := httpapi.StoredResponse{
		Status: http.StatusAccepted,
		Headers: map[string][]string{
			"Content-Type": {"application/json"},
			"Location":     {location},
		},
		Body: payload,
	}
	_ = handlers.idempotency.Complete(
		context.WithoutCancel(request.Context()),
		decision.ClaimID,
		stored,
		handlers.clock().UTC(),
	)
	// Acceptance still succeeds if the handoff fails: 503 would falsely claim
	// no run was created, and the durable active-run guard prevents redispatch.
	// The run stays queued for reconciliation, so the failure is logged rather
	// than discarded — silently dropping it is how a run goes missing with no
	// trace of why.
	if err := handlers.service.Queue(run.ID); err != nil {
		logDispatchFailure(run.ID, err)
	}
	writeStored(response, stored)
}

func decodeCreateRun(
	response http.ResponseWriter,
	request *http.Request,
) ([]byte, createRunRequest, bool) {
	reader := http.MaxBytesReader(response, request.Body, maxCreateRunBody)
	body, err := io.ReadAll(reader)
	if err != nil {
		httpapi.WriteError(
			response,
			request,
			http.StatusRequestEntityTooLarge,
			"PAYLOAD_TOO_LARGE",
			"Request body is too large.",
			nil,
		)
		return nil, createRunRequest{}, false
	}
	trimmedBody := bytes.TrimSpace(body)
	if len(trimmedBody) == 0 {
		body = []byte("{}")
		trimmedBody = body
	}
	if trimmedBody[0] != '{' {
		writeValidation(response, request, httpapi.FieldError{
			Path: "/", Code: "invalid_json", Message: "Request body must be a JSON object.",
		})
		return nil, createRunRequest{}, false
	}
	var value createRunRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		writeValidation(response, request, httpapi.FieldError{
			Path: "/", Code: "invalid_json", Message: "Request body must be a JSON object with known fields.",
		})
		return nil, createRunRequest{}, false
	}
	if err := ensureJSONEOF(decoder); err != nil {
		writeValidation(response, request, httpapi.FieldError{
			Path: "/", Code: "invalid_json", Message: "Request body must contain one JSON object.",
		})
		return nil, createRunRequest{}, false
	}
	if value.Instructions != nil {
		if !utf8.ValidString(*value.Instructions) ||
			utf8.RuneCountInString(*value.Instructions) > maxInstructions {
			writeValidation(response, request, httpapi.FieldError{
				Path:    "/instructions",
				Code:    "too_long",
				Message: "instructions must be at most 20000 characters.",
			})
			return nil, createRunRequest{}, false
		}
		trimmed := strings.TrimSpace(*value.Instructions)
		if trimmed == "" {
			value.Instructions = nil
		} else {
			value.Instructions = &trimmed
		}
	}
	return body, value, true
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra json.RawMessage
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values")
	}
	return err
}

func requireIdempotencyKey(
	response http.ResponseWriter,
	request *http.Request,
) (string, bool) {
	values := request.Header.Values("Idempotency-Key")
	if len(values) != 1 {
		writeValidation(response, request, httpapi.FieldError{
			Path:    "/headers/Idempotency-Key",
			Code:    "required",
			Message: "Idempotency-Key is required.",
		})
		return "", false
	}
	key := values[0]
	if httpapi.ValidateIdempotencyKey(key) != nil {
		writeValidation(response, request, httpapi.FieldError{
			Path:    "/headers/Idempotency-Key",
			Code:    "invalid",
			Message: "Idempotency-Key must be 16 to 128 visible ASCII characters.",
		})
		return "", false
	}
	return key, true
}

func boundedHeader(request *http.Request, name string, max int) string {
	value := strings.TrimSpace(request.Header.Get(name))
	if value == "" || len(value) > max {
		return ""
	}
	return value
}

func writeAdmissionError(
	response http.ResponseWriter,
	request *http.Request,
	err error,
) {
	var active *runrepo.ActiveRunError
	switch {
	case errors.Is(err, runrepo.ErrNotFound):
		writeIssueNotFound(response, request)
	case errors.Is(err, runrepo.ErrIssueHasNoAgent):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"CONFLICT",
			"The issue must be assigned to an agent before starting a run.",
			nil,
		)
	case errors.Is(err, runrepo.ErrAgentNotFound):
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"AGENT_NOT_FOUND",
			"The assigned agent was not found.",
			nil,
		)
	case errors.Is(err, runrepo.ErrConflict):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"CONFLICT",
			"The run could not be admitted because the issue changed.",
			nil,
		)
	case errors.As(err, &active):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"ACTIVE_RUN_EXISTS",
			"The issue already has an active run.",
			map[string]any{"runId": active.RunID},
		)
	default:
		writeDurableUnavailable(response, request)
	}
}

func writeStored(response http.ResponseWriter, stored httpapi.StoredResponse) {
	for name, values := range stored.Headers {
		for _, value := range values {
			response.Header().Add(name, value)
		}
	}
	response.WriteHeader(stored.Status)
	_, _ = response.Write(stored.Body)
}

// logDispatchFailure records a run that was admitted but not handed off.
//
// The run is durable and sits in `queued`, so this is recoverable — but only if
// somebody knows it happened. Reconciliation is what picks it up; this is the
// breadcrumb explaining why it needed to.
func logDispatchFailure(runID uuid.UUID, err error) {
	slog.Default().Error(
		"run admitted but dispatch handoff failed; awaiting reconciliation",
		"runId", runID,
		"error", err,
	)
}
