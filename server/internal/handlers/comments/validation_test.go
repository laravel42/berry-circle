package comments

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCommentInputRejectsForgedAuthorAndNestedShape(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/issues/one/comments",
		strings.NewReader(`{"body":"hello","authorId":"forged"}`),
	)
	response := httptest.NewRecorder()
	if _, _, ok := parseCreateComment(response, request); ok ||
		response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("forged author status=%d accepted=%t body=%s", response.Code, ok, response.Body)
	}
}

func TestCommentBodyLimits(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`{"body":""}`, `{"body":null}`} {
		request := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/issues/one/comments",
			strings.NewReader(body),
		)
		response := httptest.NewRecorder()
		if _, _, ok := parseCreateComment(response, request); ok ||
			response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body=%s status=%d accepted=%t response=%s", body, response.Code, ok, response.Body)
		}
	}
}
