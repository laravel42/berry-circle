package openfang

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
)

// StreamEventType is the bounded pinned upstream SSE event vocabulary.
type StreamEventType string

const (
	EventChunk      StreamEventType = "chunk"
	EventToolUse    StreamEventType = "tool_use"
	EventToolResult StreamEventType = "tool_result"
	EventPhase      StreamEventType = "phase"
	EventDone       StreamEventType = "done"
	EventUnknown    StreamEventType = "unknown"
)

// Usage is the token count one done event reports for the turn it closes.
// The pinned upstream emits done at the end of every model turn, not once per
// run, so a run's total is the sum over its done events.
type Usage struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
}

// StreamEvent contains one validated upstream event. Raw is bounded and is
// populated only for unknown named events; callers must not expose it directly.
type StreamEvent struct {
	Type      StreamEventType
	Content   string
	Tool      string
	Input     json.RawMessage
	Phase     string
	Detail    *string
	Usage     Usage
	EventName string
	Raw       json.RawMessage
}

// StreamErrorKind classifies stream failures without exposing raw payloads.
type StreamErrorKind string

const (
	StreamInterrupted StreamErrorKind = "interrupted"
	StreamMalformed   StreamErrorKind = "malformed"
	StreamLimit       StreamErrorKind = "limit_exceeded"
	StreamTimeout     StreamErrorKind = "timeout"
)

// ErrStreamInterrupted is matched for every non-successful stream ending.
var ErrStreamInterrupted = errors.New("runtime stream interrupted")

// StreamError carries only a stable classification and upstream request ID.
type StreamError struct {
	Kind      StreamErrorKind
	RequestID string
}

func (err *StreamError) Error() string {
	return fmt.Sprintf("runtime stream failed (%s)", err.Kind)
}

func (err *StreamError) Unwrap() error {
	return ErrStreamInterrupted
}

// MessageStream reads one bounded SSE event at a time.
type MessageStream struct {
	ctx        context.Context
	cancel     context.CancelFunc
	body       io.ReadCloser
	scanner    *bufio.Scanner
	requestID  string
	maxTotal   int64
	maxEvent   int
	total      int64
	eventName  string
	dataLines  []string
	frameBytes int
	eof        bool
	// turns counts done events. It decides what the end of the body means:
	// after at least one turn it is the run finishing, before any it is the
	// connection dropping mid-work.
	turns     int
	closeOnce sync.Once
}

func newMessageStream(
	ctx context.Context,
	cancel context.CancelFunc,
	body io.ReadCloser,
	requestID string,
	maxTotal int64,
	maxEvent int,
) *MessageStream {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), maxEvent)
	return &MessageStream{
		ctx:       ctx,
		cancel:    cancel,
		body:      body,
		scanner:   scanner,
		requestID: requestID,
		maxTotal:  maxTotal,
		maxEvent:  maxEvent,
	}
}

// RequestID is the upstream x-request-id captured before streaming.
func (stream *MessageStream) RequestID() string {
	if stream == nil {
		return ""
	}
	return stream.requestID
}

// Next returns events in arrival order until the body ends.
//
// A done event is a turn boundary, not the end of the stream: the pinned
// upstream keeps the connection open and starts the next model turn on it
// whenever the previous one called a tool. Hanging up at the first done made
// Berry record a run as finished while the agent was still working. So the
// end of the body is the completion signal: it is io.EOF after at least one
// done, and interrupted before any. Read, parse, and limit failures are
// interrupted (or their own kind) whatever the turn count.
func (stream *MessageStream) Next() (StreamEvent, error) {
	if stream == nil || stream.scanner == nil {
		return StreamEvent{}, errors.New("runtime stream is not configured")
	}
	if stream.eof {
		return StreamEvent{}, stream.finish()
	}
	if err := stream.ctx.Err(); err != nil {
		return StreamEvent{}, stream.contextFailure(err)
	}

	for stream.scanner.Scan() {
		line := stream.scanner.Text()
		stream.total += int64(len(line) + 1)
		stream.frameBytes += len(line) + 1
		if stream.maxTotal < 1 || stream.total > stream.maxTotal ||
			stream.maxEvent < 1 || stream.frameBytes > stream.maxEvent {
			stream.Close()
			return StreamEvent{}, stream.failure(StreamLimit)
		}
		if strings.TrimSuffix(line, "\r") == "" {
			if stream.eventName == "" && len(stream.dataLines) == 0 {
				stream.frameBytes = 0
				continue
			}
			return stream.emit()
		}
		stream.consumeLine(strings.TrimSuffix(line, "\r"))
	}

	if err := stream.scanner.Err(); err != nil {
		stream.Close()
		if contextErr := stream.ctx.Err(); contextErr != nil {
			return StreamEvent{}, stream.contextFailure(contextErr)
		}
		if strings.Contains(err.Error(), "token too long") {
			return StreamEvent{}, stream.failure(StreamLimit)
		}
		return StreamEvent{}, stream.failure(StreamInterrupted)
	}

	stream.eof = true
	if stream.eventName != "" || len(stream.dataLines) > 0 {
		return stream.emit()
	}
	return StreamEvent{}, stream.finish()
}

