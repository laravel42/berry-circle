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

// The pinned upstream emits done at the end of every model turn on the same
// connection. Reading must continue past it, and only the end of the body
// after at least one done is a clean finish.
func TestMessageStreamTreatsDoneAsTurnBoundaryUntilEOF(t *testing.T) {
	t.Parallel()
	body := strings.Join([]string{
		"event: phase\ndata: {\"phase\":\"start\",\"detail\":null}\n\n",
		"event: chunk\ndata: {\"content\":\"I'll look into it\"}\n\n",
		"event: tool_use\ndata: {\"tool\":\"file_read\"}\n\n",
		"event: tool_result\ndata: {\"tool\":\"file_read\",\"input\":{}}\n\n",
		"event: done\ndata: {\"done\":true,\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}\n\n",
		"event: phase\ndata: {\"phase\":\"tool_loop\",\"detail\":null}\n\n",
		"event: chunk\ndata: {\"content\":\"Final report\"}\n\n",
		"event: done\ndata: {\"done\":true,\"usage\":{\"input_tokens\":20,\"output_tokens\":2}}\n\n",
		"event: phase\ndata: {\"phase\":\"done\",\"detail\":null}\n\n",
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
			t.Fatalf("Next() error = %v after %d events", err, len(got))
		}
		got = append(got, event)
	}
	if len(got) != 9 {
		t.Fatalf("event count = %d, want 9", len(got))
	}
	if got[4].Type != EventDone || got[4].Usage.InputTokens != 10 ||
		got[6].Content != "Final report" ||
		got[7].Type != EventDone || got[7].Usage.OutputTokens != 2 ||
		got[8].Type != EventPhase || got[8].Phase != "done" {
		t.Fatalf("events = %#v", got)
	}
	// The clean end is sticky: a caller that polls again keeps getting EOF
	// rather than an interruption.
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("Next() after EOF error = %v, want io.EOF", err)
	}
}

func TestMessageStreamDoneInTrailingFrameStillEndsCleanly(t *testing.T) {
	t.Parallel()
	// No blank line after the last frame: the body ends mid-frame and the
	// done has to be projected from what was buffered.
	stream := testMessageStream(
		"event: chunk\ndata: {\"content\":\"answer\"}\n\n"+
			"event: done\ndata: {\"done\":true,\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}",
		1024*1024,
		128*1024,
	)
	defer stream.Close()
	if event, err := stream.Next(); err != nil || event.Type != EventChunk {
		t.Fatalf("first Next() event=%#v err=%v", event, err)
	}
	if event, err := stream.Next(); err != nil || event.Type != EventDone {
		t.Fatalf("second Next() event=%#v err=%v", event, err)
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("third Next() error = %v, want io.EOF", err)
	}
}

// A connection dropped after a done but before the next one is
// indistinguishable from a clean end: the text that arrived is delivered and
// the body ends with io.EOF. Documented as the accepted trade-off in
// docs/api/openfang-gateway-consumption.md; pinned here so it cannot change
// silently.
func TestMessageStreamDeliversTextAfterTheLastDoneThenEOF(t *testing.T) {
	t.Parallel()
	stream := testMessageStream(
		"event: done\ndata: {\"done\":true,\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n\n"+
			"event: chunk\ndata: {\"content\":\"late\"}\n\n",
		1024*1024,
		128*1024,
	)
	defer stream.Close()
	if event, err := stream.Next(); err != nil || event.Type != EventDone {
		t.Fatalf("first Next() event=%#v err=%v", event, err)
	}
	if event, err := stream.Next(); err != nil || event.Content != "late" {
		t.Fatalf("second Next() event=%#v err=%v", event, err)
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("third Next() error = %v, want io.EOF", err)
	}
}

func TestMessageStreamEOFAfterEventsButBeforeAnyDoneIsInterrupted(t *testing.T) {
	t.Parallel()
	stream := testMessageStream(
		"event: chunk\ndata: {\"content\":\"working\"}\n\n"+
			"event: tool_use\ndata: {\"tool\":\"shell\"}\n\n"+
			"event: phase\ndata: {\"phase\":\"tool_loop\",\"detail\":null}\n\n",
		1024*1024,
		128*1024,
	)
	defer stream.Close()
	for range 3 {
		if _, err := stream.Next(); err != nil {
			t.Fatalf("Next() error = %v", err)
		}
	}
	_, err := stream.Next()
	var streamErr *StreamError
	if !errors.As(err, &streamErr) || streamErr.Kind != StreamInterrupted {
		t.Fatalf("Next() error = %#v, want interrupted", err)
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
