package projects

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	projectrepo "github.com/laravel42/berry-circle/server/internal/repository/projects"
)

type createProjectBody struct {
	WorkspaceID workmanagement.Optional[string]               `json:"workspaceId"`
	Name        workmanagement.Optional[string]               `json:"name"`
	Description workmanagement.Optional[string]               `json:"description"`
	Status      workmanagement.Optional[projectrepo.Status]   `json:"status"`
	Priority    workmanagement.Optional[projectrepo.Priority] `json:"priority"`
	StartDate   workmanagement.Optional[string]               `json:"startDate"`
	TargetDate  workmanagement.Optional[string]               `json:"targetDate"`
}

// githubRepoPattern mirrors the column constraint. The value ends up in a
// GitHub REST path, so anything that could address a different resource is
// refused before it is stored, not only before it is sent.
var githubRepoPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$`)

type updateProjectBody struct {
	Name        workmanagement.Optional[string]               `json:"name"`
	Description workmanagement.Optional[string]               `json:"description"`
	Status      workmanagement.Optional[projectrepo.Status]   `json:"status"`
	Priority    workmanagement.Optional[projectrepo.Priority] `json:"priority"`
	StartDate   workmanagement.Optional[string]               `json:"startDate"`
	TargetDate  workmanagement.Optional[string]               `json:"targetDate"`
	// The full name alone. The numeric id is resolved from GitHub rather than
	// accepted from the client: a caller-supplied id could name a repository
	// the connection cannot see, and the pair would then disagree.
	GitHubRepo workmanagement.Optional[string] `json:"githubRepo"`
}

type createResourceBody struct {
	Kind        workmanagement.Optional[projectrepo.ResourceKind] `json:"kind"`
	URL         workmanagement.Optional[string]                   `json:"url"`
	Label       workmanagement.Optional[string]                   `json:"label"`
	Description workmanagement.Optional[string]                   `json:"description"`
	SortOrder   workmanagement.Optional[int]                      `json:"sortOrder"`
}

type updateResourceBody struct {
	Kind        workmanagement.Optional[projectrepo.ResourceKind] `json:"kind"`
	URL         workmanagement.Optional[string]                   `json:"url"`
	Label       workmanagement.Optional[string]                   `json:"label"`
	Description workmanagement.Optional[string]                   `json:"description"`
	SortOrder   workmanagement.Optional[int]                      `json:"sortOrder"`
}

func parseCreateProject(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, projectrepo.CreateParams, bool) {
	body, _, ok := workmanagement.DecodeJSON[createProjectBody](response, request)
	if !ok {
		return uuid.Nil, projectrepo.CreateParams{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	workspaceID := validateRequiredUUID(&fields, "/workspaceId", body.WorkspaceID)
	name := validateRequiredText(&fields, "/name", "Name", body.Name, 1, 200)
	description := validateOptionalText(
		&fields,
		"/description",
		"Description",
		body.Description,
		20000,
	)
	status := projectrepo.StatusPlanned
	if body.Status.Set {
		if body.Status.Null || !body.Status.Value.Valid() {
			fields = append(fields, invalidEnum("/status", "Status is not supported."))
		} else {
			status = body.Status.Value
		}
	}
	priority := projectrepo.PriorityNone
	if body.Priority.Set {
		if body.Priority.Null || !body.Priority.Value.Valid() {
			fields = append(fields, invalidEnum("/priority", "Priority is not supported."))
		} else {
			priority = body.Priority.Value
		}
	}
	startDate := validateOptionalDate(&fields, "/startDate", body.StartDate)
	targetDate := validateOptionalDate(&fields, "/targetDate", body.TargetDate)
	if startDate != nil && targetDate != nil && startDate.After(*targetDate) {
		fields = append(fields, httpapi.FieldError{
			Path:    "/targetDate",
			Code:    "invalid_range",
			Message: "targetDate must be on or after startDate.",
		})
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return uuid.Nil, projectrepo.CreateParams{}, false
	}
	return workspaceID, projectrepo.CreateParams{
		Name:        name,
		Description: description,
		Status:      status,
		Priority:    priority,
		StartDate:   startDate,
		TargetDate:  targetDate,
	}, true
}

func parseProjectPatch(
	response http.ResponseWriter,
	request *http.Request,
) (projectrepo.Patch, bool) {
	body, _, ok := workmanagement.DecodeJSON[updateProjectBody](response, request)
	if !ok {
		return projectrepo.Patch{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	patch := projectrepo.Patch{}
	count := 0
	if body.Name.Set {
		count++
		if body.Name.Null {
			fields = append(fields, invalidType("/name", "Name cannot be null."))
		} else {
			value := validateText(&fields, "/name", "Name", body.Name.Value, 1, 200)
			patch.Name = &value
		}
	}
	if body.Description.Set {
		count++
		patch.DescriptionSet = true
		if !body.Description.Null {
			value := validateText(
				&fields,
				"/description",
				"Description",
				body.Description.Value,
				0,
				20000,
			)
			patch.Description = &value
		}
	}
	if body.Status.Set {
		count++
		if body.Status.Null || !body.Status.Value.Valid() {
			fields = append(fields, invalidEnum("/status", "Status is not supported."))
		} else {
			patch.Status = &body.Status.Value
		}
	}
	if body.Priority.Set {
		count++
		if body.Priority.Null || !body.Priority.Value.Valid() {
			fields = append(fields, invalidEnum("/priority", "Priority is not supported."))
		} else {
			patch.Priority = &body.Priority.Value
		}
	}
	if body.StartDate.Set {
		count++
		patch.StartDateSet = true
		if !body.StartDate.Null {
			patch.StartDate = validateDate(&fields, "/startDate", body.StartDate.Value)
		}
	}
	if body.TargetDate.Set {
		count++
		patch.TargetDateSet = true
		if !body.TargetDate.Null {
			patch.TargetDate = validateDate(&fields, "/targetDate", body.TargetDate.Value)
		}
	}
	if body.GitHubRepo.Set {
		count++
		patch.GitHubRepoSet = true
		if !body.GitHubRepo.Null {
			name := strings.TrimSpace(body.GitHubRepo.Value)
			if !githubRepoPattern.MatchString(name) {
				fields = append(fields, httpapi.FieldError{
					Path:    "/githubRepo",
					Code:    "invalid_string",
					Message: "Repository must be owner/name.",
				})
			} else {
				patch.GitHubRepoFullName = &name
			}
		}
	}
	if count == 0 {
		fields = append(fields, httpapi.FieldError{
			Path:    "/",
			Code:    "too_small",
			Message: "At least one field must be provided.",
		})
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return projectrepo.Patch{}, false
	}
	return patch, true
}

func parseCreateResource(
	response http.ResponseWriter,
	request *http.Request,
) (projectrepo.CreateResourceParams, bool) {
	body, _, ok := workmanagement.DecodeJSON[createResourceBody](response, request)
	if !ok {
		return projectrepo.CreateResourceParams{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	kind := projectrepo.ResourceLink
	if !body.Kind.Set || body.Kind.Null {
		fields = append(fields, invalidType("/kind", "Kind is required."))
	} else if !body.Kind.Value.Valid() {
		fields = append(fields, invalidEnum("/kind", "Kind is not supported."))
	} else {
		kind = body.Kind.Value
	}
	resourceURL := ""
	if !body.URL.Set || body.URL.Null {
		fields = append(fields, invalidType("/url", "URL is required."))
	} else {
		resourceURL = validateExternalURL(&fields, "/url", body.URL.Value)
	}
	label := validateOptionalText(&fields, "/label", "Label", body.Label, 200)
	description := validateOptionalText(
		&fields,
		"/description",
		"Description",
		body.Description,
		2000,
	)
	sortOrder := 0
	if body.SortOrder.Set {
		if body.SortOrder.Null || body.SortOrder.Value < 0 ||
			body.SortOrder.Value > 1000000000 {
			fields = append(fields, httpapi.FieldError{
				Path:    "/sortOrder",
				Code:    "out_of_range",
				Message: "sortOrder must be an integer from 0 to 1000000000.",
			})
		} else {
			sortOrder = body.SortOrder.Value
		}
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return projectrepo.CreateResourceParams{}, false
	}
	return projectrepo.CreateResourceParams{
		Kind:        kind,
		URL:         resourceURL,
		Label:       label,
		Description: description,
		SortOrder:   sortOrder,
	}, true
}

func parseResourcePatch(
	response http.ResponseWriter,
	request *http.Request,
) (projectrepo.ResourcePatch, bool) {
	body, _, ok := workmanagement.DecodeJSON[updateResourceBody](response, request)
	if !ok {
		return projectrepo.ResourcePatch{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	patch := projectrepo.ResourcePatch{}
	count := 0
	if body.Kind.Set {
		count++
		if body.Kind.Null || !body.Kind.Value.Valid() {
			fields = append(fields, invalidEnum("/kind", "Kind is not supported."))
		} else {
			patch.Kind = &body.Kind.Value
		}
	}
	if body.URL.Set {
		count++
		if body.URL.Null {
			fields = append(fields, invalidType("/url", "URL cannot be null."))
		} else {
			value := validateExternalURL(&fields, "/url", body.URL.Value)
			patch.URL = &value
		}
	}
	if body.Label.Set {
		count++
		patch.LabelSet = true
		if !body.Label.Null {
			value := validateText(&fields, "/label", "Label", body.Label.Value, 1, 200)
			patch.Label = &value
		}
	}
	if body.Description.Set {
		count++
		patch.DescriptionSet = true
		if !body.Description.Null {
			value := validateText(
				&fields,
				"/description",
				"Description",
				body.Description.Value,
				0,
				2000,
			)
			patch.Description = &value
		}
	}
	if body.SortOrder.Set {
		count++
		if body.SortOrder.Null || body.SortOrder.Value < 0 ||
			body.SortOrder.Value > 1000000000 {
			fields = append(fields, httpapi.FieldError{
				Path:    "/sortOrder",
				Code:    "out_of_range",
				Message: "sortOrder must be an integer from 0 to 1000000000.",
			})
		} else {
			patch.SortOrder = &body.SortOrder.Value
		}
	}
	if count == 0 {
		fields = append(fields, httpapi.FieldError{
			Path:    "/",
			Code:    "too_small",
			Message: "At least one field must be provided.",
		})
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return projectrepo.ResourcePatch{}, false
	}
	return patch, true
}

func validateRequiredUUID(
	fields *[]httpapi.FieldError,
	path string,
	value workmanagement.Optional[string],
) uuid.UUID {
	if !value.Set || value.Null {
		*fields = append(*fields, invalidType(path, "Field is required."))
		return uuid.Nil
	}
	parsed, ok := workmanagement.ParseCanonicalUUID(value.Value)
	if !ok {
		*fields = append(*fields, httpapi.FieldError{
			Path:    path,
			Code:    "invalid_format",
			Message: "Value must be a canonical UUID.",
		})
		return uuid.Nil
	}
	return parsed
}

func validateRequiredText(
	fields *[]httpapi.FieldError,
	path, label string,
	value workmanagement.Optional[string],
	minimum, maximum int,
) string {
	if !value.Set || value.Null {
		*fields = append(*fields, invalidType(path, label+" is required."))
		return ""
	}
	return validateText(fields, path, label, value.Value, minimum, maximum)
}

func validateOptionalText(
	fields *[]httpapi.FieldError,
	path, label string,
	value workmanagement.Optional[string],
	maximum int,
) *string {
	if !value.Set || value.Null {
		return nil
	}
	normalized := validateText(fields, path, label, value.Value, 0, maximum)
	return &normalized
}

func validateText(
	fields *[]httpapi.FieldError,
	path, label, value string,
	minimum, maximum int,
) string {
	normalized := strings.TrimSpace(value)
	length := utf8.RuneCountInString(normalized)
	if length < minimum {
		*fields = append(*fields, httpapi.FieldError{
			Path:    path,
			Code:    "too_small",
			Message: label + " is too short.",
		})
	}
	if length > maximum {
		*fields = append(*fields, httpapi.FieldError{
			Path:    path,
			Code:    "too_big",
			Message: label + " is too long.",
		})
	}
	return normalized
}

func validateOptionalDate(
	fields *[]httpapi.FieldError,
	path string,
	value workmanagement.Optional[string],
) *time.Time {
	if !value.Set || value.Null {
		return nil
	}
	return validateDate(fields, path, value.Value)
}

func validateDate(
	fields *[]httpapi.FieldError,
	path, value string,
) *time.Time {
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil || parsed.Format("2006-01-02") != value {
		*fields = append(*fields, httpapi.FieldError{
			Path:    path,
			Code:    "invalid_format",
			Message: "Date must use YYYY-MM-DD.",
		})
		return nil
	}
	return &parsed
}

func validateExternalURL(
	fields *[]httpapi.FieldError,
	path, value string,
) string {
	normalized := strings.TrimSpace(value)
	parsed, err := url.ParseRequestURI(normalized)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.User != nil || len(normalized) > 2048 {
		*fields = append(*fields, httpapi.FieldError{
			Path:    path,
			Code:    "invalid_format",
			Message: "URL must be an HTTP(S) URL without embedded credentials.",
		})
		return normalized
	}
	return parsed.String()
}

func invalidType(path, message string) httpapi.FieldError {
	return httpapi.FieldError{Path: path, Code: "invalid_type", Message: message}
}

func invalidEnum(path, message string) httpapi.FieldError {
	return httpapi.FieldError{Path: path, Code: "invalid_enum_value", Message: message}
}
