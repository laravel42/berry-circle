package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
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

// maxDescription matches the agents.description column's existing bound.
const maxDescription = 5000

// configRequest carries the agent configuration Berry authors. A nil field is
// left unchanged; an empty string clears the value.
type configRequest struct {
	Instructions *string `json:"instructions"`
	Description  *string `json:"description"`
	// Provider and Model are set together. A model id only means something
	// against the provider serving it, so accepting one alone would store a
	// pairing the runtime cannot resolve.
	Provider *string `json:"provider"`
	Model    *string `json:"model"`
	// Skills are Berry-authored capability names (lowercase letters, digits
	// and dashes) the planner matches issues against. Sending the list
	// replaces it; omitting it leaves it alone.
	Skills *[]string `json:"skills"`
}

// maxSkills bounds the authored list; a vocabulary past this is a taxonomy,
// not a set of skills.
const maxSkills = 50

// ConfigStore is the durable seam for authored agent configuration.
type ConfigStore interface {
	SetConfig(ctx context.Context, agentID, workspaceID uuid.UUID, config StoredConfig) error
}

// StoredConfig is the authored configuration Berry persists. A nil field means
// "leave as it is", which is why these stay pointers rather than strings.
type StoredConfig struct {
	Instructions *string
	Description  *string
	Skills       *[]string
}

// SetInstructions persists the authored prompt and stamps when it was last
// pushed upstream. The stamp is what distinguishes an edit that reached
// OpenFang from one that only ever landed locally.
func (store PostgresStore) SetConfig(
	ctx context.Context,
	agentID, workspaceID uuid.UUID,
	config StoredConfig,
) error {
	if store.Pool == nil {
		return errors.New("agent store pool is nil")
	}
	// COALESCE on the parameter leaves an unsent field untouched, so writing
	// one field cannot silently blank the other.
	tag, err := store.Pool.Exec(
		ctx,
		`UPDATE agents
		    SET instructions = CASE WHEN $4 THEN $3 ELSE instructions END,
		        description  = CASE WHEN $6 THEN $5 ELSE description END,
		        skills       = CASE WHEN $8 THEN COALESCE($7::text[], ARRAY[]::text[]) ELSE skills END,
		        instructions_synced_at = CASE
		            WHEN $4 THEN now() ELSE instructions_synced_at END,
		        updated_at = now()
		  WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
		agentID,
		workspaceID,
		config.Instructions,
		config.Instructions != nil,
		config.Description,
		config.Description != nil,
		derefSkills(config.Skills),
		config.Skills != nil,
	)
	if err != nil {
		return errors.New("persist agent instructions")
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// configHandler writes the agent configuration Berry authors.
//
// Order matters: the runtime is updated before Berry records the value. If the
// upstream call fails, nothing is stored, so the editor never shows a prompt
// the agent is not actually running with. The reverse order would let a save
// look successful while the agent kept its old behaviour.
func configHandler(store Store, options Options) http.HandlerFunc {
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

		var body configRequest
		decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxInstructions*2))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil {
			httpapi.WriteError(
				response, request, http.StatusBadRequest,
				"INVALID_BODY", "Request body is not valid JSON.", nil,
			)
			return
		}

		// A field the caller omitted is left alone; a field sent empty is
		// cleared. Conflating the two would make "leave unchanged" and "erase"
		// the same request.
		normalise := func(raw *string, limit int, code string) (*string, bool) {
			if raw == nil {
				return nil, true
			}
			trimmed := strings.TrimSpace(*raw)
			if utf8.RuneCountInString(trimmed) > limit {
				httpapi.WriteError(
					response, request, http.StatusBadRequest,
					code, "Value exceeds the maximum length.", nil,
				)
				return nil, false
			}
			return &trimmed, true
		}

		if (body.Provider == nil) != (body.Model == nil) {
			httpapi.WriteError(
				response, request, http.StatusBadRequest,
				"MODEL_PAIR_REQUIRED",
				"Provider and model must be set together.", nil,
			)
			return
		}

		instructions, ok := normalise(body.Instructions, maxInstructions, "INSTRUCTIONS_TOO_LONG")
		if !ok {
			return
		}
		description, ok := normalise(body.Description, maxDescription, "DESCRIPTION_TOO_LONG")
		if !ok {
			return
		}
		var provider, model *string
		if body.Provider != nil && body.Model != nil {
			// Refused at selection rather than discovered on the agent's next
			// task, which is the only other place a bad pair would surface.
			if _, ok := resolveModel(
				request.Context(), options.Catalog, *body.Provider, *body.Model,
			); !ok {
				httpapi.WriteError(
					response, request, http.StatusBadRequest,
					"MODEL_UNAVAILABLE",
					"That model is not available on this runtime.", nil,
				)
				return
			}
			provider, model = body.Provider, body.Model
		}

		var skills *[]string
		if body.Skills != nil {
			normalised, ok := normaliseSkills(*body.Skills)
			if !ok {
				httpapi.WriteError(
					response, request, http.StatusBadRequest,
					"SKILLS_INVALID",
					"Skills are up to 50 names of lowercase letters, digits and dashes.", nil,
				)
				return
			}
			skills = &normalised
		}

		if instructions == nil && description == nil && model == nil && skills == nil {
			httpapi.WriteError(
				response, request, http.StatusBadRequest,
				"NO_FIELDS", "No configuration fields were provided.", nil,
			)
			return
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

		// OpenFang owns execution, so it is updated first. Only fields the
		// caller sent are forwarded, so writing one cannot blank the other
		// upstream. Skills are Berry's own vocabulary and never travel
		// upstream, so a skills-only save skips the runtime.
		if instructions != nil || description != nil || model != nil {
			if err := options.Configurer.PatchAgent(
				request.Context(),
				found.OpenFangAgentID,
				openfang.PatchAgentRequest{
					SystemPrompt: instructions,
					Description:  description,
					Provider:     provider,
					Model:        model,
				},
			); err != nil {
				writeDependencyError(response, request, err)
				return
			}
		}

		writer, ok := store.(ConfigStore)
		if !ok {
			writeInternal(response, request)
			return
		}
		if err := writer.SetConfig(
			request.Context(),
			agentID,
			scope.WorkspaceID,
			StoredConfig{Instructions: instructions, Description: description, Skills: skills},
		); err != nil {
			if errors.Is(err, ErrNotFound) {
				writeNotFound(response, request)
				return
			}
			writeInternal(response, request)
			return
		}

		// The model is projected from the runtime rather than written locally,
		// so a successful patch is read back rather than assumed.
		refreshed, err := store.Get(request.Context(), agentID, scope.WorkspaceID)
		if err != nil {
			writeInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, serialize(refreshed))
	}
}

var skillPattern = regexp.MustCompile(`^[a-z0-9-]{1,50}$`)

// normaliseSkills trims, lowercases, de-duplicates and sorts the list, and
// refuses anything outside the planner's capability grammar.
func normaliseSkills(values []string) ([]string, bool) {
	if len(values) > maxSkills {
		return nil, false
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		skill := strings.ToLower(strings.TrimSpace(value))
		if !skillPattern.MatchString(skill) {
			return nil, false
		}
		if _, ok := seen[skill]; ok {
			continue
		}
		seen[skill] = struct{}{}
		out = append(out, skill)
	}
	sort.Strings(out)
	return out, true
}

func derefSkills(values *[]string) []string {
	if values == nil {
		return nil
	}
	return *values
}
