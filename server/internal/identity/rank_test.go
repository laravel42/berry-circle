package identity

import "testing"

// An approval addressed to "admin" is resolved by admins and owners, never by
// members; an unknown requirement satisfies nobody.
func TestRoleAtLeastFollowsTheWorkspaceHierarchy(t *testing.T) {
	t.Parallel()
	cases := []struct {
		actor, required Role
		want            bool
	}{
		{RoleOwner, RoleAdmin, true},
		{RoleAdmin, RoleAdmin, true},
		{RoleMember, RoleAdmin, false},
		{RoleViewer, RoleMember, false},
		{RoleMember, RoleMember, true},
		{RoleOwner, RoleViewer, true},
		{Role("unknown"), RoleViewer, false},
		{RoleOwner, Role("unknown"), false},
	}
	for _, testCase := range cases {
		if got := RoleAtLeast(testCase.actor, testCase.required); got != testCase.want {
			t.Errorf("RoleAtLeast(%q, %q) = %t, want %t", testCase.actor, testCase.required, got, testCase.want)
		}
	}
	if RoleRank(RoleViewer) >= RoleRank(RoleMember) || RoleRank(RoleMember) >= RoleRank(RoleAdmin) ||
		RoleRank(RoleAdmin) >= RoleRank(RoleOwner) {
		t.Fatal("role ranks are not strictly increasing viewer < member < admin < owner")
	}
}
