package identityhandler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

type profileResource struct {
	ID          uuid.UUID                `json:"id"`
	Email       string                   `json:"email"`
	Name        string                   `json:"name"`
	AvatarURL   *string                  `json:"avatarUrl"`
	Settings    identity.UserSettings    `json:"settings"`
	Onboarding  identity.OnboardingState `json:"onboarding"`
	OnboardedAt *string                  `json:"onboardedAt"`
	CreatedAt   string                   `json:"createdAt"`
	UpdatedAt   string                   `json:"updatedAt"`
}

type bootstrapResource struct {
	User               profileResource     `json:"user"`
	Workspaces         []workspaceResource `json:"workspaces"`
	CurrentWorkspaceID *uuid.UUID          `json:"currentWorkspaceId"`
}

func (handlers *handlers) bootstrap(
	response http.ResponseWriter,
	request *http.Request,
) {
	result, err := handlers.service.Bootstrap(request.Context(), currentUser(request).ID)
	if err != nil {
		writeDomainError(response, request, err, "User")
		return
	}
	workspaces := make([]workspaceResource, 0, len(result.Workspaces))
	for _, workspace := range result.Workspaces {
		workspaces = append(workspaces, serializeWorkspace(workspace))
	}
	httpapi.WriteJSON(response, http.StatusOK, bootstrapResource{
		User:               serializeProfile(result.Profile),
		Workspaces:         workspaces,
		CurrentWorkspaceID: result.CurrentWorkspaceID,
	})
}

func (handlers *handlers) getProfile(
	response http.ResponseWriter,
	request *http.Request,
) {
	profile, err := handlers.service.GetProfile(request.Context(), currentUser(request).ID)
	if err != nil {
		writeDomainError(response, request, err, "User")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeProfile(profile))
}

type profilePatchBody struct {
	Name      *string         `json:"name"`
	AvatarURL json.RawMessage `json:"avatarUrl"`
}

