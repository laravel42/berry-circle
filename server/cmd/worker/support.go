package main

import (
	"errors"
	"log/slog"

	"go.temporal.io/api/serviceerror"
	temporallog "go.temporal.io/sdk/log"
)

// isAlreadyStarted reports whether a start failed only because the workflow is
// already running, which is the normal outcome when a second worker replica
// boots and tries to ensure the singleton intake loop.
func isAlreadyStarted(err error) bool {
	var alreadyStarted *serviceerror.WorkflowExecutionAlreadyStarted
	return errors.As(err, &alreadyStarted)
}

// slogAdapter routes Temporal SDK logs through the server's structured logger
// so worker output matches the API's format.
type slogAdapter struct {
	logger *slog.Logger
}

func newTemporalLogger(logger *slog.Logger) temporallog.Logger {
	return &slogAdapter{logger: logger}
}

func (adapter *slogAdapter) Debug(message string, keyvals ...any) {
	adapter.logger.Debug(message, keyvals...)
}

func (adapter *slogAdapter) Info(message string, keyvals ...any) {
	adapter.logger.Info(message, keyvals...)
}

func (adapter *slogAdapter) Warn(message string, keyvals ...any) {
	adapter.logger.Warn(message, keyvals...)
}

func (adapter *slogAdapter) Error(message string, keyvals ...any) {
	adapter.logger.Error(message, keyvals...)
}
