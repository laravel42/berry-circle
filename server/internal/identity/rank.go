package identity

// RoleRank orders workspace roles so an approval addressed to a role can be
// resolved by that role or any stronger one. Unknown roles rank below every
// real role, which means they never satisfy a requirement.
func RoleRank(role Role) int {
	switch role {
	case RoleViewer:
		return 0
	case RoleMember:
		return 1
	case RoleAdmin:
		return 2
	case RoleOwner:
		return 3
	default:
		return -1
	}
}

// RoleAtLeast reports whether actor holds the required role or a stronger
// one. An unknown required role is never satisfied, so a typo in a stored
// requirement fails closed.
func RoleAtLeast(actor, required Role) bool {
	requiredRank := RoleRank(required)
	if requiredRank < 0 {
		return false
	}
	return RoleRank(actor) >= requiredRank
}
