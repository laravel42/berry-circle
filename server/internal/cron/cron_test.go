package cron

import (
	"testing"
	"time"

	_ "time/tzdata"
)

func mustLocation(t *testing.T, name string) *time.Location {
	t.Helper()
	location, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("load %s: %v", name, err)
	}
	return location
}

func mustParse(t *testing.T, expression string) Schedule {
	t.Helper()
	schedule, err := Parse(expression)
	if err != nil {
		t.Fatalf("Parse(%q) error = %v", expression, err)
	}
	return schedule
}

// "Every Monday 09:00 Europe/Rome" fires at 08:00 UTC in winter and 07:00
// UTC in summer, and the sequence crosses both DST changes without a
// duplicate or a gap.
func TestMondayNineRomeAcrossDST(t *testing.T) {
	t.Parallel()
	rome := mustLocation(t, "Europe/Rome")
	schedule := mustParse(t, "0 9 * * 1")
	after := time.Date(2026, time.March, 20, 12, 0, 0, 0, time.UTC)
	want := []string{
		"2026-03-23T08:00:00Z", // still CET
		"2026-03-30T07:00:00Z", // first Monday after the 29 March change: CEST
		"2026-04-06T07:00:00Z",
	}
	for _, expected := range want {
		next, ok := schedule.Next(after, rome)
		if !ok {
			t.Fatalf("Next(%s) found nothing", after)
		}
		if got := next.UTC().Format(time.RFC3339); got != expected {
			t.Fatalf("Next(%s) = %s, want %s", after.Format(time.RFC3339), got, expected)
		}
		if next.In(rome).Hour() != 9 || next.In(rome).Weekday() != time.Monday {
			t.Fatalf("Next(%s) = %s is not Monday 09:00 in Rome", after, next.In(rome))
		}
		after = next
	}
	// And back to winter in October.
	after = time.Date(2026, time.October, 20, 12, 0, 0, 0, time.UTC)
	want = []string{"2026-10-26T08:00:00Z", "2026-11-02T08:00:00Z"}
	for _, expected := range want {
		next, ok := schedule.Next(after, rome)
		if !ok || next.UTC().Format(time.RFC3339) != expected {
			t.Fatalf("Next(%s) = %s, %v, want %s", after.Format(time.RFC3339), next.UTC().Format(time.RFC3339), ok, expected)
		}
		after = next
	}
}

// A wall-clock time the zone skips (02:30 on the spring-forward day) does
// not fire; the next real 02:30 does. The repeated hour on the fall-back
// day fires once.
func TestSkippedAndRepeatedWallClockTimes(t *testing.T) {
	t.Parallel()
	rome := mustLocation(t, "Europe/Rome")
	schedule := mustParse(t, "30 2 * * *")
	after := time.Date(2026, time.March, 28, 12, 0, 0, 0, time.UTC)
	next, ok := schedule.Next(after, rome)
	if !ok || next.UTC().Format(time.RFC3339) != "2026-03-30T00:30:00Z" {
		t.Fatalf("spring forward: Next = %s, %v; want 2026-03-30T00:30:00Z (02:30 CEST)", next.UTC().Format(time.RFC3339), ok)
	}
	after = time.Date(2026, time.October, 24, 12, 0, 0, 0, time.UTC)
	first, ok := schedule.Next(after, rome)
	if !ok || first.In(rome).Hour() != 2 || first.In(rome).Minute() != 30 || first.In(rome).Day() != 25 {
		t.Fatalf("fall back: first = %s, %v", first.In(rome), ok)
	}
	second, ok := schedule.Next(first, rome)
	if !ok || second.In(rome).Day() != 26 {
		t.Fatalf("fall back: second fire = %s, want 26 October (one fire per day)", second.In(rome))
	}
	if second.Sub(first) < 23*time.Hour {
		t.Fatalf("fall back: fires %s apart", second.Sub(first))
	}
}

