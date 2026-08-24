package p2

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/identity"
	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
)

func TestInboxUsesAuthenticatedUserAsRecipient(t *testing.T) {
	t.Parallel()
	userID, workspaceID := uuid.New(), uuid.New()
	called := false
	store := &storeStub{
		listInbox: func(
			_ context.Context,
			gotWorkspaceID, gotRecipientID uuid.UUID,
			filter p2repo.InboxFilter,
		) ([]p2repo.InboxItem, error) {
			called = true
			if gotWorkspaceID != workspaceID || gotRecipientID != userID {
				t.Fatalf(
					"scope = (%s, %s), want (%s, %s)",
					gotWorkspaceID,
					gotRecipientID,
					workspaceID,
					userID,
				)
			}
			if filter.State != "active" || filter.Limit != 51 {
				t.Fatalf("filter = %#v", filter)
			}
			return []p2repo.InboxItem{{RecipientID: gotRecipientID}}, nil
		},
	}
	authorization := &authorizerStub{}
	service := newTestService(t, store, authorization, nil)

	items, err := service.ListInbox(
		context.Background(),
		userID,
		workspaceID,
		p2repo.InboxFilter{State: "active", Limit: 51},
	)
	if err != nil {
		t.Fatalf("ListInbox() error = %v", err)
	}
	if !called || len(items) != 1 || items[0].RecipientID != userID {
		t.Fatalf("called=%t items=%#v", called, items)
	}
	if authorization.userID != userID ||
		authorization.workspaceID != workspaceID ||
		authorization.permission != identity.PermissionRead {
		t.Fatalf("authorization = %#v", authorization)
	}
}

func TestAuthorizationFailureStopsRepositoryAccess(t *testing.T) {
	t.Parallel()
	called := false
	store := &storeStub{
		search: func(
			context.Context,
			uuid.UUID,
			p2repo.SearchFilter,
		) ([]p2repo.SearchResult, error) {
			called = true
			return nil, nil
		},
	}
	service := newTestService(
		t,
		store,
		&authorizerStub{err: identity.ErrForbidden},
		nil,
	)

	_, err := service.Search(
		context.Background(),
		uuid.New(),
		uuid.New(),
		p2repo.SearchFilter{Query: "berry", Types: []string{"issue"}, Limit: 10},
	)
	if !errors.Is(err, identity.ErrForbidden) {
		t.Fatalf("Search() error = %v, want forbidden", err)
	}
	if called {
		t.Fatal("repository was called after authorization failed")
	}
}

func TestAssignedToMeScopeIsInjectedServerSide(t *testing.T) {
	t.Parallel()
	userID, workspaceID := uuid.New(), uuid.New()
	store := &storeStub{
		listIssueRows: func(
			_ context.Context,
			gotWorkspaceID uuid.UUID,
			filter p2repo.IssueFilter,
			groupBy, groupKey string,
			_ *p2repo.IssueRowCursor,
			limit int,
		) ([]p2repo.IssueRow, error) {
			if gotWorkspaceID != workspaceID || filter.UserID != userID {
				t.Fatalf(
					"workspace=%s user=%s, want workspace=%s user=%s",
					gotWorkspaceID,
					filter.UserID,
					workspaceID,
					userID,
				)
			}
			if !filter.AssignedToMe || groupBy != "none" || groupKey != "" || limit != 10 {
				t.Fatalf(
					"filter=%#v groupBy=%q groupKey=%q limit=%d",
					filter,
					groupBy,
					groupKey,
					limit,
				)
			}
			return nil, nil
		},
	}
	service := newTestService(t, store, &authorizerStub{}, nil)

	_, err := service.ListIssueRows(
		context.Background(),
		userID,
		workspaceID,
		p2repo.IssueFilter{AssignedToMe: true},
		"none",
		"",
		nil,
		10,
	)
	if err != nil {
		t.Fatalf("ListIssueRows() error = %v", err)
	}
}

