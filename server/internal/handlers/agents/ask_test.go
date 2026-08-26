package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/modelgateway"
	"github.com/laravel42/berry-circle/server/internal/openfang"
)

type fakeChat struct {
	mu       sync.Mutex
	requests []openfang.ChatCompletionRequest
	content  string
	err      error
}

func (chat *fakeChat) ListModels(context.Context) ([]openfang.ModelSummary, error) { return nil, nil }

func (chat *fakeChat) CreateChatCompletion(_ context.Context, request openfang.ChatCompletionRequest) (openfang.ChatCompletionResult, error) {
	chat.mu.Lock()
	defer chat.mu.Unlock()
	chat.requests = append(chat.requests, request)
	if chat.err != nil {
		return openfang.ChatCompletionResult{}, chat.err
	}
	return openfang.ChatCompletionResult{Model: request.Model, Content: chat.content, Usage: openfang.ChatCompletionUsage{InputTokens: 120, OutputTokens: 30}, RequestID: "req-1"}, nil
}

type fakeAsks struct {
	mu      sync.Mutex
	records []AskRecord
}

func (asks *fakeAsks) RecordAsk(_ context.Context, record AskRecord) error {
	asks.mu.Lock()
	defer asks.mu.Unlock()
	asks.records = append(asks.records, record)
	return nil
}

type fakePrices struct{}

func (fakePrices) Price(_ context.Context, provider, model string) (modelgateway.Price, bool) {
	if provider == "openrouter" && model == "test/model" {
		// One dollar per million input tokens, two per million output tokens.
		return modelgateway.Price{InputPerMillion: 1, OutputPerMillion: 2}, true
	}
	return modelgateway.Price{}, false
}

func askMount(t *testing.T, agent Agent, chat *fakeChat, asks *fakeAsks) http.Handler {
	t.Helper()
	store := &agentStore{agent: agent}
	mount, err := NewMount(Options{
		Store: store, Sessions: agentSessions{}, Authorization: agentAuthorizer{},
		Clock: func() time.Time { return time.Date(2026, time.August, 26, 9, 0, 0, 0, time.UTC) }, NewID: uuid.New,
		OpenFang: &agentRuntime{}, Chat: chat, Asks: asks, Prices: fakePrices{},
	})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	return mount.Handler
}

