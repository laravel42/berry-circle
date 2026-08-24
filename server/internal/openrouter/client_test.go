package openrouter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The payload is shaped like OpenRouter's real response: per-token prices as
// decimal strings, tool support inside supported_parameters, and vision implied
// by an input modality rather than a flag.
const catalogPayload = `{"data":[
  {"id":"deepseek/deepseek-v4-flash-0731","name":"DeepSeek: DeepSeek V4 Flash 0731",
   "context_length":1310720,
   "architecture":{"input_modalities":["text"]},
   "pricing":{"prompt":"0.000000066","completion":"0.000000132"},
   "supported_parameters":["tools","reasoning"]},
  {"id":"google/gemini-3.7-flash","name":"Google: Gemini 3.7 Flash",
   "context_length":1048576,
   "architecture":{"input_modalities":["text","image","video"]},
   "pricing":{"prompt":"0.00000038","completion":"0.00000188"},
   "supported_parameters":["tools"]},
  {"id":"","name":"nameless"},
  {"id":"legacy/no-pricing","name":"Legacy",
   "context_length":4096,
   "architecture":{"input_modalities":["text"]},
   "pricing":{"prompt":"","completion":""},
   "supported_parameters":[]}
]}`

func serve(t *testing.T, status int, body string) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/models" {
				t.Errorf("path = %q, want /models", request.URL.Path)
			}
			response.WriteHeader(status)
			_, _ = response.Write([]byte(body))
		}))
	t.Cleanup(server.Close)
	return New(server.URL, server.Client())
}

func TestListModelsConvertsPerTokenPricesToPerMillion(t *testing.T) {
	models, err := serve(t, http.StatusOK, catalogPayload).ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	// The entry with no id is unusable and must not reach the picker.
	if len(models) != 3 {
		t.Fatalf("models = %d, want 3 (the id-less entry is dropped)", len(models))
	}
	first := models[0]
	if first.ID != "deepseek/deepseek-v4-flash-0731" {
		t.Errorf("ID = %q", first.ID)
	}
	// 0.000000066 per token is $0.066 per million.
	if first.InputCostPerM < 0.0659 || first.InputCostPerM > 0.0661 {
		t.Errorf("InputCostPerM = %v, want ~0.066", first.InputCostPerM)
	}
	if first.OutputCostPerM < 0.1319 || first.OutputCostPerM > 0.1321 {
		t.Errorf("OutputCostPerM = %v, want ~0.132", first.OutputCostPerM)
	}
	if !first.SupportsTools {
		t.Error("SupportsTools should be read from supported_parameters")
	}
	if first.SupportsVision {
		t.Error("a text-only model must not report vision")
	}
	if !models[1].SupportsVision {
		t.Error("an image input modality means vision")
	}
	// An unparsable price costs one column, not the whole catalog.
	if models[2].InputCostPerM != 0 {
		t.Errorf("unparsable price = %v, want 0", models[2].InputCostPerM)
	}
}

func TestListModelsRejectsANonOKStatus(t *testing.T) {
	if _, err := serve(t, http.StatusInternalServerError, "{}").
		ListModels(context.Background()); err == nil {
		t.Error("a 500 must be an error, not an empty catalog")
	}
}

func TestListModelsRejectsMalformedJSON(t *testing.T) {
	if _, err := serve(t, http.StatusOK, "not json").
		ListModels(context.Background()); err == nil {
		t.Error("malformed JSON must be an error")
	}
}
