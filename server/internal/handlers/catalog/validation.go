package catalog

import (
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	catalogrepo "github.com/laravel42/berry-circle/server/internal/repository/catalogs"
)

var statusKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

type createLabelBody struct {
	Name        workmanagement.Optional[string] `json:"name"`
	Description workmanagement.Optional[string] `json:"description"`
	Color       workmanagement.Optional[string] `json:"color"`
}

type updateLabelBody struct {
	Name        workmanagement.Optional[string] `json:"name"`
	Description workmanagement.Optional[string] `json:"description"`
	Color       workmanagement.Optional[string] `json:"color"`
}

type createStatusBody struct {
	Key         workmanagement.Optional[string]                       `json:"key"`
	Name        workmanagement.Optional[string]                       `json:"name"`
	Description workmanagement.Optional[string]                       `json:"description"`
	Category    workmanagement.Optional[catalogrepo.WorkflowCategory] `json:"category"`
	Color       workmanagement.Optional[string]                       `json:"color"`
	SortOrder   workmanagement.Optional[int]                          `json:"sortOrder"`
}

type updateStatusBody struct {
	Name        workmanagement.Optional[string] `json:"name"`
	Description workmanagement.Optional[string] `json:"description"`
	Color       workmanagement.Optional[string] `json:"color"`
	SortOrder   workmanagement.Optional[int]    `json:"sortOrder"`
}

type reorderStatusesBody struct {
	StatusIDs workmanagement.Optional[[]string] `json:"statusIds"`
}

type createPropertyBody struct {
	Name        workmanagement.Optional[string]                     `json:"name"`
	Description workmanagement.Optional[string]                     `json:"description"`
	Kind        workmanagement.Optional[catalogrepo.PropertyKind]   `json:"kind"`
	Config      workmanagement.Optional[catalogrepo.PropertyConfig] `json:"config"`
	Icon        workmanagement.Optional[string]                     `json:"icon"`
	SortOrder   workmanagement.Optional[int]                        `json:"sortOrder"`
}

type updatePropertyBody struct {
	Name        workmanagement.Optional[string]                     `json:"name"`
	Description workmanagement.Optional[string]                     `json:"description"`
	Config      workmanagement.Optional[catalogrepo.PropertyConfig] `json:"config"`
	Icon        workmanagement.Optional[string]                     `json:"icon"`
	SortOrder   workmanagement.Optional[int]                        `json:"sortOrder"`
}

type createQuickActionBody struct {
	Name          workmanagement.Optional[string]                            `json:"name"`
	Description   workmanagement.Optional[string]                            `json:"description"`
	TargetAgentID workmanagement.Optional[string]                            `json:"targetAgentId"`
	Prompt        workmanagement.Optional[string]                            `json:"prompt"`
	Visibility    workmanagement.Optional[catalogrepo.QuickActionVisibility] `json:"visibility"`
}

type updateQuickActionBody struct {
	Name          workmanagement.Optional[string]                            `json:"name"`
	Description   workmanagement.Optional[string]                            `json:"description"`
	TargetAgentID workmanagement.Optional[string]                            `json:"targetAgentId"`
	Prompt        workmanagement.Optional[string]                            `json:"prompt"`
	Visibility    workmanagement.Optional[catalogrepo.QuickActionVisibility] `json:"visibility"`
}

type quickActionIssueBody struct {
	IssueID workmanagement.Optional[string] `json:"issueId"`
}

