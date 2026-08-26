package automation

import "strings"

// BerryEventTopics is the outbox vocabulary a berry_event trigger or an event
// wait may subscribe to. It mirrors outbox_events_trigger_dispatch_order_idx
// (migration 019): a topic missing here is never scanned by the dispatcher,
// so accepting it in a definition would create a workflow that can never run.
var BerryEventTopics = []string{
	"issue.created", "issue.updated", "issue.assigned", "issue.started", "issue.completed", "issue.deleted",
	"goal.created", "goal.started", "goal.completed", "goal.cancelled",
	"run.completed", "run.failed", "run.cancelled",
	"agent.started", "agent.completed", "agent.failed",
	"approval.requested", "approval.approved", "approval.rejected", "approval.expired",
	"artifact.created", "integration.webhook.received", "plan.updated",
}

var berryEventIndex = func() map[string]bool {
	index := make(map[string]bool, len(BerryEventTopics))
	for _, topic := range BerryEventTopics {
		index[topic] = true
	}
	return index
}()

// KnownBerryEvent reports whether a topic is published. "<aggregate>.*"
// subscribes to every topic of one aggregate.
func KnownBerryEvent(topic string) bool {
	if berryEventIndex[topic] {
		return true
	}
	aggregate, suffix, ok := strings.Cut(topic, ".")
	if !ok || suffix != "*" {
		return false
	}
	for _, known := range BerryEventTopics {
		if strings.HasPrefix(known, aggregate+".") {
			return true
		}
	}
	return false
}

// MatchesBerryEvent reports whether a published topic satisfies a trigger's
// event, which is either the exact topic or an "<aggregate>.*" wildcard.
func MatchesBerryEvent(subscription, topic string) bool {
	if subscription == topic {
		return true
	}
	aggregate, suffix, ok := strings.Cut(subscription, ".")
	return ok && suffix == "*" && strings.HasPrefix(topic, aggregate+".")
}
