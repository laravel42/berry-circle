// Package conversations exposes Berry's chat threads.
//
// A thread with an agent is where an agent is actually talked to, as opposed to
// the run pipeline, where one is dispatched at an issue. The two use different
// upstream endpoints deliberately: runs stream so tool activity stays visible,
// chat blocks because the caller is waiting on a finished reply.
package conversations

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	convrepo "github.com/laravel42/berry-circle/server/internal/repository/conversations"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// maxMessage bounds one turn. Generous for chat, far below the manifest limit.
const maxMessage = 8000

// Store is the durable seam. Implemented by *conversations.Repository.
type Store interface {
	List(context.Context, uuid.UUID, uuid.UUID, int) ([]convrepo.Summary, error)
	Messages(context.Context, uuid.UUID, uuid.UUID, int) ([]convrepo.Message, error)
	// AssertParticipant is the authorization boundary for a thread. Workspace
	// scope alone is not enough: a direct thread is private to the people in
	// it, and a colleague has no more claim on it than a stranger.
	AssertParticipant(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
	EnsureAgentThread(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, time.Time) (uuid.UUID, error)
	Append(context.Context, uuid.UUID, string, *uuid.UUID, string, time.Time) (uuid.UUID, error)
	AgentFor(context.Context, uuid.UUID, uuid.UUID) (uuid.UUID, uuid.UUID, error)
}

// Responder runs one agent turn. Narrow on purpose: chat may talk to an agent,
// never spawn or reconfigure one.
type Responder interface {
	SendAgentMessage(context.Context, uuid.UUID, openfang.MessageRequest) (openfang.AgentReply, error)
}

// Options carries every dependency explicitly.
type Options struct {
	Store     Store
	Responder Responder
	Sessions  auth.SessionResolver
	Clock     func() time.Time
	Logger    *slog.Logger
}

// NewMount validates dependencies so a misconfigured deployment fails at boot.
func NewMount(options Options) (httpapi.Mount, error) {
	switch {
	case options.Store == nil:
		return httpapi.Mount{}, errors.New("conversation store is nil")
	case options.Sessions == nil:
		return httpapi.Mount{}, errors.New("conversation session resolver is nil")
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}

	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", listHandler(options))
	router.Post("/agents/{agentId}", openAgentThreadHandler(options))
	router.Get("/{conversationId}/messages", messagesHandler(options))
	router.Post("/{conversationId}/messages", sendHandler(options))
	return httpapi.Mount{Prefix: "/api/v1/conversations", Handler: router}, nil
}

type summaryResource struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	Topic        string  `json:"topic"`
	AgentID      *string `json:"agentId"`
	AgentName    *string `json:"agentName"`
	MessageCount int     `json:"messageCount"`
	UpdatedAt    string  `json:"updatedAt"`
}

type messageResource struct {
	ID         string `json:"id"`
	AuthorType string `json:"authorType"`
	AuthorName string `json:"authorName"`
	Body       string `json:"body"`
	Channel    string `json:"channel"`
	CreatedAt  string `json:"createdAt"`
}

func listHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, ok := workspaceOf(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		found, err := options.Store.List(request.Context(), workspaceID, user.ID, 100)
		if err != nil {
			writeInternal(response, request)
			return
		}
		nodes := make([]summaryResource, 0, len(found))
		for _, item := range found {
			nodes = append(nodes, summaryResource{
				ID:           item.ID.String(),
				Kind:         item.Kind,
				Topic:        item.Topic,
				AgentID:      uuidPtr(item.AgentID),
				AgentName:    item.AgentName,
				MessageCount: item.MessageCount,
				UpdatedAt:    item.UpdatedAt.UTC().Format(time.RFC3339Nano),
			})
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
	}
}

// openAgentThreadHandler returns the caller's thread with an agent, opening one
// on first contact. Idempotent: talking to the same agent twice continues one
// conversation rather than starting a second.
func openAgentThreadHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, ok := workspaceOf(response, request)
		if !ok {
			return
		}
		agentID, err := core.ParseUUID(chi.URLParam(request, "agentId"))
		if err != nil {
			httpapi.WriteError(response, request, http.StatusNotFound,
				"NOT_FOUND", "Agent not found.", nil)
			return
		}
		user := auth.MustUser(request.Context())
		conversationID, err := options.Store.EnsureAgentThread(
			request.Context(), workspaceID, user.ID, agentID, options.Clock().UTC(),
		)
		if errors.Is(err, convrepo.ErrAgentNotFound) {
			httpapi.WriteError(response, request, http.StatusNotFound,
				"NOT_FOUND", "Agent not found.", nil)
			return
		}
		if err != nil {
			writeInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{
			"id": conversationID.String(),
		})
	}
}

func messagesHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, ok := workspaceOf(response, request)
		if !ok {
			return
		}
		conversationID, err := core.ParseUUID(chi.URLParam(request, "conversationId"))
		if err != nil {
			httpapi.WriteError(response, request, http.StatusNotFound,
				"NOT_FOUND", "Conversation not found.", nil)
			return
		}
		user := auth.MustUser(request.Context())
		if err := options.Store.AssertParticipant(
			request.Context(), workspaceID, conversationID, user.ID,
		); err != nil {
			// Not found rather than forbidden: probing ids should reveal
			// nothing about which conversations exist.
			httpapi.WriteError(response, request, http.StatusNotFound,
				"NOT_FOUND", "Conversation not found.", nil)
			return
		}
		found, err := options.Store.Messages(request.Context(), workspaceID, conversationID, 200)
		if err != nil {
			writeInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{
			"nodes": serializeMessages(found),
		})
	}
}

// sendHandler records the user's turn, then the agent's reply.
//
// The user's message is committed before the agent is called, so a runtime
// failure loses the answer but never the question — the thread still shows what
// was asked, and the error explains why nothing came back.
func sendHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, ok := workspaceOf(response, request)
		if !ok {
			return
		}
		conversationID, err := core.ParseUUID(chi.URLParam(request, "conversationId"))
		if err != nil {
			httpapi.WriteError(response, request, http.StatusNotFound,
				"NOT_FOUND", "Conversation not found.", nil)
			return
		}

		var body struct {
			Body string `json:"body"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxMessage*2))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil {
			httpapi.WriteError(response, request, http.StatusBadRequest,
				"INVALID_BODY", "Request body is not valid JSON.", nil)
			return
		}
		text := strings.TrimSpace(body.Body)
		if text == "" || utf8.RuneCountInString(text) > maxMessage {
			httpapi.WriteError(response, request, http.StatusBadRequest,
				"INVALID_MESSAGE", "Message must be between 1 and 8000 characters.", nil)
			return
		}

		user := auth.MustUser(request.Context())
		// Checked before any mutation: Append is keyed only by conversation id,
		// so without this a caller could inject a turn into any thread in any
		// workspace by guessing a UUID.
		if err := options.Store.AssertParticipant(
			request.Context(), workspaceID, conversationID, user.ID,
		); err != nil {
			httpapi.WriteError(response, request, http.StatusNotFound,
				"NOT_FOUND", "Conversation not found.", nil)
			return
		}
		userID := user.ID
		now := options.Clock().UTC()
		if _, err := options.Store.Append(
			request.Context(), conversationID, "user", &userID, text, now,
		); err != nil {
			writeInternal(response, request)
			return
		}

		agentID, upstreamID, err := options.Store.AgentFor(
			request.Context(), workspaceID, conversationID,
		)
		if errors.Is(err, convrepo.ErrAgentNotFound) {
			// A thread between people. The turn is recorded; there is nobody to
			// answer automatically.
			httpapi.WriteJSON(response, http.StatusOK, map[string]any{"replied": false})
			return
		}
		if err != nil || options.Responder == nil {
			writeInternal(response, request)
			return
		}

		senderID := "berry-user:" + userID.String()
		senderName := user.Name
		reply, err := options.Responder.SendAgentMessage(
			request.Context(), upstreamID,
			openfang.MessageRequest{
				Message:    text,
				SenderID:   &senderID,
				SenderName: &senderName,
			},
		)
		if err != nil {
			options.Logger.Warn("agent reply failed", "conversationId", conversationID, "error", err)
			httpapi.WriteError(response, request, http.StatusBadGateway,
				"AGENT_UNAVAILABLE",
				"The agent could not be reached. Your message was saved.", nil)
			return
		}
		answer := strings.TrimSpace(reply.Response)
		if answer == "" {
			answer = "(the agent returned an empty reply)"
		}
		if _, err := options.Store.Append(
			request.Context(), conversationID, "agent", &agentID, answer,
			options.Clock().UTC(),
		); err != nil {
			writeInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{
			"replied":      true,
			"inputTokens":  reply.InputTokens,
			"outputTokens": reply.OutputTokens,
		})
	}
}

func serializeMessages(found []convrepo.Message) []messageResource {
	nodes := make([]messageResource, 0, len(found))
	for _, item := range found {
		nodes = append(nodes, messageResource{
			ID:         item.ID.String(),
			AuthorType: item.AuthorType,
			AuthorName: item.AuthorName,
			Body:       item.Body,
			Channel:    item.Channel,
			CreatedAt:  item.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	return nodes
}

func workspaceOf(response http.ResponseWriter, request *http.Request) (uuid.UUID, bool) {
	user := auth.MustUser(request.Context())
	if user.CurrentWorkspaceID == nil {
		httpapi.WriteError(response, request, http.StatusNotFound,
			"WORKSPACE_NOT_FOUND", "No active workspace.", nil)
		return uuid.Nil, false
	}
	return *user.CurrentWorkspaceID, true
}

func uuidPtr(id *uuid.UUID) *string {
	if id == nil {
		return nil
	}
	value := id.String()
	return &value
}

func writeInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(response, request, http.StatusInternalServerError,
		"INTERNAL", "Internal server error.", nil)
}
