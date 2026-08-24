package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Configurer is the narrow upstream seam for writing agent configuration.
// Deliberately separate from openfang.Runtime: run dispatch has no business
// being able to rewrite an agent's system prompt.
type Configurer interface {
	PatchAgent(context.Context, uuid.UUID, openfang.PatchAgentRequest) error
}

// maxInstructions matches the column's CHECK constraint. Validated here too so
// an oversized body is rejected before it reaches the database or the runtime.
const maxInstructions = 20000

// Instructions are the system prompt applied to every task an agent runs.
type instructionsRequest struct {
	Instructions *string `json:"instructions"`
}

// InstructionsStore is the durable seam for authored instructions.
type InstructionsStore interface {
	SetInstructions(ctx context.Context, agentID, workspaceID uuid.UUID, value *string) error
}

// SetInstructions persists the authored prompt and stamps when it was last
// pushed upstream. The stamp is what distinguishes an edit that reached
// OpenFang from one that only ever landed locally.
func (store PostgresStore) SetInstructions(
	ctx context.Context,
	agentID, workspaceID uuid.UUID,
	value *string,
) error {
	if store.Pool == nil {
		return errors.New("agent store pool is nil")
	}
	tag, err := store.Pool.Exec(
		ctx,
		`UPDATE agents
		    SET instructions = $3,
		        instructions_synced_at = now(),
		        updated_at = now()
		  WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
		agentID,
		workspaceID,
		value,
	)
	if err != nil {
		return errors.New("persist agent instructions")
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// instructionsHandler writes the agent's system prompt.
//
// Order matters: the runtime is updated before Berry records the value. If the
// upstream call fails, nothing is stored, so the editor never shows a prompt
// the agent is not actually running with. The reverse order would let a save
// look successful while the agent kept its old behaviour.
func instructionsHandler(store Store, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		agentID, err := core.ParseUUID(chi.URLParam(request, "agentId"))
		if err != nil {
			writeNotFound(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := options.Authorization.AuthorizeAgent(
			request.Context(),
			user.ID,
			agentID,
			identity.PermissionWrite,
		)
		if !writeAgentAuthorization(response, request, err, false) {
			return
		}

		var body instructionsRequest
		decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxInstructions*2))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil {
			httpapi.WriteError(
				response, request, http.StatusBadRequest,
				"INVALID_BODY", "Request body is not valid JSON.", nil,
			)
			return
		}

		// An empty string clears the prompt; a null field is the same request,
		// so both normalise to "no instructions" rather than one meaning
		// "leave unchanged" and silently doing nothing.
		var value *string
		if body.Instructions != nil {
			trimmed := strings.TrimSpace(*body.Instructions)
			if utf8.RuneCountInString(trimmed) > maxInstructions {
				httpapi.WriteError(
					response, request, http.StatusBadRequest,
					"INSTRUCTIONS_TOO_LONG",
					"Instructions exceed the maximum length.", nil,
				)
				return
			}
			if trimmed != "" {
				value = &trimmed
			}
		}

		found, err := store.Get(request.Context(), agentID, scope.WorkspaceID)
		if errors.Is(err, ErrNotFound) {
			writeNotFound(response, request)
			return
		}
		if err != nil {
			writeInternal(response, request)
			return
		}

		// OpenFang owns execution, so it is updated first. An empty prompt is
		// sent explicitly rather than omitted: omitting it would leave the old
		// prompt in place, which is the opposite of clearing.
		prompt := ""
		if value != nil {
			prompt = *value
		}
		if err := options.Configurer.PatchAgent(
			request.Context(),
			found.OpenFangAgentID,
			openfang.PatchAgentRequest{SystemPrompt: &prompt},
		); err != nil {
			writeDependencyError(response, request, err)
			return
		}

		writer, ok := store.(InstructionsStore)
		if !ok {
			writeInternal(response, request)
			return
		}
		if err := writer.SetInstructions(
			request.Context(), agentID, scope.WorkspaceID, value,
		); err != nil {
			if errors.Is(err, ErrNotFound) {
				writeNotFound(response, request)
				return
			}
			writeInternal(response, request)
			return
		}

		refreshed, err := store.Get(request.Context(), agentID, scope.WorkspaceID)
		if err != nil {
			writeInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, serialize(refreshed))
	}
}
