package realtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	MaxEventPayloadBytes = 64 * 1024
	maxWorkspaceIDBytes  = 128
	maxEventIDBytes      = 128
	maxEventTypeBytes    = 128
)

func normalizeEvent(event Event) (Event, error) {
	if strings.TrimSpace(event.ID) == "" {
		event.ID = uuid.NewString()
	}
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now().UTC()
	} else {
		event.OccurredAt = event.OccurredAt.UTC()
	}
	if event.Payload == nil {
		event.Payload = json.RawMessage("null")
	}
	if err := validateEvent(event); err != nil {
		return Event{}, err
	}
	event.Payload = append(json.RawMessage(nil), event.Payload...)
	return event, nil
}

func validateEvent(event Event) error {
	if !validIdentifier(event.ID, maxEventIDBytes) {
		return errors.New("realtime event requires a valid id")
	}
	if !validIdentifier(event.WorkspaceID, maxWorkspaceIDBytes) {
		return errors.New("realtime event requires a valid workspaceId")
	}
	if event.BoardID != "" && !validIdentifier(event.BoardID, maxWorkspaceIDBytes) {
		return errors.New("realtime event boardId is invalid")
	}
	if !validEventType(event.Type) {
		return errors.New("realtime event requires a valid type")
	}
	if len(event.Payload) > MaxEventPayloadBytes {
		return fmt.Errorf("realtime event payload exceeds %d bytes", MaxEventPayloadBytes)
	}
	if !json.Valid(event.Payload) {
		return errors.New("realtime event payload must be valid JSON")
	}
	if event.OccurredAt.IsZero() {
		return errors.New("realtime event requires occurredAt")
	}
	return nil
}

func validIdentifier(value string, maxBytes int) bool {
	if value == "" || len(value) > maxBytes || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '-' || character == '_' || character == '.' {
			continue
		}
		return false
	}
	return true
}

func validEventType(value string) bool {
	if value == "" || len(value) > maxEventTypeBytes || strings.TrimSpace(value) != value {
		return false
	}
	for index, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			character == '.' || character == '_' || character == '-' {
			if index == 0 && !(character >= 'a' && character <= 'z') {
				return false
			}
			continue
		}
		return false
	}
	return true
}

// scopes lists the subscription keys one event is delivered to. The board is
// listed once even when a caller passed the same id for both fields, so no
// subscriber sees a duplicate.
func (event Event) scopes() []string {
	if event.BoardID == "" || event.BoardID == event.WorkspaceID {
		return []string{event.WorkspaceID}
	}
	return []string{event.WorkspaceID, event.BoardID}
}
