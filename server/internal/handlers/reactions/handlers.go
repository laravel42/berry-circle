// Package reactions exposes issue and comment emoji-reaction subrouters.
package reactions

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	shared "github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	repository "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Store is the narrow persistence surface consumed by reaction HTTP handlers.
type Store interface {
	AddIssueReaction(
		context.Context,
		uuid.UUID,
		string,
		string,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) (repository.Reaction, repository.Event, error)
	AddCommentReaction(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		string,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) (repository.Reaction, repository.Event, error)
	RemoveIssueReaction(
		context.Context,
		uuid.UUID,
		string,
		string,
		uuid.UUID,
		time.Time,
	) (repository.Event, error)
	RemoveCommentReaction(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		string,
		uuid.UUID,
		time.Time,
	) (repository.Event, error)
	ListIssueReactions(
		context.Context,
		uuid.UUID,
		string,
		*repository.ReactionCursor,
		int,
	) ([]repository.Reaction, error)
	ListCommentReactions(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		*repository.ReactionCursor,
		int,
	) ([]repository.Reaction, error)
}

// Options are explicit dependencies shared by both subrouters.
type Options struct {
	Store            Store
	Sessions         auth.SessionResolver
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Broadcaster      realtime.Broadcaster
}

// NewIssueHandler returns routes mounted at
// /api/v1/issues/{issueRef}/reactions.
func NewIssueHandler(options Options) (http.Handler, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", listHandler(options, repository.TargetIssue))
	router.Post(
		"/",
		shared.RequireJSONIdempotency(
			options.IdempotencyStore,
			options.Clock,
			http.HandlerFunc(addHandler(options, repository.TargetIssue)),
		).ServeHTTP,
	)
	router.Delete("/", removeHandler(options, repository.TargetIssue))
	return router, nil
}

// NewCommentHandler returns routes mounted at
// /api/v1/comments/{commentId}/reactions.
func NewCommentHandler(options Options) (http.Handler, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", listHandler(options, repository.TargetComment))
	router.Post(
		"/",
		shared.RequireJSONIdempotency(
			options.IdempotencyStore,
			options.Clock,
			http.HandlerFunc(addHandler(options, repository.TargetComment)),
		).ServeHTTP,
	)
	router.Delete("/", removeHandler(options, repository.TargetComment))
	return router, nil
}

func validateOptions(options Options) error {
	switch {
	case options.Store == nil:
		return errors.New("reaction handler store is nil")
	case options.Sessions == nil:
		return errors.New("reaction handler session resolver is nil")
	case options.Clock == nil:
		return errors.New("reaction handler clock is nil")
	case options.NewID == nil:
		return errors.New("reaction handler ID generator is nil")
	case options.IdempotencyStore == nil:
		return errors.New("reaction handler idempotency store is nil")
	case options.Broadcaster == nil:
		return errors.New("reaction handler broadcaster is nil")
	default:
		return nil
	}
}

type reactionBody struct {
	Emoji *string `json:"emoji"`
}

type actorResource struct {
	Type      string    `json:"type"`
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	AvatarURL *string   `json:"avatarUrl"`
}

type reactionResource struct {
	ID        uuid.UUID     `json:"id"`
	Emoji     string        `json:"emoji"`
	Actor     actorResource `json:"actor"`
	CreatedAt string        `json:"createdAt"`
}

type pageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type reactionConnection struct {
	Nodes    []reactionResource `json:"nodes"`
	PageInfo pageInfo           `json:"pageInfo"`
}

func addHandler(options Options, kind repository.TargetKind) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		emoji, ok := parseEmojiBody(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		now := options.Clock().UTC()
		var (
			reaction repository.Reaction
			event    repository.Event
			err      error
		)
		switch kind {
		case repository.TargetIssue:
			reaction, event, err = options.Store.AddIssueReaction(
				request.Context(),
				user.ID,
				chi.URLParam(request, "issueRef"),
				emoji,
				options.NewID(),
				options.NewID(),
				now,
			)
		case repository.TargetComment:
			commentID, valid := parseCommentID(response, request)
			if !valid {
				return
			}
			reaction, event, err = options.Store.AddCommentReaction(
				request.Context(),
				user.ID,
				commentID,
				emoji,
				options.NewID(),
				options.NewID(),
				now,
			)
		default:
			err = errors.New("invalid reaction target")
		}
		if err != nil {
			shared.WriteRepositoryError(response, request, err, targetName(kind))
			return
		}
		shared.Publish(request.Context(), options.Broadcaster, event)
		httpapi.WriteJSON(response, http.StatusCreated, serializeReaction(reaction))
	}
}