// Month ends: the 31st only exists in some months, and a leap day only in
// leap years.
func TestMonthEnds(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		expression string
		after      string
		want       []string
	}{
		"31st skips short months": {"0 0 31 * *", "2026-01-31T00:00:00Z",
			[]string{"2026-03-31T00:00:00Z", "2026-05-31T00:00:00Z", "2026-07-31T00:00:00Z"}},
		"last day of february in a leap year": {"0 12 29 2 *", "2026-01-01T00:00:00Z",
			[]string{"2028-02-29T12:00:00Z"}},
		"monthly alias": {"@monthly", "2026-01-31T23:59:00Z",
			[]string{"2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"}},
		"december rolls the year": {"0 0 1 1 *", "2026-01-01T00:00:00Z",
			[]string{"2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z"}},
	}
	for name, scenario := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			schedule := mustParse(t, scenario.expression)
			after, err := time.Parse(time.RFC3339, scenario.after)
			if err != nil {
				t.Fatal(err)
			}
			for _, expected := range scenario.want {
				next, ok := schedule.Next(after, time.UTC)
				if !ok || next.Format(time.RFC3339) != expected {
					t.Fatalf("Next(%s) = %s, %v, want %s", after.Format(time.RFC3339), next.Format(time.RFC3339), ok, expected)
				}
				after = next
			}
		})
	}
}

// Steps, lists and ranges, and the day-of-month/day-of-week OR rule.
func TestStepsListsAndRanges(t *testing.T) {
	t.Parallel()
	schedule := mustParse(t, "*/15 9-10 * * *")
	after := time.Date(2026, time.August, 24, 8, 50, 0, 0, time.UTC)
	want := []string{"09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45"}
	for _, expected := range want {
		next, ok := schedule.Next(after, time.UTC)
		if !ok || next.Format("15:04") != expected || next.Day() != 24 {
			t.Fatalf("Next(%s) = %s, want %s", after.Format(time.RFC3339), next.Format(time.RFC3339), expected)
		}
		after = next
	}
	next, ok := schedule.Next(after, time.UTC)
	if !ok || next.Day() != 25 || next.Format("15:04") != "09:00" {
		t.Fatalf("after the last slot = %s", next.Format(time.RFC3339))
	}

	list := mustParse(t, "0 8,20 * * 1,3,5")
	after = time.Date(2026, time.August, 24, 9, 0, 0, 0, time.UTC) // Monday 09:00
	got := []string{}
	for range 4 {
		next, ok := list.Next(after, time.UTC)
		if !ok {
			t.Fatal("list expression found nothing")
		}
		got = append(got, next.Format("Mon 15:04"))
		after = next
	}
	if want := "Mon 20:00 Wed 08:00 Wed 20:00 Fri 08:00"; got[0]+" "+got[1]+" "+got[2]+" "+got[3] != want {
		t.Fatalf("list fires = %v, want %s", got, want)
	}

	// Both day fields restricted: the 1st of the month OR a Monday.
	either := mustParse(t, "0 0 1 * 1")
	after = time.Date(2026, time.August, 25, 0, 0, 0, 0, time.UTC) // Tuesday
	days := []int{}
	for range 3 {
		next, _ := either.Next(after, time.UTC)
		days = append(days, next.Day())
		after = next
	}
	if days[0] != 31 || days[1] != 1 || days[2] != 7 {
		t.Fatalf("dom/dow OR = %v, want [31 1 7]", days)
	}
	if next, _ := mustParse(t, "0 0 * * 7").Next(time.Date(2026, time.August, 24, 0, 0, 0, 0, time.UTC), time.UTC); next.Weekday() != time.Sunday {
		t.Fatalf("7 is Sunday, got %s", next.Weekday())
	}
}

func TestParseRefusesMalformedExpressions(t *testing.T) {
	t.Parallel()
	for _, expression := range []string{
		"", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 13 *",
		"* * * * 8", "*/0 * * * *", "*/61 * * * *", "5-2 * * * *", "a * * * *", "@never", "1,,2 * * * *",
	} {
		if _, err := Parse(expression); err == nil {
			t.Errorf("Parse(%q) accepted a malformed expression", expression)
		}
	}
	for _, expression := range []string{"@hourly", "@daily", "@weekly", "@monthly", "@yearly", "0 9 * * 1", "*/15 * * * *", "0 0 1-7 * 1", "0 12 * * 1-5", "1,15,30 * * * *", "0 */6 * * *", "5/10 * * * *"} {
		if _, err := Parse(expression); err != nil {
			t.Errorf("Parse(%q) error = %v", expression, err)
		}
	}
	if _, ok := mustParse(t, "0 0 31 2 *").Next(time.Now(), time.UTC); ok {
		t.Fatal("31 February fired")
	}
	if _, err := mustParse(t, "0 9 * * *").NextIn(time.Now(), "Mars/Olympus"); err == nil {
		t.Fatal("NextIn accepted a fictional zone")
	}
	if _, err := mustParse(t, "0 9 * * *").NextIn(time.Now(), "Local"); err == nil {
		t.Fatal("NextIn accepted Local")
	}
}