func (handlers *handlers) updateProfile(
	response http.ResponseWriter,
	request *http.Request,
) {
	body, _, ok := decodeBody[profilePatchBody](response, request)
	if !ok {
		return
	}
	patch := identity.ProfilePatch{Name: body.Name}
	fields := make([]httpapi.FieldError, 0)
	if body.Name != nil {
		trimmed := strings.TrimSpace(*body.Name)
		if !validBounded(trimmed, 1, 100) {
			fields = append(fields, fieldError(
				"/name",
				"invalid_length",
				"Name must contain 1 to 100 characters.",
			))
		} else {
			patch.Name = &trimmed
		}
	}
	if body.AvatarURL != nil {
		patch.AvatarURLSet = true
		if !bytes.Equal(bytes.TrimSpace(body.AvatarURL), []byte("null")) {
			var avatar string
			if err := json.Unmarshal(body.AvatarURL, &avatar); err != nil ||
				!validAvatar(avatar) {
				fields = append(fields, fieldError(
					"/avatarUrl",
					"invalid_url",
					"Avatar URL must be null or an absolute HTTP(S) URL.",
				))
			} else {
				patch.AvatarURL = &avatar
			}
		}
	}
	if patch.Name == nil && !patch.AvatarURLSet {
		fields = append(fields, fieldError(
			"/",
			"empty_patch",
			"At least one profile field is required.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	profile, err := handlers.service.UpdateProfile(
		request.Context(),
		currentUser(request).ID,
		patch,
	)
	if err != nil {
		writeDomainError(response, request, err, "User")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeProfile(profile))
}

func (handlers *handlers) getUserSettings(
	response http.ResponseWriter,
	request *http.Request,
) {
	profile, err := handlers.service.GetProfile(request.Context(), currentUser(request).ID)
	if err != nil {
		writeDomainError(response, request, err, "User")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, profile.Settings)
}

type userSettingsPatchBody struct {
	Theme         *string `json:"theme"`
	Timezone      *string `json:"timezone"`
	ReducedMotion *bool   `json:"reducedMotion"`
}

func (handlers *handlers) updateUserSettings(
	response http.ResponseWriter,
	request *http.Request,
) {
	body, _, ok := decodeBody[userSettingsPatchBody](response, request)
	if !ok {
		return
	}
	fields := make([]httpapi.FieldError, 0)
	if body.Theme != nil &&
		*body.Theme != "system" && *body.Theme != "light" && *body.Theme != "dark" {
		fields = append(fields, fieldError(
			"/theme",
			"invalid_enum_value",
			"Theme must be system, light, or dark.",
		))
	}
	if body.Timezone != nil && !validTimezone(*body.Timezone) {
		fields = append(fields, fieldError(
			"/timezone",
			"invalid_timezone",
			"Timezone must be a valid IANA timezone.",
		))
	}
	if body.Theme == nil && body.Timezone == nil && body.ReducedMotion == nil {
		fields = append(fields, fieldError(
			"/",
			"empty_patch",
			"At least one setting is required.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	settings, err := handlers.service.UpdateUserSettings(
		request.Context(),
		currentUser(request).ID,
		identity.UserSettingsPatch{
			Theme:         body.Theme,
			Timezone:      body.Timezone,
			ReducedMotion: body.ReducedMotion,
		},
	)
	if err != nil {
		writeDomainError(response, request, err, "User")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, settings)
}

func (handlers *handlers) getOnboarding(
	response http.ResponseWriter,
	request *http.Request,
) {
	profile, err := handlers.service.GetProfile(request.Context(), currentUser(request).ID)
	if err != nil {
		writeDomainError(response, request, err, "User")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, profile.Onboarding)
}

type onboardingPatchBody struct {
	Step      *string            `json:"step"`
	Answers   *map[string]string `json:"answers"`
	Skipped   *bool              `json:"skipped"`
	Completed *bool              `json:"completed"`
}

func (handlers *handlers) updateOnboarding(
	response http.ResponseWriter,
	request *http.Request,
) {
	body, _, ok := decodeBody[onboardingPatchBody](response, request)
	if !ok {
		return
	}
	if body.Step == nil && body.Answers == nil &&
		body.Skipped == nil && body.Completed == nil {
		writeValidation(response, request, fieldError(
			"/",
			"empty_patch",
			"At least one onboarding field is required.",
		))
		return
	}
	profile, err := handlers.service.GetProfile(request.Context(), currentUser(request).ID)
	if err != nil {
		writeDomainError(response, request, err, "User")
		return
	}
	next := profile.Onboarding
	next.Version = 1
	if next.Answers == nil {
		next.Answers = map[string]string{}
	}
	fields := make([]httpapi.FieldError, 0)
	if body.Step != nil {
		switch *body.Step {
		case "welcome", "aboutYou", "workspace", "complete":
			next.Step = *body.Step
		default:
			fields = append(fields, fieldError(
				"/step",
				"invalid_enum_value",
				"Step must be welcome, aboutYou, workspace, or complete.",
			))
		}
	}
	if body.Answers != nil {
		if len(*body.Answers) > 10 {
			fields = append(fields, fieldError(
				"/answers",
				"too_many",
				"At most 10 onboarding answers are accepted.",
			))
		} else {
			allowed := map[string]struct{}{
				"role": {}, "teamSize": {}, "goal": {}, "source": {},
			}
			next.Answers = make(map[string]string, len(*body.Answers))
			for key, value := range *body.Answers {
				trimmed := strings.TrimSpace(value)
				if _, exists := allowed[key]; !exists ||
					!validBounded(trimmed, 1, 500) {
					fields = append(fields, fieldError(
						"/answers/"+key,
						"invalid",
						"Answer key or value is not supported.",
					))
					continue
				}
				next.Answers[key] = trimmed
			}
		}
	}
	if body.Skipped != nil {
		next.Skipped = *body.Skipped
	}
	if body.Completed != nil {
		next.Completed = *body.Completed
	}
	if next.Skipped {
		next.Completed = true
	}
	if next.Completed {
		next.Step = "complete"
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	state, _, err := handlers.service.UpdateOnboarding(
		request.Context(),
		currentUser(request).ID,
		next,
	)
	if err != nil {
		writeDomainError(response, request, err, "User")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, state)
}

func serializeProfile(profile identity.Profile) profileResource {
	var onboardedAt *string
	if profile.OnboardedAt != nil {
		value := profile.OnboardedAt.UTC().Format(time.RFC3339Nano)
		onboardedAt = &value
	}
	return profileResource{
		ID:          profile.ID,
		Email:       profile.Email,
		Name:        profile.Name,
		AvatarURL:   profile.AvatarURL,
		Settings:    profile.Settings,
		Onboarding:  profile.Onboarding,
		OnboardedAt: onboardedAt,
		CreatedAt:   profile.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   profile.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}
