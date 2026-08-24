// Package runtime exposes authenticated OpenFang compatibility probes.
package runtime

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// Options supplies auth and the upstream compatibility client.
type Options struct {
	Sessions      auth.SessionResolver
	Authorization Authorizer
	OpenFang      openfang.Compatibility
}

// Authorizer gates runtime probes to workspace readers.
type Authorizer interface {
	AuthorizeWorkspace(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Role, error)
}

// NewMount builds the authenticated runtime probe subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Sessions == nil {
		return httpapi.Mount{}, errors.New("runtime handler session resolver is nil")
	}
	if options.Authorization == nil {
		return httpapi.Mount{}, errors.New("runtime handler authorizer is nil")
	}
	if options.OpenFang == nil {
		return httpapi.Mount{}, errors.New("runtime handler compatibility client is nil")
	}
	target := &handlers{openFang: options.OpenFang, authorization: options.Authorization}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/models", target.listModels)
	router.Post("/chat/completions", target.createChatCompletion)
	return httpapi.Mount{Prefix: "/api/v1/runtime", Handler: router}, nil
}

// Mounts follows the shared registry fail-fast convention.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic(fmt.Sprintf("construct runtime handlers: %v", err))
	}
	return []httpapi.Mount{mount}
}

type handlers struct {
	openFang      openfang.Compatibility
	authorization Authorizer
}

type modelsResponse struct {
	Models []openfang.ModelSummary `json:"models"`
}

type chatCompletionBody struct {
	Model    string                 `json:"model"`
	Messages []openfang.ChatMessage `json:"messages"`
}

func (target *handlers) listModels(response http.ResponseWriter, request *http.Request) {
	if !target.authorizeWorkspace(response, request) {
		return
	}
	models, err := target.openFang.ListModels(request.Context())
	if err != nil {
		writeDependencyError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, modelsResponse{Models: models})
}

func (target *handlers) createChatCompletion(
	response http.ResponseWriter,
	request *http.Request,
) {
	if !target.authorizeWorkspace(response, request) {
		return
	}
	body, ok := parseChatCompletionBody(response, request)
	if !ok {
		return
	}
	result, err := target.openFang.CreateChatCompletion(request.Context(), body)
	if err != nil {
		if strings.Contains(err.Error(), "runtime chat") {
			writeValidation(response, request, "/body", err.Error())
			return
		}
		writeDependencyError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, result)
}

func (target *handlers) authorizeWorkspace(
	response http.ResponseWriter,
	request *http.Request,
) bool {
	user := auth.MustUser(request.Context())
	if user.CurrentWorkspaceID == nil {
		writeWorkspaceNotFound(response, request)
		return false
	}
	_, err := target.authorization.AuthorizeWorkspace(
		request.Context(),
		user.ID,
		*user.CurrentWorkspaceID,
		identity.PermissionRead,
	)
	if errors.Is(err, identity.ErrNotFound) {
		writeWorkspaceNotFound(response, request)
		return false
	}
	if errors.Is(err, identity.ErrForbidden) {
		httpapi.WriteError(
			response,
			request,
			http.StatusForbidden,
			"FORBIDDEN",
			"You do not have permission to perform this action.",
			nil,
		)
		return false
	}
	if err != nil {
		writeInternal(response, request)
		return false
	}
	return true
}

func parseChatCompletionBody(
	response http.ResponseWriter,
	request *http.Request,
) (openfang.ChatCompletionRequest, bool) {
	var body chatCompletionBody
	if !shared.DecodeJSON(response, request, &body, shared.MaxJSONBodyBytes) {
		return openfang.ChatCompletionRequest{}, false
	}
	model := strings.TrimSpace(body.Model)
	if model == "" || !utf8.ValidString(model) {
		writeValidation(response, request, "/model", "model is required.")
		return openfang.ChatCompletionRequest{}, false
	}
	if len(body.Messages) == 0 {
		writeValidation(response, request, "/messages", "messages must contain at least one entry.")
		return openfang.ChatCompletionRequest{}, false
	}
	return openfang.ChatCompletionRequest{
		Model:    model,
		Messages: body.Messages,
	}, true
}

func writeWorkspaceNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		"Workspace not found.",
		nil,
	)
}

func writeValidation(
	response http.ResponseWriter,
	request *http.Request,
	path, message string,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The request is invalid.",
		httpapi.ValidationDetails{Fields: []httpapi.FieldError{{
			Path: path, Code: "invalid", Message: message,
		}}},
	)
}

func writeDependencyBadResponse(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadGateway,
		"DEPENDENCY_BAD_RESPONSE",
		"The runtime dependency returned an unusable response.",
		nil,
	)
}

func writeDependencyError(
	response http.ResponseWriter,
	request *http.Request,
	err error,
) {
	var upstream *openfang.UpstreamError
	if errors.As(err, &upstream) && upstream.Kind == openfang.ErrorBadResponse {
		writeDependencyBadResponse(response, request)
		return
	}
	httpapi.WriteError(
		response,
		request,
		http.StatusServiceUnavailable,
		"DEPENDENCY_UNAVAILABLE",
		"The runtime dependency is unavailable.",
		nil,
	)
}

func writeInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusInternalServerError,
		"INTERNAL",
		"Internal server error.",
		nil,
	)
}