func removeHandler(options Options, kind repository.TargetKind) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		emoji, ok := parseEmojiBody(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		var (
			event repository.Event
			err   error
		)
		switch kind {
		case repository.TargetIssue:
			event, err = options.Store.RemoveIssueReaction(
				request.Context(),
				user.ID,
				chi.URLParam(request, "issueRef"),
				emoji,
				options.NewID(),
				options.Clock().UTC(),
			)
		case repository.TargetComment:
			commentID, valid := parseCommentID(response, request)
			if !valid {
				return
			}
			event, err = options.Store.RemoveCommentReaction(
				request.Context(),
				user.ID,
				commentID,
				emoji,
				options.NewID(),
				options.Clock().UTC(),
			)
		default:
			err = errors.New("invalid reaction target")
		}
		if err != nil {
			shared.WriteRepositoryError(response, request, err, targetName(kind))
			return
		}
		shared.Publish(request.Context(), options.Broadcaster, event)
		response.WriteHeader(http.StatusNoContent)
	}
}

func listHandler(options Options, kind repository.TargetKind) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		first, encodedAfter, ok := parsePage(response, request)
		if !ok {
			return
		}
		scope := reactionCursorScope(kind, routeTarget(request, kind))
		var after *repository.ReactionCursor
		if encodedAfter != "" {
			var decoded repository.ReactionCursor
			if err := httpapi.DecodeCursor(encodedAfter, scope, &decoded); err != nil ||
				decoded.ID == uuid.Nil || decoded.CreatedAt.IsZero() {
				writeInvalidCursor(response, request)
				return
			}
			after = &decoded
		}
		user := auth.MustUser(request.Context())
		var (
			rows []repository.Reaction
			err  error
		)
		switch kind {
		case repository.TargetIssue:
			rows, err = options.Store.ListIssueReactions(
				request.Context(),
				user.ID,
				chi.URLParam(request, "issueRef"),
				after,
				first+1,
			)
		case repository.TargetComment:
			commentID, valid := parseCommentID(response, request)
			if !valid {
				return
			}
			rows, err = options.Store.ListCommentReactions(
				request.Context(),
				user.ID,
				commentID,
				after,
				first+1,
			)
		default:
			err = errors.New("invalid reaction target")
		}
		if err != nil {
			shared.WriteRepositoryError(response, request, err, targetName(kind))
			return
		}
		hasNextPage := len(rows) > first
		if hasNextPage {
			rows = rows[:first]
		}
		nodes := make([]reactionResource, 0, len(rows))
		for _, row := range rows {
			nodes = append(nodes, serializeReaction(row))
		}
		var endCursor *string
		if len(rows) > 0 {
			last := rows[len(rows)-1]
			encoded, err := httpapi.EncodeCursor(scope, repository.ReactionCursor{
				CreatedAt: last.CreatedAt,
				ID:        last.ID,
			})
			if err != nil {
				shared.WriteRepositoryError(response, request, err, targetName(kind))
				return
			}
			endCursor = &encoded
		}
		httpapi.WriteJSON(response, http.StatusOK, reactionConnection{
			Nodes: nodes,
			PageInfo: pageInfo{
				HasNextPage: hasNextPage,
				EndCursor:   endCursor,
			},
		})
	}
}

func parseEmojiBody(
	response http.ResponseWriter,
	request *http.Request,
) (string, bool) {
	var body reactionBody
	if !shared.DecodeJSON(response, request, &body, shared.MaxJSONBodyBytes) {
		return "", false
	}
	if body.Emoji == nil {
		shared.WriteValidation(response, request, httpapi.FieldError{
			Path:    "/emoji",
			Code:    "invalid_type",
			Message: "Field is required.",
		})
		return "", false
	}
	if !validEmoji(*body.Emoji) {
		shared.WriteValidation(response, request, httpapi.FieldError{
			Path:    "/emoji",
			Code:    "invalid_string",
			Message: "emoji must be one bounded Unicode emoji sequence.",
		})
		return "", false
	}
	return *body.Emoji, true
}

func validEmoji(value string) bool {
	if value == "" || len(value) > 64 || strings.TrimSpace(value) != value ||
		!utf8.ValidString(value) || utf8.RuneCountInString(value) > 16 {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.IsSpace(character) {
			return false
		}
	}
	runes := []rune(value)
	if validKeycapEmoji(runes) {
		return true
	}
	if len(runes) == 2 && isRegionalIndicator(runes[0]) &&
		isRegionalIndicator(runes[1]) {
		return true
	}
	index, ok := consumeEmojiComponent(runes, 0)
	if !ok {
		return false
	}
	for index < len(runes) {
		if runes[index] != '\u200d' {
			return false
		}
		index, ok = consumeEmojiComponent(runes, index+1)
		if !ok {
			return false
		}
	}
	return true
}

