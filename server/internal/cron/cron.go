// Package cron parses five-field cron expressions and computes fire times in
// a named timezone.
//
// It exists so schedule triggers (P4.5) never depend on robfig/cron, which is
// only an indirect dependency pulled in by Temporal and whose v1 API is
// unmaintained. The grammar is the classic one: minute, hour, day of month,
// month and day of week, each a list of values, ranges and steps, plus the
// @hourly … @yearly aliases. Names are not accepted: the validator already
// refuses letters, and a numeric-only grammar has no locale.
//
// Fire times are computed on the wall clock of the schedule's timezone and
// then resolved to an instant, so "09:00 Europe/Rome" fires at 08:00 UTC in
// winter and 07:00 UTC in summer. A wall-clock time that does not exist on a
// spring-forward day is skipped; one that exists twice on a fall-back day
// fires once.
package cron

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Schedule is a parsed expression.
type Schedule struct {
	expression string
	minutes    [60]bool
	hours      [24]bool
	days       [32]bool
	months     [13]bool
	weekdays   [7]bool
	// anyDay and anyWeekday record a "*" in the day-of-month and day-of-week
	// fields: when both are restricted a day matches either (the POSIX
	// rule), when one is "*" the other decides alone.
	anyDay     bool
	anyWeekday bool
}

// lookahead bounds the search for the next fire time. An expression that
// never matches ("0 0 31 2 *") stops here instead of spinning forever.
const lookahead = 5

var aliases = map[string]string{
	"@hourly":  "0 * * * *",
	"@daily":   "0 0 * * *",
	"@weekly":  "0 0 * * 0",
	"@monthly": "0 0 1 * *",
	"@yearly":  "0 0 1 1 *",
}

type field struct {
	name string
	min  int
	max  int
}

var fields = [5]field{
	{"minute", 0, 59}, {"hour", 0, 23}, {"day of month", 1, 31}, {"month", 1, 12}, {"day of week", 0, 7},
}

// Parse reads an expression. The error names the field that is wrong and
// never echoes more than the offending token.
func Parse(expression string) (Schedule, error) {
	trimmed := strings.TrimSpace(expression)
	if alias, ok := aliases[trimmed]; ok {
		trimmed = alias
	}
	parts := strings.Fields(trimmed)
	if len(parts) != 5 {
		return Schedule{}, errors.New("cron: an expression has five fields: minute hour day-of-month month day-of-week")
	}
	schedule := Schedule{expression: strings.Join(parts, " ")}
	sets := [5][]bool{
		schedule.minutes[:], schedule.hours[:], schedule.days[:], schedule.months[:], make([]bool, 8),
	}
	for index, part := range parts {
		spec := fields[index]
		star, err := parseField(part, spec, sets[index])
		if err != nil {
			return Schedule{}, err
		}
		switch index {
		case 2:
			schedule.anyDay = star
		case 4:
			schedule.anyWeekday = star
		}
	}
	// 7 is Sunday too; fold it onto 0 so the weekday table has one entry.
	for day := 0; day < 7; day++ {
		schedule.weekdays[day] = sets[4][day]
	}
	if sets[4][7] {
		schedule.weekdays[0] = true
	}
	return schedule, nil
}

// parseField fills set with the values a field names and reports whether the
// field was an unrestricted "*".
func parseField(text string, spec field, set []bool) (bool, error) {
	if text == "" {
		return false, fmt.Errorf("cron: the %s field is empty", spec.name)
	}
	star := false
	for _, item := range strings.Split(text, ",") {
		base, step := item, 1
		if before, after, ok := strings.Cut(item, "/"); ok {
			parsed, err := strconv.Atoi(after)
			if err != nil || parsed < 1 || parsed > spec.max {
				return false, fmt.Errorf("cron: the %s field has an invalid step %q", spec.name, after)
			}
			base, step = before, parsed
		}
		low, high := spec.min, spec.max
		switch {
		case base == "*":
			if step == 1 && item == "*" {
				star = true
			}
		case strings.Contains(base, "-"):
			from, to, _ := strings.Cut(base, "-")
			var err error
			if low, err = parseValue(from, spec); err != nil {
				return false, err
			}
			if high, err = parseValue(to, spec); err != nil {
				return false, err
			}
			if low > high {
				return false, fmt.Errorf("cron: the %s field has a reversed range %q", spec.name, base)
			}
		default:
			value, err := parseValue(base, spec)
			if err != nil {
				return false, err
			}
			low = value
			if step == 1 {
				high = value
			}
		}
		for value := low; value <= high; value += step {
			set[value] = true
		}
	}
	return star, nil
}

