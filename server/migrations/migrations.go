package migrations

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"regexp"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const advisoryLockKey int64 = 0x42657272794d6967

var migrationName = regexp.MustCompile(`^([0-9]{3})_[a-z0-9_]+\.up\.sql$`)

//go:embed *.up.sql
var files embed.FS

// Migration is one immutable, forward-only database change.
type Migration struct {
	Version  int
	Name     string
	SQL      string
	Checksum string
}

// List returns the validated embedded migrations in ascending version order.
func List() ([]Migration, error) {
	return loadFS(files)
}

func loadFS(source fs.FS) ([]Migration, error) {
	names, err := fs.Glob(source, "*.up.sql")
	if err != nil {
		return nil, fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(names)

	result := make([]Migration, 0, len(names))
	versions := make(map[int]string, len(names))
	for _, name := range names {
		match := migrationName.FindStringSubmatch(name)
		if match == nil {
			return nil, fmt.Errorf("invalid migration filename %q", name)
		}
		version, err := strconv.Atoi(match[1])
		if err != nil {
			return nil, fmt.Errorf("parse migration version %q: %w", name, err)
		}
		if previous, exists := versions[version]; exists {
			return nil, fmt.Errorf(
				"duplicate migration version %03d in %q and %q",
				version,
				previous,
				name,
			)
		}
		versions[version] = name

		body, err := fs.ReadFile(source, name)
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", name, err)
		}
		sum := sha256.Sum256(body)
		result = append(result, Migration{
			Version:  version,
			Name:     name,
			SQL:      string(body),
			Checksum: hex.EncodeToString(sum[:]),
		})
	}
	return result, nil
}

// Apply runs all pending migrations while holding a session advisory lock.
func Apply(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	if pool == nil {
		return errors.New("apply migrations: database pool is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	all, err := List()
	if err != nil {
		return err
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", advisoryLockKey); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, unlockErr := conn.Exec(
			unlockCtx,
			"SELECT pg_advisory_unlock($1)",
			advisoryLockKey,
		); unlockErr != nil {
			logger.Error("release migration lock", "error", unlockErr)
		}
	}()

	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS berry_schema_migrations (
			version integer PRIMARY KEY,
			name text NOT NULL UNIQUE,
			checksum char(64) NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(),
			duration_ms bigint NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
		)
	`); err != nil {
		return fmt.Errorf("initialize migration ledger: %w", err)
	}

	applied, err := readApplied(ctx, conn)
	if err != nil {
		return err
	}
	expected := make(map[int]Migration, len(all))
	for _, migration := range all {
		expected[migration.Version] = migration
	}
	for version, record := range applied {
		migration, ok := expected[version]
		if !ok {
			return fmt.Errorf(
				"migration ledger contains version %03d (%s) missing from this binary",
				version,
				record.name,
			)
		}
		if record.name != migration.Name {
			return fmt.Errorf(
				"migration %03d name drift: ledger has %q, binary has %q",
				version,
				record.name,
				migration.Name,
			)
		}
		if record.checksum != migration.Checksum {
			return fmt.Errorf("migration %q checksum drift", migration.Name)
		}
	}

	for _, migration := range all {
		if _, ok := applied[migration.Version]; ok {
			continue
		}
		if err := applyOne(ctx, conn, migration, logger); err != nil {
			return err
		}
	}
	return nil
}

type appliedMigration struct {
	name     string
	checksum string
}

type migrationConnection interface {
	Begin(context.Context) (pgx.Tx, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func readApplied(
	ctx context.Context,
	conn migrationConnection,
) (map[int]appliedMigration, error) {
	rows, err := conn.Query(
		ctx,
		"SELECT version, name, checksum FROM berry_schema_migrations ORDER BY version",
	)
	if err != nil {
		return nil, fmt.Errorf("read migration ledger: %w", err)
	}
	defer rows.Close()

	result := make(map[int]appliedMigration)
	for rows.Next() {
		var version int
		var record appliedMigration
		if err := rows.Scan(&version, &record.name, &record.checksum); err != nil {
			return nil, fmt.Errorf("scan migration ledger: %w", err)
		}
		result[version] = record
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate migration ledger: %w", err)
	}
	return result, nil
}

func applyOne(
	ctx context.Context,
	conn migrationConnection,
	migration Migration,
	logger *slog.Logger,
) error {
	started := time.Now()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration %q: %w", migration.Name, err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	if _, err := tx.Exec(ctx, migration.SQL); err != nil {
		return fmt.Errorf("execute migration %q: %w", migration.Name, err)
	}
	duration := time.Since(started)
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO berry_schema_migrations
			(version, name, checksum, duration_ms)
		 VALUES ($1, $2, $3, $4)`,
		migration.Version,
		migration.Name,
		migration.Checksum,
		duration.Milliseconds(),
	); err != nil {
		return fmt.Errorf("record migration %q: %w", migration.Name, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration %q: %w", migration.Name, err)
	}
	logger.Info(
		"applied database migration",
		"name",
		migration.Name,
		"duration",
		duration,
	)
	return nil
}
