package identity

import "testing"

func TestWorkspaceRolePermissionMatrix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		role       Role
		permission Permission
		want       bool
	}{
		{RoleOwner, PermissionWorkspaceDelete, true},
		{RoleAdmin, PermissionWorkspaceDelete, false},
		{RoleAdmin, PermissionMembersManage, true},
		{RoleMember, PermissionMembersManage, false},
		{RoleMember, PermissionProductWrite, true},
		{RoleMember, PermissionCommentWrite, true},
		{RoleViewer, PermissionProductWrite, false},
		{RoleViewer, PermissionCommentWrite, false},
		{RoleViewer, PermissionProductRead, true},
		{Role("unknown"), PermissionProductRead, false},
	}
	for _, test := range tests {
		if got := test.role.Allows(test.permission); got != test.want {
			t.Errorf(
				"%q Allows(%q) = %t, want %t",
				test.role,
				test.permission,
				got,
				test.want,
			)
		}
	}
}

func TestWorkspaceRolesAreExplicit(t *testing.T) {
	t.Parallel()
	for _, role := range []Role{RoleOwner, RoleAdmin, RoleMember, RoleViewer} {
		if !role.Valid() {
			t.Errorf("role %q is not valid", role)
		}
	}
	if Role("administrator").Valid() {
		t.Fatal("unknown role was accepted")
	}
}
