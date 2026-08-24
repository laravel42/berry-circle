package openfang

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestMessageStreamProjectsPinnedEventsAndDone(t *testing.T) {
	t.Parallel()
	body := strings.Join([]string{
		": keep-alive\n\n",
		"event: phase\ndata: {\"phase\":\"start\",\"detail\":null}\n\n",
		"event: chunk\ndata: {\"content\":\"hello\",\"done\":false}\n\n",
		"event: tool_use\ndata: {\"tool\":\"file_read\"}\n\n",
		"event: tool_result\ndata: {\"tool\":\"file_read\",\"input\":{\"path\":\"a.go\"}}\n\n",
		"event: done\ndata: {\"done\":true,\"usage\":{\"input_tokens\":12,\"output_tokens\":3}}\n\n",
	}, "")
	stream := testMessageStream(body, 1024*1024, 128*1024)
	defer stream.Close()

	var got []StreamEvent
	for {
		event, err := stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("Next() error = %v", err)
		}
		got = append(got, event)
	}
	if len(got) != 5 {
		t.Fatalf("event count = %d, want 5", len(got))
	}
	if got[0].Type != EventPhase || got[1].Content != "hello" ||
		got[2].Tool != "file_read" || string(got[3].Input) != `{"path":"a.go"}` ||
		got[4].Usage.InputTokens != 12 || got[4].Usage.OutputTokens != 3 {
		t.Fatalf("events = %#v", got)
	}
}

func TestMessageStreamEOFBeforeDoneIsInterruptedAfterPartialEvents(t *testing.T) {
	t.Parallel()
	stream := testMessageStream(
		"event: chunk\ndata: {\"content\":\"partial\"}\n\n",
		1024*1024,
		128*1024,
	)
	defer stream.Close()
	event, err := stream.Next()
	if err != nil || event.Type != EventChunk {
		t.Fatalf("first Next() event=%#v err=%v", event, err)
	}
	_, err = stream.Next()
	if !errors.Is(err, ErrStreamInterrupted) {
		t.Fatalf("second Next() error = %v, want ErrStreamInterrupted", err)
	}
}

func TestMessageStreamRejectsMalformedAndOversizedFrames(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name string
		body string
		max  int
		kind StreamErrorKind
	}{
		{
			name: "malformed json",
			body: "event: chunk\ndata: not-json\n\n",
			max:  1024,
			kind: StreamMalformed,
		},
		{
			name: "oversized event",
			body: "event: chunk\ndata: {\"content\":\"" + strings.Repeat("x", 1024) + "\"}\n\n",
			max:  128,
			kind: StreamLimit,
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			stream := testMessageStream(test.body, 4096, test.max)
			defer stream.Close()
			_, err := stream.Next()
			var streamErr *StreamError
			if !errors.As(err, &streamErr) || streamErr.Kind != test.kind {
				t.Fatalf("Next() error = %#v, want kind %s", err, test.kind)
			}
		})
	}
}

func testMessageStream(body string, maxTotal int64, maxEvent int) *MessageStream {
	ctx, cancel := context.WithCancel(context.Background())
	return newMessageStream(
		ctx,
		cancel,
		io.NopCloser(strings.NewReader(body)),
		"upstream-request",
		maxTotal,
		maxEvent,
	)
}
