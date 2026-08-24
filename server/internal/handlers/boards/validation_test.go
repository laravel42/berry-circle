package boards

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateBoardValidationDefaultsColumnsAndRejectsUnknownFields(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/boards",
		strings.NewReader(`{"name":"Berry","slug":"berry"}`),
	)
	response := httptest.NewRecorder()
	input, ok := parseCreateBoard(response, request)
	if !ok {
		t.Fatalf("valid board was rejected: status=%d body=%s", response.Code, response.Body)
	}
	if len(input.Columns) != 5 || input.Columns[2].ID != "inProgress" {
		t.Fatalf("default columns = %#v", input.Columns)
	}

	request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/boards",
		strings.NewReader(`{"name":"Berry","slug":"berry","createdBy":"forged"}`),
	)
	response = httptest.NewRecorder()
	if _, ok := parseCreateBoard(response, request); ok ||
		response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown field status=%d accepted=%t body=%s", response.Code, ok, response.Body)
	}
}

func TestBoardColumnsRequireUniqueStatuses(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/boards",
		strings.NewReader(
			`{"name":"Berry","slug":"berry","columns":[`+
				`{"id":"todo","name":"Todo"},{"id":"todo","name":"Again"}]}`,
		),
	)
	response := httptest.NewRecorder()
	if _, ok := parseCreateBoard(response, request); ok ||
		response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("duplicate columns status=%d accepted=%t body=%s", response.Code, ok, response.Body)
	}
}
