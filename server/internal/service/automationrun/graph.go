package automationrun

import (
	"encoding/json"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

// graph is the control-flow relation of one definition, the same one the
// validator checks: a step's parents are what it dependsOn plus the branch
// step (condition) that names it.
type graph struct {
	definition automation.Definition
	order      []string
	parents    map[string][]string
	// branchParent names the condition a step is a branch child of.
	branchParent map[string]string
	types        map[string]automation.StepType
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
	}
	return result
}

// next picks what happens now given the rows so far: the first step in
// definition order whose parents all finished runs; a step whose parents
// were all skipped, or whose branch was not taken, is pruned; when every
// step has a terminal row the run is done; otherwise nothing can move.
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
				if graph.branchParent[id] == parent {
					prune = true
				}
			}
			if graph.branchParent[id] == parent && parentRow.Status == automationrepo.StepSucceeded && !branchTaken(parentRow.Output, id) {
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

// branchTaken reads a condition's recorded output to see whether it handed
// control to the child, so a resumed walk never runs the other branch.
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
