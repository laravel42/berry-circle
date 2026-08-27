package migrations

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"testing/fstest"
)

func TestListOrdersUniqueMigrationsAndComputesChecksums(t *testing.T) {
	t.Parallel()

	all, err := List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(all) != 30 {
		t.Fatalf("List() returned %d migrations, want 30", len(all))
	}
	for index, migration := range all {
		if migration.Version != index {
			t.Errorf("migration %d version = %d, want %d", index, migration.Version, index)
		}
		sum := sha256.Sum256([]byte(migration.SQL))
		want := hex.EncodeToString(sum[:])
		if migration.Checksum != want {
			t.Errorf(
				"migration %q checksum = %q, want %q",
				migration.Name,
				migration.Checksum,
				want,
			)
		}
	}
}

func TestIdentityMigrationIsAdditiveAndContainsSecurityBoundaries(t *testing.T) {
	t.Parallel()
	all, err := List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	var identity Migration
	for _, migration := range all {
		if migration.Name == "004_identity_workspaces.up.sql" {
			identity = migration
			break
		}
	}
	if identity.Name != "004_identity_workspaces.up.sql" {
		t.Fatalf("identity migration missing from List(), last = %q", all[len(all)-1].Name)
	}
	for _, required := range []string{
		"CREATE TABLE IF NOT EXISTS workspaces",
		"CREATE TABLE IF NOT EXISTS workspace_memberships",
		"CREATE TABLE IF NOT EXISTS workspace_invitations",
		"CREATE TABLE IF NOT EXISTS personal_api_tokens",
		"secret_hash bytea NOT NULL",
		"last_used_at timestamptz",
		"revoked_at timestamptz",
		"UPDATE boards",
		"ALTER TABLE boards ALTER COLUMN workspace_id SET NOT NULL",
		"berry_boards_assign_workspace",
	} {
		if !strings.Contains(identity.SQL, required) {
			t.Errorf("identity migration is missing %q", required)
		}
	}
	for _, destructive := range []string{"DROP TABLE", "DROP COLUMN", "TRUNCATE"} {
		if strings.Contains(strings.ToUpper(identity.SQL), destructive) {
			t.Errorf("identity migration contains destructive statement %q", destructive)
		}
	}
}

func TestLoadFSRejectsDuplicateVersions(t *testing.T) {
	t.Parallel()

	source := fstest.MapFS{
		"001_first.up.sql":  {Data: []byte("SELECT 1;")},
		"001_second.up.sql": {Data: []byte("SELECT 2;")},
	}
	if _, err := loadFS(source); err == nil {
		t.Fatal("loadFS() accepted duplicate migration versions")
	}
}

func TestChecksumChangesWhenMigrationChanges(t *testing.T) {
	t.Parallel()

	first, err := loadFS(fstest.MapFS{
		"000_platform.up.sql": {Data: []byte("SELECT 1;")},
	})
	if err != nil {
		t.Fatalf("loadFS(first) error = %v", err)
	}
	second, err := loadFS(fstest.MapFS{
		"000_platform.up.sql": {Data: []byte("SELECT 2;")},
	})
	if err != nil {
		t.Fatalf("loadFS(second) error = %v", err)
	}
	if first[0].Checksum == second[0].Checksum {
		t.Fatal("checksum did not change with migration contents")
	}
}

func TestLoadFSRejectsInvalidFilename(t *testing.T) {
	t.Parallel()

	source := fstest.MapFS{
		"1_bad.up.sql": {Data: []byte("SELECT 1;")},
	}
	if _, err := loadFS(source); err == nil {
		t.Fatal("loadFS() accepted an unordered filename without a three-digit version")
	}
}
