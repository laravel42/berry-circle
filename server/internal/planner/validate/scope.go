package validate

import (
	"fmt"
	"strconv"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
)

// checkScope makes every id the plan names resolve inside the workspace and
// every user approver a member. Unknown sets skip their rule.
func checkScope(input Input, report *Report) {
	plan := input.Plan
	workspace := input.Workspace
	if plan.Goal.ProjectID != nil && workspace.Projects != nil && !workspace.Projects[*plan.Goal.ProjectID] {
		report.errorf("/goal/projectId", CodeScopeInvalid, "The project is not in this workspace.")
	}
	checkApprover := func(path string, approver automation.Approver) {
		if approver.Type != automation.ApproverUser || workspace.Members == nil {
			return
		}
		id, err := uuid.Parse(approver.UserID)
		if err != nil || !workspace.Members[id] {
			report.errorf(path+"/userId", CodeApprovalApproverReqd, "The approver is not a member of this workspace.")
		}
	}
	for index, approval := range plan.Approvals {
		checkApprover("/approvals/"+strconv.Itoa(index)+"/approver", approval.Approver)
	}
	for windex, workflow := range plan.Workflows {
		for sindex, step := range workflow.Steps {
			path := fmt.Sprintf("/workflows/%d/steps/%d", windex, sindex)
			switch {
			case step.CreateIssue != nil && step.CreateIssue.BoardID != "" && workspace.Boards != nil:
				id, err := uuid.Parse(step.CreateIssue.BoardID)
				if err != nil || !workspace.Boards[id] {
					report.errorf(path+"/boardId", CodeScopeInvalid, "The board is not in this workspace.")
				}
			case step.Approval != nil:
				checkApprover(path+"/approver", step.Approval.Approver)
			}
		}
	}
}
