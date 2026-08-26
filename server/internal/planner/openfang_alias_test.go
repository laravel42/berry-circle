package planner

import "github.com/laravel42/berry-circle/server/internal/openfang"

// Short names for the runtime chat types the fakes implement.
type (
	openfangModel   = openfang.ModelSummary
	openfangRequest = openfang.ChatCompletionRequest
	openfangResult  = openfang.ChatCompletionResult
)