func parseValue(text string, spec field) (int, error) {
	value, err := strconv.Atoi(text)
	if err != nil || value < spec.min || value > spec.max {
		return 0, fmt.Errorf("cron: the %s field has an invalid value %q (%d..%d)", spec.name, text, spec.min, spec.max)
	}
	return value, nil
}

// String returns the normalised five-field expression.
func (schedule Schedule) String() string {
	return schedule.expression
}

// wall is a wall-clock instant without a zone.
type wall struct {
	year, month, day, hour, minute int
}

func (clock wall) weekday() time.Weekday {
	return time.Date(clock.year, time.Month(clock.month), clock.day, 0, 0, 0, 0, time.UTC).Weekday()
}

// normalise rolls overflowed fields the way the calendar does.
func (clock wall) normalise() wall {
	rolled := time.Date(clock.year, time.Month(clock.month), clock.day, clock.hour, clock.minute, 0, 0, time.UTC)
	return wall{rolled.Year(), int(rolled.Month()), rolled.Day(), rolled.Hour(), rolled.Minute()}
}

func (schedule Schedule) matchesDay(clock wall) bool {
	day := schedule.days[clock.day]
	weekday := schedule.weekdays[clock.weekday()]
	switch {
	case schedule.anyDay && schedule.anyWeekday:
		return true
	case schedule.anyDay:
		return weekday
	case schedule.anyWeekday:
		return day
	default:
		return day || weekday
	}
}

// Next returns the first fire time strictly after the instant, in the
// location, or false when none exists within the lookahead.
func (schedule Schedule) Next(after time.Time, location *time.Location) (time.Time, bool) {
	if location == nil {
		location = time.UTC
	}
	local := after.In(location)
	clock := wall{local.Year(), int(local.Month()), local.Day(), local.Hour(), local.Minute() + 1}.normalise()
	limit := local.Year() + lookahead
	for clock.year <= limit {
		switch {
		case !schedule.months[clock.month]:
			clock = wall{clock.year, clock.month + 1, 1, 0, 0}.normalise()
		case !schedule.matchesDay(clock):
			clock = wall{clock.year, clock.month, clock.day + 1, 0, 0}.normalise()
		case !schedule.hours[clock.hour]:
			clock = wall{clock.year, clock.month, clock.day, clock.hour + 1, 0}.normalise()
		case !schedule.minutes[clock.minute]:
			clock = wall{clock.year, clock.month, clock.day, clock.hour, clock.minute + 1}.normalise()
		default:
			candidate := time.Date(clock.year, time.Month(clock.month), clock.day, clock.hour, clock.minute, 0, 0, location)
			// A wall-clock minute the zone skipped resolves to another
			// minute; it never existed, so it never fires.
			if candidate.Day() != clock.day || candidate.Hour() != clock.hour || candidate.Minute() != clock.minute || !candidate.After(after) {
				clock = wall{clock.year, clock.month, clock.day, clock.hour, clock.minute + 1}.normalise()
				continue
			}
			return candidate, true
		}
	}
	return time.Time{}, false
}

// NextIn is Next with the location named as an IANA zone.
func (schedule Schedule) NextIn(after time.Time, timezone string) (time.Time, error) {
	location, err := time.LoadLocation(timezone)
	if err != nil || timezone == "" || timezone == "Local" {
		return time.Time{}, fmt.Errorf("cron: %q is not an IANA timezone", timezone)
	}
	next, ok := schedule.Next(after, location)
	if !ok {
		return time.Time{}, errors.New("cron: the expression never fires within the next five years")
	}
	return next, nil
}