func TestProjectPinsRequireAndUseInjectedValidator(t *testing.T) {
	t.Parallel()
	userID, workspaceID, projectID := uuid.New(), uuid.New(), uuid.New()
	store := &storeStub{
		createPin: func(
			_ context.Context,
			_ uuid.UUID,
			gotWorkspaceID, gotUserID uuid.UUID,
			targetType string,
			targetID uuid.UUID,
			_ time.Time,
		) (p2repo.Pin, bool, error) {
			if gotWorkspaceID != workspaceID || gotUserID != userID ||
				targetType != "project" || targetID != projectID {
				t.Fatalf(
					"CreatePin scope=(%s,%s,%s,%s)",
					gotWorkspaceID,
					gotUserID,
					targetType,
					targetID,
				)
			}
			return p2repo.Pin{TargetType: targetType, TargetID: targetID}, false, nil
		},
	}
	withoutProjects := newTestService(t, store, &authorizerStub{}, nil)
	if _, _, err := withoutProjects.CreatePin(
		context.Background(),
		userID,
		workspaceID,
		"project",
		projectID,
	); !errors.Is(err, ErrProjectValidationUnavailable) {
		t.Fatalf("CreatePin() error = %v, want validator unavailable", err)
	}

	validator := &projectValidatorStub{exists: true}
	withProjects := newTestService(t, store, &authorizerStub{}, validator)
	pin, _, err := withProjects.CreatePin(
		context.Background(),
		userID,
		workspaceID,
		"project",
		projectID,
	)
	if err != nil {
		t.Fatalf("CreatePin() error = %v", err)
	}
	if !validator.called || pin.TargetID != projectID {
		t.Fatalf("validator called=%t pin=%#v", validator.called, pin)
	}
}

func newTestService(
	t *testing.T,
	store Store,
	authorization Authorizer,
	projects ProjectTargetValidator,
) *Service {
	t.Helper()
	service, err := New(Options{
		Store:         store,
		Authorization: authorization,
		Projects:      projects,
		Clock: func() time.Time {
			return time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
		},
		NewID: uuid.New,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return service
}

type storeStub struct {
	Store
	listInbox func(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		p2repo.InboxFilter,
	) ([]p2repo.InboxItem, error)
	search func(
		context.Context,
		uuid.UUID,
		p2repo.SearchFilter,
	) ([]p2repo.SearchResult, error)
	listIssueRows func(
		context.Context,
		uuid.UUID,
		p2repo.IssueFilter,
		string,
		string,
		*p2repo.IssueRowCursor,
		int,
	) ([]p2repo.IssueRow, error)
	createPin func(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		string,
		uuid.UUID,
		time.Time,
	) (p2repo.Pin, bool, error)
}

func (store *storeStub) ListInbox(
	ctx context.Context,
	workspaceID, recipientID uuid.UUID,
	filter p2repo.InboxFilter,
) ([]p2repo.InboxItem, error) {
	return store.listInbox(ctx, workspaceID, recipientID, filter)
}

func (store *storeStub) Search(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter p2repo.SearchFilter,
) ([]p2repo.SearchResult, error) {
	return store.search(ctx, workspaceID, filter)
}

func (store *storeStub) ListIssueRows(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter p2repo.IssueFilter,
	groupBy, groupKey string,
	after *p2repo.IssueRowCursor,
	limit int,
) ([]p2repo.IssueRow, error) {
	return store.listIssueRows(
		ctx,
		workspaceID,
		filter,
		groupBy,
		groupKey,
		after,
		limit,
	)
}

func (store *storeStub) CreatePin(
	ctx context.Context,
	id, workspaceID, userID uuid.UUID,
	targetType string,
	targetID uuid.UUID,
	now time.Time,
) (p2repo.Pin, bool, error) {
	return store.createPin(
		ctx,
		id,
		workspaceID,
		userID,
		targetType,
		targetID,
		now,
	)
}

type authorizerStub struct {
	err         error
	userID      uuid.UUID
	workspaceID uuid.UUID
	permission  identity.Permission
}

func (authorization *authorizerStub) AuthorizeWorkspace(
	_ context.Context,
	userID, workspaceID uuid.UUID,
	permission identity.Permission,
) (identity.Role, error) {
	authorization.userID = userID
	authorization.workspaceID = workspaceID
	authorization.permission = permission
	return identity.RoleMember, authorization.err
}

type projectValidatorStub struct {
	called bool
	exists bool
	err    error
}

func (validator *projectValidatorStub) ProjectExists(
	_ context.Context,
	workspaceID, projectID uuid.UUID,
) (bool, error) {
	validator.called = workspaceID != uuid.Nil && projectID != uuid.Nil
	return validator.exists, validator.err
}