func parseCreateLabel(
	response http.ResponseWriter,
	request *http.Request,
) (catalogrepo.CreateLabelParams, bool) {
	body, _, ok := workmanagement.DecodeJSON[createLabelBody](response, request)
	if !ok {
		return catalogrepo.CreateLabelParams{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	name := requiredText(&fields, "/name", "Name", body.Name, 1, 100)
	description := optionalText(
		&fields,
		"/description",
		"Description",
		body.Description,
		1000,
	)
	color := requiredColor(&fields, body.Color)
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return catalogrepo.CreateLabelParams{}, false
	}
	return catalogrepo.CreateLabelParams{
		Name:        name,
		Description: description,
		Color:       color,
	}, true
}

func parseLabelPatch(
	response http.ResponseWriter,
	request *http.Request,
) (catalogrepo.LabelPatch, bool) {
	body, _, ok := workmanagement.DecodeJSON[updateLabelBody](response, request)
	if !ok {
		return catalogrepo.LabelPatch{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	patch := catalogrepo.LabelPatch{}
	count := 0
	if body.Name.Set {
		count++
		if body.Name.Null {
			fields = append(fields, invalidType("/name", "Name cannot be null."))
		} else {
			value := boundedText(&fields, "/name", "Name", body.Name.Value, 1, 100)
			patch.Name = &value
		}
	}
	if body.Description.Set {
		count++
		patch.DescriptionSet = true
		if !body.Description.Null {
			value := boundedText(
				&fields,
				"/description",
				"Description",
				body.Description.Value,
				0,
				1000,
			)
			patch.Description = &value
		}
	}
	if body.Color.Set {
		count++
		if body.Color.Null || !validColor(body.Color.Value) {
			fields = append(fields, invalidColor("/color"))
		} else {
			patch.Color = &body.Color.Value
		}
	}
	requirePatchFields(&fields, count)
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return catalogrepo.LabelPatch{}, false
	}
	return patch, true
}

func parseCreateStatus(
	response http.ResponseWriter,
	request *http.Request,
) (catalogrepo.CreateStatusParams, bool) {
	body, _, ok := workmanagement.DecodeJSON[createStatusBody](response, request)
	if !ok {
		return catalogrepo.CreateStatusParams{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	key := requiredText(&fields, "/key", "Key", body.Key, 1, 32)
	if key != "" && !statusKeyPattern.MatchString(key) {
		fields = append(fields, httpapi.FieldError{
			Path:    "/key",
			Code:    "invalid_format",
			Message: "Key must use lowercase letters, digits, and hyphens.",
		})
	}
	name := requiredText(&fields, "/name", "Name", body.Name, 1, 100)
	description := optionalText(
		&fields,
		"/description",
		"Description",
		body.Description,
		1000,
	)
	category := catalogrepo.CategoryBacklog
	if !body.Category.Set || body.Category.Null {
		fields = append(fields, invalidType("/category", "Category is required."))
	} else if !body.Category.Value.Valid() {
		fields = append(fields, httpapi.FieldError{
			Path:    "/category",
			Code:    "invalid_enum_value",
			Message: "Category is not a Berry workflow category.",
		})
	} else {
		category = body.Category.Value
	}
	color := requiredColor(&fields, body.Color)
	sortOrder := parseSortOrder(&fields, body.SortOrder, 0)
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return catalogrepo.CreateStatusParams{}, false
	}
	return catalogrepo.CreateStatusParams{
		Key:         key,
		Name:        name,
		Description: description,
		Category:    category,
		Color:       color,
		SortOrder:   sortOrder,
	}, true
}

func parseStatusPatch(
	response http.ResponseWriter,
	request *http.Request,
) (catalogrepo.StatusPatch, bool) {
	body, _, ok := workmanagement.DecodeJSON[updateStatusBody](response, request)
	if !ok {
		return catalogrepo.StatusPatch{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	patch := catalogrepo.StatusPatch{}
	count := 0
	if body.Name.Set {
		count++
		if body.Name.Null {
			fields = append(fields, invalidType("/name", "Name cannot be null."))
		} else {
			value := boundedText(&fields, "/name", "Name", body.Name.Value, 1, 100)
			patch.Name = &value
		}
	}
	if body.Description.Set {
		count++
		patch.DescriptionSet = true
		if !body.Description.Null {
			value := boundedText(
				&fields,
				"/description",
				"Description",
				body.Description.Value,
				0,
				1000,
			)
			patch.Description = &value
		}
	}
	if body.Color.Set {
		count++
		if body.Color.Null || !validColor(body.Color.Value) {
			fields = append(fields, invalidColor("/color"))
		} else {
			patch.Color = &body.Color.Value
		}
	}
	if body.SortOrder.Set {
		count++
		if body.SortOrder.Null {
			fields = append(fields, invalidType("/sortOrder", "sortOrder cannot be null."))
		} else {
			value := parseSortOrder(&fields, body.SortOrder, 0)
			patch.SortOrder = &value
		}
	}
	requirePatchFields(&fields, count)
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return catalogrepo.StatusPatch{}, false
	}
	return patch, true
}

func parseStatusOrder(
	response http.ResponseWriter,
	request *http.Request,
) ([]uuid.UUID, bool) {
	body, _, ok := workmanagement.DecodeJSON[reorderStatusesBody](response, request)
	if !ok {
		return nil, false
	}
	fields := make([]httpapi.FieldError, 0)
	if !body.StatusIDs.Set || body.StatusIDs.Null || len(body.StatusIDs.Value) == 0 ||
		len(body.StatusIDs.Value) > 100 {
		fields = append(fields, httpapi.FieldError{
			Path:    "/statusIds",
			Code:    "invalid_size",
			Message: "statusIds must contain 1 to 100 canonical UUIDs.",
		})
	}
	result := make([]uuid.UUID, 0, len(body.StatusIDs.Value))
	seen := make(map[uuid.UUID]struct{}, len(body.StatusIDs.Value))
	for index, raw := range body.StatusIDs.Value {
		id, valid := workmanagement.ParseCanonicalUUID(raw)
		if !valid {
			fields = append(fields, httpapi.FieldError{
				Path:    "/statusIds/" + integerString(index),
				Code:    "invalid_format",
				Message: "Value must be a canonical UUID.",
			})
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			fields = append(fields, httpapi.FieldError{
				Path:    "/statusIds/" + integerString(index),
				Code:    "duplicate",
				Message: "Status IDs must be unique.",
			})
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return nil, false
	}
	return result, true
}

func parseCreateProperty(
	response http.ResponseWriter,
	request *http.Request,
) (catalogrepo.CreatePropertyParams, bool) {
	body, _, ok := workmanagement.DecodeJSON[createPropertyBody](response, request)
	if !ok {
		return catalogrepo.CreatePropertyParams{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	name := requiredText(&fields, "/name", "Name", body.Name, 1, 100)
	description := optionalText(
		&fields,
		"/description",
		"Description",
		body.Description,
		1000,
	)
	kind := catalogrepo.PropertyText
	if !body.Kind.Set || body.Kind.Null {
		fields = append(fields, invalidType("/kind", "Kind is required."))
	} else if !body.Kind.Value.Valid() {
		fields = append(fields, httpapi.FieldError{
			Path:    "/kind",
			Code:    "invalid_enum_value",
			Message: "Kind is not supported.",
		})
	} else {
		kind = body.Kind.Value
	}
	config := catalogrepo.PropertyConfig{Options: []catalogrepo.PropertyOption{}}
	if body.Config.Set {
		if body.Config.Null {
			fields = append(fields, invalidType("/config", "Config cannot be null."))
		} else {
			config = body.Config.Value
		}
	}
	if err := catalogrepo.ValidatePropertyConfig(kind, config); err != nil {
		fields = append(fields, httpapi.FieldError{
			Path:    "/config",
			Code:    "invalid_value",
			Message: "Config does not match the property kind.",
		})
	}
	icon := optionalText(&fields, "/icon", "Icon", body.Icon, 100)
	sortOrder := parseSortOrder(&fields, body.SortOrder, 0)
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return catalogrepo.CreatePropertyParams{}, false
	}
	return catalogrepo.CreatePropertyParams{
		Name:        name,
		Description: description,
		Kind:        kind,
		Config:      config,
		Icon:        icon,
		SortOrder:   sortOrder,
	}, true
}

func parsePropertyPatch(
	response http.ResponseWriter,
	request *http.Request,
) (catalogrepo.PropertyPatch, bool) {
	body, _, ok := workmanagement.DecodeJSON[updatePropertyBody](response, request)
	if !ok {
		return catalogrepo.PropertyPatch{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	patch := catalogrepo.PropertyPatch{}
	count := 0
	if body.Name.Set {
		count++
		if body.Name.Null {
			fields = append(fields, invalidType("/name", "Name cannot be null."))
		} else {
			value := boundedText(&fields, "/name", "Name", body.Name.Value, 1, 100)
			patch.Name = &value
		}
	}
	if body.Description.Set {
		count++
		patch.DescriptionSet = true
		if !body.Description.Null {
			value := boundedText(
				&fields,
				"/description",
				"Description",
				body.Description.Value,
				0,
				1000,
			)
			patch.Description = &value
		}
	}
	if body.Config.Set {
		count++
		if body.Config.Null {
			fields = append(fields, invalidType("/config", "Config cannot be null."))
		} else {
			patch.Config = &body.Config.Value
		}
	}
	if body.Icon.Set {
		count++
		patch.IconSet = true
		if !body.Icon.Null {
			value := boundedText(&fields, "/icon", "Icon", body.Icon.Value, 1, 100)
			patch.Icon = &value
		}
	}
	if body.SortOrder.Set {
		count++
		if body.SortOrder.Null {
			fields = append(fields, invalidType("/sortOrder", "sortOrder cannot be null."))
		} else {
			value := parseSortOrder(&fields, body.SortOrder, 0)
			patch.SortOrder = &value
		}
	}
	requirePatchFields(&fields, count)
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return catalogrepo.PropertyPatch{}, false
	}
	return patch, true
}

func parseCreateQuickAction(
	response http.ResponseWriter,
	request *http.Request,
) (catalogrepo.CreateQuickActionParams, bool) {
	body, _, ok := workmanagement.DecodeJSON[createQuickActionBody](response, request)
	if !ok {
		return catalogrepo.CreateQuickActionParams{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	name := requiredText(&fields, "/name", "Name", body.Name, 1, 100)
	description := optionalText(
		&fields,
		"/description",
		"Description",
		body.Description,
		1000,
	)
	targetAgentID := requiredUUID(&fields, "/targetAgentId", body.TargetAgentID)
	prompt := requiredText(&fields, "/prompt", "Prompt", body.Prompt, 1, 20000)
	if strings.ContainsRune(prompt, '\x00') {
		fields = append(fields, httpapi.FieldError{
			Path:    "/prompt",
			Code:    "invalid_value",
			Message: "Prompt contains an unsupported character.",
		})
	}
	visibility := catalogrepo.QuickActionPrivate
	if body.Visibility.Set {
		if body.Visibility.Null || !body.Visibility.Value.Valid() {
			fields = append(fields, httpapi.FieldError{
				Path:    "/visibility",
				Code:    "invalid_enum_value",
				Message: "Visibility is not supported.",
			})
		} else {
			visibility = body.Visibility.Value
		}
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return catalogrepo.CreateQuickActionParams{}, false
	}
	return catalogrepo.CreateQuickActionParams{
		Name:          name,
		Description:   description,
		TargetAgentID: targetAgentID,
		Prompt:        prompt,
		Visibility:    visibility,
	}, true
}

func parseQuickActionPatch(
	response http.ResponseWriter,
	request *http.Request,
) (catalogrepo.QuickActionPatch, bool) {
	body, _, ok := workmanagement.DecodeJSON[updateQuickActionBody](response, request)
	if !ok {
		return catalogrepo.QuickActionPatch{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	patch := catalogrepo.QuickActionPatch{}
	count := 0
	if body.Name.Set {
		count++
		if body.Name.Null {
			fields = append(fields, invalidType("/name", "Name cannot be null."))
		} else {
			value := boundedText(&fields, "/name", "Name", body.Name.Value, 1, 100)
			patch.Name = &value
		}
	}
	if body.Description.Set {
		count++
		patch.DescriptionSet = true
		if !body.Description.Null {
			value := boundedText(
				&fields,
				"/description",
				"Description",
				body.Description.Value,
				0,
				1000,
			)
			patch.Description = &value
		}
	}
	if body.TargetAgentID.Set {
		count++
		if body.TargetAgentID.Null {
			fields = append(fields, invalidType(
				"/targetAgentId",
				"targetAgentId cannot be null.",
			))
		} else {
			value := requiredUUID(&fields, "/targetAgentId", body.TargetAgentID)
			patch.TargetAgentID = &value
		}
	}
	if body.Prompt.Set {
		count++
		if body.Prompt.Null {
			fields = append(fields, invalidType("/prompt", "Prompt cannot be null."))
		} else {
			value := boundedText(
				&fields,
				"/prompt",
				"Prompt",
				body.Prompt.Value,
				1,
				20000,
			)
			if strings.ContainsRune(value, '\x00') {
				fields = append(fields, httpapi.FieldError{
					Path:    "/prompt",
					Code:    "invalid_value",
					Message: "Prompt contains an unsupported character.",
				})
			}
			patch.Prompt = &value
		}
	}
	if body.Visibility.Set {
		count++
		if body.Visibility.Null || !body.Visibility.Value.Valid() {
			fields = append(fields, httpapi.FieldError{
				Path:    "/visibility",
				Code:    "invalid_enum_value",
				Message: "Visibility is not supported.",
			})
		} else {
			patch.Visibility = &body.Visibility.Value
		}
	}
	requirePatchFields(&fields, count)
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return catalogrepo.QuickActionPatch{}, false
	}
	return patch, true
}

func parseQuickActionIssue(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, bool) {
	body, _, ok := workmanagement.DecodeJSON[quickActionIssueBody](response, request)
	if !ok {
		return uuid.Nil, false
	}
	fields := make([]httpapi.FieldError, 0)
	id := requiredUUID(&fields, "/issueId", body.IssueID)
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return uuid.Nil, false
	}
	return id, true
}

func requiredUUID(
	fields *[]httpapi.FieldError,
	path string,
	value workmanagement.Optional[string],
) uuid.UUID {
	if !value.Set || value.Null {
		*fields = append(*fields, invalidType(path, "Field is required."))
		return uuid.Nil
	}
	id, ok := workmanagement.ParseCanonicalUUID(value.Value)
	if !ok {
		*fields = append(*fields, httpapi.FieldError{
			Path:    path,
			Code:    "invalid_format",
			Message: "Value must be a canonical UUID.",
		})
		return uuid.Nil
	}
	return id
}

func requiredText(
	fields *[]httpapi.FieldError,
	path, label string,
	value workmanagement.Optional[string],
	minimum, maximum int,
) string {
	if !value.Set || value.Null {
		*fields = append(*fields, invalidType(path, label+" is required."))
		return ""
	}
	return boundedText(fields, path, label, value.Value, minimum, maximum)
}

func optionalText(
	fields *[]httpapi.FieldError,
	path, label string,
	value workmanagement.Optional[string],
	maximum int,
) *string {
	if !value.Set || value.Null {
		return nil
	}
	normalized := boundedText(fields, path, label, value.Value, 0, maximum)
	return &normalized
}

func boundedText(
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

func requiredColor(
	fields *[]httpapi.FieldError,
	value workmanagement.Optional[string],
) string {
	if !value.Set || value.Null {
		*fields = append(*fields, invalidType("/color", "Color is required."))
		return ""
	}
	if !validColor(value.Value) {
		*fields = append(*fields, invalidColor("/color"))
	}
	return value.Value
}

func validColor(color string) bool {
	if len(color) != 7 || color[0] != '#' {
		return false
	}
	for _, character := range color[1:] {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func invalidColor(path string) httpapi.FieldError {
	return httpapi.FieldError{
		Path:    path,
		Code:    "invalid_format",
		Message: "Color must use lowercase #rrggbb format.",
	}
}

func parseSortOrder(
	fields *[]httpapi.FieldError,
	value workmanagement.Optional[int],
	fallback int,
) int {
	if !value.Set {
		return fallback
	}
	if value.Null || value.Value < 0 || value.Value > 1000000000 {
		*fields = append(*fields, httpapi.FieldError{
			Path:    "/sortOrder",
			Code:    "out_of_range",
			Message: "sortOrder must be an integer from 0 to 1000000000.",
		})
		return fallback
	}
	return value.Value
}

func requirePatchFields(fields *[]httpapi.FieldError, count int) {
	if count == 0 {
		*fields = append(*fields, httpapi.FieldError{
			Path:    "/",
			Code:    "too_small",
			Message: "At least one field must be provided.",
		})
	}
}

func invalidType(path, message string) httpapi.FieldError {
	return httpapi.FieldError{Path: path, Code: "invalid_type", Message: message}
}

func integerString(value int) string {
	if value == 0 {
		return "0"
	}
	buffer := [20]byte{}
	index := len(buffer)
	for value > 0 {
		index--
		buffer[index] = byte('0' + value%10)
		value /= 10
	}
	return string(buffer[index:])
}
