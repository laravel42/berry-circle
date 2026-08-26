package automationrun

import (
	"encoding/json"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

// graph is the control-flow relation of one definition, the same one the
// validator checks: a step's parents are what it dependsOn plus the branch
// step (condition, switch, foreach) that names it.
//
// A foreach is expanded against the run's rows: once its row has succeeded
// with N items, every body step B becomes N rows "B[0]" … "B[N-1]", walked
// in item order, and a step that depended on the loop now depends on every
// one of them. Until then the body steps stay behind the loop like any
// other branch, and a loop that failed prunes them.
type graph struct {
	definition automation.Definition
	order      []string
	parents    map[string][]string
	// branchParent names the condition, switch or foreach a step is a
	// branch child of.
	branchParent map[string]string
	types        map[string]automation.StepType
	// foreachOf maps a body step to its loop; bodies lists each loop's body
	// steps in definition order.
	foreachOf map[string]string
	bodies    map[string][]string
}

type decision int

const (
	decisionRun decision = iota
	decisionPrune
	decisionDone
	decisionStuck
)

func buildGraph(definition automation.Definition) graph {
	result := graph{
		definition:   definition,
		parents:      map[string][]string{},
		branchParent: map[string]string{},
		types:        map[string]automation.StepType{},
		foreachOf:    map[string]string{},
		bodies:       map[string][]string{},
	}
	for _, step := range definition.Steps {
		result.order = append(result.order, step.ID)
		result.types[step.ID] = step.Type
		for _, dependency := range step.DependsOn {
			result.parents[step.ID] = append(result.parents[step.ID], dependency)
		}
		for _, child := range step.Children() {
			result.parents[child] = append(result.parents[child], step.ID)
			result.branchParent[child] = step.ID
		}
		if step.Type == automation.StepForeach && step.Foreach != nil {
			for _, body := range step.Foreach.Steps {
				result.foreachOf[body] = step.ID
			}
		}
	}
	// Bodies in definition order, so an iteration walks them the way the
	// definition lists them.
	for _, step := range definition.Steps {
		if loop, ok := result.foreachOf[step.ID]; ok {
			result.bodies[loop] = append(result.bodies[loop], step.ID)
		}
	}
	return result
}

// expand applies the loops that have produced their items.
func (graph graph) expand(state map[string]automationrepo.StepRun) graph {
	counts := map[string]int{}
	for loop := range graph.bodies {
		row, ok := state[loop]
		if !ok || row.Status != automationrepo.StepSucceeded {
			continue
		}
		counts[loop] = foreachCount(row.Output)
	}
	if len(counts) == 0 {
		return graph
	}
	expanded := graph
	expanded.order = nil
	expanded.parents = map[string][]string{}
	expanded.branchParent = map[string]string{}
	expanded.types = map[string]automation.StepType{}
	for id, kind := range graph.types {
		expanded.types[id] = kind
	}
	// every row of an expanded loop, for the steps that depend on the loop.
	loopRows := map[string][]string{}
	for _, id := range graph.order {
		loop, isBody := graph.foreachOf[id]
		if isBody {
			if _, expandedLoop := counts[loop]; expandedLoop {
				continue // emitted right after its loop
			}
		}
		expanded.order = append(expanded.order, id)
		count, isLoop := counts[id]
		if !isLoop {
			continue
		}
		var previous []string
		for index := 0; index < count; index++ {
			var current []string
			for _, body := range graph.bodies[id] {
				row := automation.IndexedStepID(body, index)
				expanded.order = append(expanded.order, row)
				expanded.types[row] = graph.types[body]
				parents := []string{id}
				for _, dependency := range graph.parents[body] {
					if dependency == id {
						continue
					}
					if graph.foreachOf[dependency] == id {
						parents = append(parents, automation.IndexedStepID(dependency, index))
					} else {
						parents = append(parents, dependency)
					}
				}
				// Items are sequential: an iteration starts once the
				// previous one has finished every body step.
				parents = append(parents, previous...)
				expanded.parents[row] = parents
				current = append(current, row)
			}
			loopRows[id] = append(loopRows[id], current...)
			previous = current
		}
	}
	for _, id := range expanded.order {
		if _, already := expanded.parents[id]; already {
			continue
		}
		var parents []string
		for _, parent := range graph.parents[id] {
			parents = append(parents, parent)
			if rows, expandedLoop := loopRows[parent]; expandedLoop {
				parents = append(parents, rows...)
			}
		}
		if len(parents) > 0 {
			expanded.parents[id] = parents
		}
		if parent, ok := graph.branchParent[id]; ok {
			expanded.branchParent[id] = parent
		}
	}
	return expanded
}

// foreachCount reads the item count a loop recorded.
func foreachCount(output json.RawMessage) int {
	var recorded struct {
		Count int `json:"count"`
	}
	if json.Unmarshal(output, &recorded) != nil || recorded.Count < 0 {
		return 0
	}
	return recorded.Count
}

// next picks what happens now given the rows so far: the first step in
// order whose parents all finished runs; a step whose parents were all
// skipped, or whose branch was not taken or whose branch step did not
// succeed, is pruned; when every step has a terminal row the run is done;
// otherwise nothing can move.
func (graph graph) next(state map[string]automationrepo.StepRun) (string, decision) {
	allTerminal := true
	for _, id := range graph.order {
		row, ok := state[id]
		if ok && row.Status.Terminal() {
			continue
		}
		allTerminal = false
		if ok {
			// running or waiting: the walk does not start anything else.
			return "", decisionStuck
		}
		parents := graph.parents[id]
		eligible := true
		skippedParents := 0
		prune := false
		for _, parent := range parents {
			parentRow, has := state[parent]
			if !has || !parentRow.Status.Terminal() {
				eligible = false
				break
			}
			if parentRow.Status == automationrepo.StepSkipped {
				skippedParents++
			}
			if graph.branchParent[id] != parent {
				continue
			}
			// A branch child runs only when its branch step succeeded and
			// handed control to it. A loop hands control through expansion,
			// not through a next list, so its unexpanded bodies never run.
			if parentRow.Status != automationrepo.StepSucceeded || graph.types[parent] == automation.StepForeach || !branchTaken(parentRow.Output, id) {
				prune = true
			}
		}
		if !eligible {
			continue
		}
		if prune || (len(parents) > 0 && skippedParents == len(parents)) {
			return id, decisionPrune
		}
		return id, decisionRun
	}
	if allTerminal {
		return "", decisionDone
	}
	return "", decisionStuck
}

// closure returns ids plus every step that only they lead to.
func (graph graph) closure(ids []string, state map[string]automationrepo.StepRun) []string {
	pruned := map[string]bool{}
	for _, id := range ids {
		pruned[id] = true
	}
	for changed := true; changed; {
		changed = false
		for _, id := range graph.order {
			if pruned[id] {
				continue
			}
			if row, ok := state[id]; ok && row.Status.Terminal() {
				continue
			}
			parents := graph.parents[id]
			if len(parents) == 0 {
				continue
			}
			all := true
			for _, parent := range parents {
				if !pruned[parent] {
					all = false
					break
				}
			}
			if all {
				pruned[id] = true
				changed = true
			}
		}
	}
	result := make([]string, 0, len(pruned))
	for _, id := range graph.order {
		if pruned[id] {
			result = append(result, id)
		}
	}
	return result
}

// branchTaken reads a condition's or switch's recorded output to see whether
// it handed control to the child, so a resumed walk never runs the other
// branch.
func branchTaken(output json.RawMessage, child string) bool {
	var recorded struct {
		Next []string `json:"next"`
	}
	if json.Unmarshal(output, &recorded) != nil {
		return false
	}
	for _, id := range recorded.Next {
		if id == child {
			return true
		}
	}
	return false
}
