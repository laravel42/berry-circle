package runs

import (
	"net/http"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

func writeUnauthenticated(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnauthorized,
		"UNAUTHENTICATED",
		"Authentication is required.",
		nil,
	)
}

func writeNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		"The requested run was not found.",
		nil,
	)
}

func writeIssueNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		"The requested issue was not found.",
		nil,
	)
}

func writeBoardNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		"The requested board was not found.",
		nil,
	)
}

func writeInvalidRequest(
	response http.ResponseWriter,
	request *http.Request,
	field httpapi.FieldError,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The request is invalid.",
		map[string]any{"fields": []httpapi.FieldError{field}},
	)
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

func writeValidation(
	response http.ResponseWriter,
	request *http.Request,
	fields ...httpapi.FieldError,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnprocessableEntity,
		"VALIDATION_FAILED",
		"Request validation failed.",
		map[string]any{"fields": fields},
	)
}

func writeDurableUnavailable(
	response http.ResponseWriter,
	request *http.Request,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusServiceUnavailable,
		"DURABLE_ACCEPTANCE_UNAVAILABLE",
		"The run could not be durably accepted.",
		nil,
	)
}

func writeInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusInternalServerError,
		"INTERNAL",
		"An internal error occurred.",
		nil,
	)
}
