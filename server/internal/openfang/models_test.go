package openfang

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListModelsReturnsNormalizedEntries(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/v1/models" || request.Method != http.MethodGet {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{
			"object":"list",
			"data":[
				{"id":"agent-1","object":"model","owned_by":"openfang"},
				{"id":"gpt-test","object":"model","owned_by":"openai"}
			]
		}`)
	}))
	defer server.Close()

	client, err := New(server.URL, "", server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	models, err := client.ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels() error = %v", err)
	}
	if len(models) != 2 || models[0].ID != "agent-1" || models[0].OwnedBy != "openfang" {
		t.Fatalf("models = %#v", models)
	}
}

func TestCreateChatCompletionReturnsAssistantContent(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/v1/chat/completions" || request.Method != http.MethodPost {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{
			"object":"chat.completion",
			"choices":[{"message":{"role":"assistant","content":"berry"}}],
			"usage":{"prompt_tokens":3,"completion_tokens":1}
		}`)
	}))
	defer server.Close()

	client, err := New(server.URL, "", server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := client.CreateChatCompletion(context.Background(), ChatCompletionRequest{
		Model: "agent-1",
		Messages: []ChatMessage{{
			Role:    "user",
			Content: "Reply with berry.",
		}},
	})
	if err != nil {
		t.Fatalf("CreateChatCompletion() error = %v", err)
	}
	if result.Content != "berry" || result.Usage.InputTokens != 3 || result.Usage.OutputTokens != 1 {
		t.Fatalf("result = %#v", result)
	}
}

// A JSON-object response format travels as OpenAI's response_format object
// and the upstream request id comes back on the result; an unknown format is
// refused before any request is made.
func TestCreateChatCompletionSendsResponseFormat(t *testing.T) {
	t.Parallel()
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
			t.Errorf("decode request: %v", err)
		}
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("X-Request-Id", "req_upstream_1")
		_, _ = io.WriteString(response, `{
			"object":"chat.completion",
			"choices":[{"message":{"role":"assistant","content":"{\"ok\":true}"}}],
			"usage":{"prompt_tokens":10,"completion_tokens":4}
		}`)
	}))
	defer server.Close()

	client, err := New(server.URL, "", server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := client.CreateChatCompletion(context.Background(), ChatCompletionRequest{
		Model:          "berry-planner-1",
		Messages:       []ChatMessage{{Role: "user", Content: "Return JSON."}},
		ResponseFormat: ChatResponseFormatJSONObject,
	})
	if err != nil {
		t.Fatalf("CreateChatCompletion() error = %v", err)
	}
	format, _ := received["response_format"].(map[string]any)
	if format["type"] != "json_object" {
		t.Fatalf("response_format = %#v, want json_object", received["response_format"])
	}
	if result.RequestID != "req_upstream_1" || result.Content != `{"ok":true}` {
		t.Fatalf("result = %#v", result)
	}

	received = nil
	if _, err := client.CreateChatCompletion(context.Background(), ChatCompletionRequest{
		Model:    "berry-planner-1",
		Messages: []ChatMessage{{Role: "user", Content: "Return text."}},
	}); err != nil {
		t.Fatalf("plain CreateChatCompletion() error = %v", err)
	}
	if _, present := received["response_format"]; present {
		t.Fatalf("response_format sent when unset: %#v", received)
	}
	if _, err := client.CreateChatCompletion(context.Background(), ChatCompletionRequest{
		Model:          "berry-planner-1",
		Messages:       []ChatMessage{{Role: "user", Content: "x"}},
		ResponseFormat: ChatResponseFormat("xml"),
	}); err == nil {
		t.Fatal("unknown response format accepted")
	}
}