func ask(handler http.Handler, agentID uuid.UUID, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/"+agentID.String()+"/ask", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+agentTestToken())
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func availableAgent() Agent {
	provider, model := "openrouter", "test/model"
	return Agent{ID: uuid.New(), OpenFangAgentID: uuid.New(), Name: "writer", Status: "available", ModelProvider: &provider, ModelName: &model}
}

const askSchema = `{"type":"object","required":["summary","score"],"properties":{"summary":{"type":"string","minLength":1},"score":{"type":"integer","minimum":0,"maximum":10}},"additionalProperties":false}`

// One completion with a JSON-object response format to the agent; the
// answer is decoded, checked against the schema, priced and recorded.
func TestAskReturnsASchemaValidatedAnswer(t *testing.T) {
	agent := availableAgent()
	chat := &fakeChat{content: "```json\n{\"summary\":\"Looks good\",\"score\":8}\n```"}
	asks := &fakeAsks{}
	mount := askMount(t, agent, chat, asks)
	response := ask(mount, agent.ID, `{"prompt":"Review this","schema":`+askSchema+`}`)
	if response.Code != http.StatusOK {
		t.Fatalf("ask = %d %s", response.Code, response.Body.String())
	}
	var body struct {
		ID      string          `json:"id"`
		AgentID string          `json:"agentId"`
		Answer  json.RawMessage `json:"answer"`
		Usage   struct {
			InputTokens  int64  `json:"inputTokens"`
			OutputTokens int64  `json:"outputTokens"`
			CostMicros   *int64 `json:"costMicros"`
			Currency     string `json:"currency"`
		} `json:"usage"`
		Model struct {
			Provider string `json:"provider"`
			Name     string `json:"name"`
		} `json:"model"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.AgentID != agent.ID.String() || string(body.Answer) != `{"score":8,"summary":"Looks good"}` || body.Usage.InputTokens != 120 || body.Usage.OutputTokens != 30 ||
		body.Usage.CostMicros == nil || *body.Usage.CostMicros != 120*1+30*2 || body.Usage.Currency != "USD" || body.Model.Provider != "openrouter" || body.Model.Name != "test/model" {
		t.Fatalf("body = %s", response.Body.String())
	}
	if len(chat.requests) != 1 {
		t.Fatalf("completions = %d, want exactly one", len(chat.requests))
	}
	request := chat.requests[0]
	if request.Model != "writer" || request.ResponseFormat != openfang.ChatResponseFormatJSONObject || len(request.Messages) != 1 ||
		!strings.HasPrefix(request.Messages[0].Content, "Review this") || !strings.Contains(request.Messages[0].Content, `"required":["summary","score"]`) {
		t.Fatalf("request = %+v", request)
	}
	if len(asks.records) != 1 || asks.records[0].Status != "succeeded" || asks.records[0].ID.String() != body.ID || asks.records[0].UpstreamID != "req-1" ||
		asks.records[0].InputTokens != 120 || asks.records[0].CostMicros == nil || asks.records[0].RequestedBy == uuid.Nil {
		t.Fatalf("records = %+v", asks.records)
	}
}

// An answer that is not JSON or does not match the schema is refused with
// the decode hint, recorded with its usage, and never re-asked.
func TestAskRefusesInvalidAnswersWithoutRetrying(t *testing.T) {
	for name, scenario := range map[string]struct {
		content string
		hint    string
	}{
		"prose":            {"I cannot answer that.", "not a JSON value"},
		"missing property": {`{"summary":"ok"}`, "missing the required property"},
		"wrong type":       {`{"summary":"ok","score":"eight"}`, "$.score is not a integer"},
		"extra property":   {`{"summary":"ok","score":1,"notes":"x"}`, "unexpected property"},
	} {
		t.Run(name, func(t *testing.T) {
			agent := availableAgent()
			chat := &fakeChat{content: scenario.content}
			asks := &fakeAsks{}
			mount := askMount(t, agent, chat, asks)
			response := ask(mount, agent.ID, `{"prompt":"Review","schema":`+askSchema+`}`)
			if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "ANSWER_INVALID") || !strings.Contains(response.Body.String(), scenario.hint) {
				t.Fatalf("ask = %d %s", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), scenario.content) {
				t.Fatalf("the reply was echoed: %s", response.Body.String())
			}
			if len(chat.requests) != 1 {
				t.Fatalf("completions = %d, want exactly one (never retried)", len(chat.requests))
			}
			if len(asks.records) != 1 || asks.records[0].Status != "failed" || asks.records[0].FailureCode != "ANSWER_INVALID" || asks.records[0].InputTokens != 120 {
				t.Fatalf("records = %+v", asks.records)
			}
		})
	}
}

func TestAskRefusesBadRequestsAndUnavailableAgents(t *testing.T) {
	agent := availableAgent()
	chat := &fakeChat{content: `{"summary":"ok","score":1}`}
	asks := &fakeAsks{}
	mount := askMount(t, agent, chat, asks)
	for name, body := range map[string]string{
		"empty prompt":      `{"prompt":"  ","schema":` + askSchema + `}`,
		"missing schema":    `{"prompt":"Review"}`,
		"schema not object": `{"prompt":"Review","schema":"string"}`,
		"unknown type":      `{"prompt":"Review","schema":{"type":"thing"}}`,
		"unknown field":     `{"prompt":"Review","schema":` + askSchema + `,"temperature":1}`,
	} {
		response := ask(mount, agent.ID, body)
		if response.Code != http.StatusUnprocessableEntity && response.Code != http.StatusBadRequest {
			t.Fatalf("%s = %d %s", name, response.Code, response.Body.String())
		}
	}
	if len(chat.requests) != 0 {
		t.Fatalf("invalid requests reached the runtime: %+v", chat.requests)
	}
	offline := availableAgent()
	offline.Status = "offline"
	response := ask(askMount(t, offline, chat, asks), offline.ID, `{"prompt":"Review","schema":`+askSchema+`}`)
	if response.Code != http.StatusPreconditionFailed || !strings.Contains(response.Body.String(), "AGENT_UNAVAILABLE") {
		t.Fatalf("offline = %d %s", response.Code, response.Body.String())
	}
	limited := &fakeChat{err: &openfang.UpstreamError{Kind: openfang.ErrorRateLimited}}
	response = ask(askMount(t, agent, limited, asks), agent.ID, `{"prompt":"Review","schema":`+askSchema+`}`)
	if response.Code != http.StatusTooManyRequests || len(limited.requests) != 1 {
		t.Fatalf("rate limited = %d %s (calls %d)", response.Code, response.Body.String(), len(limited.requests))
	}
	down := &fakeChat{err: errors.New("connection refused")}
	response = ask(askMount(t, agent, down, asks), agent.ID, `{"prompt":"Review","schema":`+askSchema+`}`)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable = %d %s", response.Code, response.Body.String())
	}
	failed := 0
	for _, record := range asks.records {
		if record.Status == "failed" && record.FailureCode == "AGENT_CALL_FAILED" {
			failed++
		}
	}
	if failed != 2 {
		t.Fatalf("failed calls recorded = %d of %+v", failed, asks.records)
	}
	// Without a chat client the route does not exist.
	bare, err := NewMount(Options{Store: &agentStore{agent: agent}, Sessions: agentSessions{}, Authorization: agentAuthorizer{},
		Clock: time.Now, NewID: uuid.New, OpenFang: &agentRuntime{}})
	if err != nil {
		t.Fatal(err)
	}
	if response := ask(bare.Handler, agent.ID, `{"prompt":"Review","schema":`+askSchema+`}`); response.Code != http.StatusNotFound && response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("unmounted = %d", response.Code)
	}
}
