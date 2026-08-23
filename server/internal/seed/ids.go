package seed

import "github.com/google/uuid"

// Stable Berry development identifiers. Safe to reference in local docs and tests.
var (
	UserID      = uuid.MustParse("11111111-1111-4111-8111-111111111101")
	WorkspaceID = uuid.MustParse("11111111-1111-4111-8111-111111111110")
	BoardID     = uuid.MustParse("11111111-1111-4111-8111-111111111120")
)

const (
	UserEmail      = "prototype@berry.test"
	UserName       = "Prototype User"
	WorkspaceName  = "Berry"
	WorkspaceSlug  = "berry"
	BoardName      = "Platform"
	BoardSlug      = "platform"
)