// emit projects the buffered frame and counts the turn it may close.
func (stream *MessageStream) emit() (StreamEvent, error) {
	event, err := stream.project()
	stream.resetFrame()
	if err != nil {
		stream.Close()
		return StreamEvent{}, err
	}
	if event.Type == EventDone {
		stream.turns++
	}
	return event, nil
}

// finish classifies a body that ended without a read error.
func (stream *MessageStream) finish() error {
	stream.Close()
	if stream.turns > 0 {
		return io.EOF
	}
	return stream.failure(StreamInterrupted)
}

// Close releases the response body and timeout wiring. It is idempotent.
func (stream *MessageStream) Close() error {
	if stream == nil {
		return nil
	}
	var closeErr error
	stream.closeOnce.Do(func() {
		if stream.body != nil {
			closeErr = stream.body.Close()
		}
		if stream.cancel != nil {
			stream.cancel()
		}
	})
	return closeErr
}

func (stream *MessageStream) consumeLine(line string) {
	if line == "" || strings.HasPrefix(line, ":") {
		return
	}
	field, value, found := strings.Cut(line, ":")
	if !found {
		value = ""
	}
	if strings.HasPrefix(value, " ") {
		value = value[1:]
	}
	switch field {
	case "event":
		stream.eventName = value
	case "data":
		stream.dataLines = append(stream.dataLines, value)
	}
}

func (stream *MessageStream) project() (StreamEvent, error) {
	if stream.eventName == "" || len(stream.dataLines) == 0 ||
		len(stream.eventName) > 100 {
		return StreamEvent{}, stream.failure(StreamMalformed)
	}
	data := []byte(strings.Join(stream.dataLines, "\n"))
	if len(data) > stream.maxEvent || !json.Valid(data) {
		return StreamEvent{}, stream.failure(StreamMalformed)
	}

	switch stream.eventName {
	case string(EventChunk):
		var value struct {
			Content string `json:"content"`
		}
		if json.Unmarshal(data, &value) != nil || len(value.Content) > 64*1024 {
			return StreamEvent{}, stream.failure(StreamMalformed)
		}
		return StreamEvent{Type: EventChunk, Content: value.Content}, nil
	case string(EventToolUse):
		var value struct {
			Tool string `json:"tool"`
		}
		if json.Unmarshal(data, &value) != nil || !validEventLabel(value.Tool, 256) {
			return StreamEvent{}, stream.failure(StreamMalformed)
		}
		return StreamEvent{Type: EventToolUse, Tool: value.Tool}, nil
	case string(EventToolResult):
		var value struct {
			Tool  string          `json:"tool"`
			Input json.RawMessage `json:"input"`
		}
		if json.Unmarshal(data, &value) != nil || !validEventLabel(value.Tool, 256) {
			return StreamEvent{}, stream.failure(StreamMalformed)
		}
		if len(value.Input) == 0 {
			value.Input = json.RawMessage("{}")
		}
		if len(value.Input) > 64*1024 || !json.Valid(value.Input) {
			return StreamEvent{}, stream.failure(StreamMalformed)
		}
		return StreamEvent{
			Type:  EventToolResult,
			Tool:  value.Tool,
			Input: append(json.RawMessage(nil), value.Input...),
		}, nil
	case string(EventPhase):
		var value struct {
			Phase  string  `json:"phase"`
			Detail *string `json:"detail"`
		}
		if json.Unmarshal(data, &value) != nil || !validEventLabel(value.Phase, 256) {
			return StreamEvent{}, stream.failure(StreamMalformed)
		}
		if value.Detail != nil && len(*value.Detail) > 4096 {
			return StreamEvent{}, stream.failure(StreamMalformed)
		}
		return StreamEvent{Type: EventPhase, Phase: value.Phase, Detail: value.Detail}, nil
	case string(EventDone):
		var value struct {
			Done  bool  `json:"done"`
			Usage Usage `json:"usage"`
		}
		if json.Unmarshal(data, &value) != nil || !value.Done ||
			value.Usage.InputTokens < 0 || value.Usage.OutputTokens < 0 {
			return StreamEvent{}, stream.failure(StreamMalformed)
		}
		return StreamEvent{Type: EventDone, Usage: value.Usage}, nil
	default:
		if !validEventLabel(stream.eventName, 100) {
			return StreamEvent{}, stream.failure(StreamMalformed)
		}
		return StreamEvent{
			Type:      EventUnknown,
			EventName: stream.eventName,
			Raw:       append(json.RawMessage(nil), data...),
		}, nil
	}
}

func (stream *MessageStream) resetFrame() {
	stream.eventName = ""
	stream.dataLines = stream.dataLines[:0]
	stream.frameBytes = 0
}

func (stream *MessageStream) contextFailure(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return stream.failure(StreamTimeout)
	}
	return stream.failure(StreamInterrupted)
}

func (stream *MessageStream) failure(kind StreamErrorKind) *StreamError {
	return &StreamError{Kind: kind, RequestID: stream.requestID}
}

func validEventLabel(value string, maxBytes int) bool {
	return value != "" && len(value) <= maxBytes && strings.TrimSpace(value) == value
}