func validKeycapEmoji(value []rune) bool {
	if len(value) == 2 {
		return isKeycapBase(value[0]) && value[1] == '\u20e3'
	}
	return len(value) == 3 && isKeycapBase(value[0]) &&
		value[1] == '\ufe0f' && value[2] == '\u20e3'
}

func isKeycapBase(value rune) bool {
	return value == '#' || value == '*' || value >= '0' && value <= '9'
}

func consumeEmojiComponent(value []rune, start int) (int, bool) {
	if start >= len(value) || !isEmojiBase(value[start]) {
		return start, false
	}
	base := value[start]
	index := start + 1
	if index < len(value) && value[index] == '\ufe0f' {
		index++
	}
	if index < len(value) && isEmojiModifier(value[index]) {
		index++
	}
	if base == '\U0001f3f4' && index < len(value) && isEmojiTag(value[index]) {
		for index < len(value) && isEmojiTag(value[index]) {
			index++
		}
		if index >= len(value) || value[index] != '\U000e007f' {
			return start, false
		}
		index++
	}
	return index, true
}

func isEmojiBase(value rune) bool {
	if isRegionalIndicator(value) || isEmojiModifier(value) {
		return false
	}
	switch {
	case value == '\u00a9' || value == '\u00ae' ||
		value == '\u203c' || value == '\u2049' ||
		value == '\u2122' || value == '\u2139' ||
		value == '\u3030' || value == '\u303d' ||
		value == '\u3297' || value == '\u3299':
		return true
	case value >= '\u2190' && value <= '\u21ff':
		return true
	case value >= '\u2300' && value <= '\u23ff':
		return true
	case value >= '\u25a0' && value <= '\u27bf':
		return true
	case value >= '\u2b00' && value <= '\u2bff':
		return true
	case value >= '\U0001f000' && value <= '\U0001faff':
		return true
	default:
		return false
	}
}

func isRegionalIndicator(value rune) bool {
	return value >= '\U0001f1e6' && value <= '\U0001f1ff'
}

func isEmojiModifier(value rune) bool {
	return value >= '\U0001f3fb' && value <= '\U0001f3ff'
}

func isEmojiTag(value rune) bool {
	return value >= '\U000e0020' && value <= '\U000e007e'
}

func parsePage(
	response http.ResponseWriter,
	request *http.Request,
) (int, string, bool) {
	query := request.URL.Query()
	for name, values := range query {
		if (name != "first" && name != "after") || len(values) != 1 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				nil,
			)
			return 0, "", false
		}
	}
	first := 50
	if raw := query.Get("first"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 100 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				httpapi.ValidationDetails{Fields: []httpapi.FieldError{{
					Path:    "/query/first",
					Code:    "invalid",
					Message: "first must be an integer from 1 to 100.",
				}}},
			)
			return 0, "", false
		}
		first = value
	}
	after := query.Get("after")
	if _, present := query["after"]; present && after == "" {
		writeInvalidCursor(response, request)
		return 0, "", false
	}
	return first, after, true
}

func parseCommentID(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, bool) {
	id, err := core.ParseUUID(chi.URLParam(request, "commentId"))
	if err != nil {
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			"Comment not found.",
			nil,
		)
		return uuid.Nil, false
	}
	return id, true
}

func serializeReaction(reaction repository.Reaction) reactionResource {
	return reactionResource{
		ID:    reaction.ID,
		Emoji: reaction.Emoji,
		Actor: actorResource{
			Type:      "user",
			ID:        reaction.Actor.ID,
			Name:      reaction.Actor.Name,
			AvatarURL: reaction.Actor.AvatarURL,
		},
		CreatedAt: reaction.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func targetName(kind repository.TargetKind) string {
	if kind == repository.TargetComment {
		return "Comment"
	}
	return "Issue"
}

func routeTarget(request *http.Request, kind repository.TargetKind) string {
	if kind == repository.TargetComment {
		return chi.URLParam(request, "commentId")
	}
	return strings.ToLower(chi.URLParam(request, "issueRef"))
}

func reactionCursorScope(kind repository.TargetKind, target string) string {
	sum := sha256.Sum256([]byte(string(kind) + ":" + target))
	return fmt.Sprintf("reactions.list.%x", sum[:8])
}

func writeInvalidCursor(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_CURSOR",
		"The pagination cursor is invalid.",
		nil,
	)
}
