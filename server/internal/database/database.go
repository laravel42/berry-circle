package database

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/migrations"
)

// Open constructs and verifies a PostgreSQL pool.
func Open(ctx context.Context, databaseURL, serviceName string) (*pgxpool.Pool, error) {
	if databaseURL == "" {
		return nil, errors.New("open database: DATABASE_URL is not configured")
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("open database: DATABASE_URL is invalid")
	}
	if serviceName != "" {
		cfg.ConnConfig.RuntimeParams["application_name"] = serviceName
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open database pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// WithinTx executes fn in a transaction and commits only when fn succeeds.
func WithinTx[T any](
	ctx context.Context,
	pool *pgxpool.Pool,
	options pgx.TxOptions,
	fn func(pgx.Tx) (T, error),
) (T, error) {
	var zero T
	if pool == nil {
		return zero, errors.New("begin transaction: database pool is nil")
	}
	tx, err := pool.BeginTx(ctx, options)
	if err != nil {
		return zero, fmt.Errorf("begin transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	value, err := fn(tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, fmt.Errorf("commit transaction: %w", err)
	}
	return value, nil
}

// Readiness verifies connectivity and the exact embedded migration ledger.
type Readiness struct {
	Pool     *pgxpool.Pool
	Expected []migrations.Migration
}

// NewReadiness creates a migration-aware database readiness checker.
func NewReadiness(pool *pgxpool.Pool) (*Readiness, error) {
	expected, err := migrations.List()
	if err != nil {
		return nil, err
	}
	return &Readiness{Pool: pool, Expected: expected}, nil
}

// Check returns an error when the database or migration ledger is not ready.
func (checker *Readiness) Check(ctx context.Context) error {
	if checker == nil || checker.Pool == nil {
		return errors.New("database is not configured")
	}
	if err := checker.Pool.Ping(ctx); err != nil {
		return errors.New("database ping failed")
	}

	var ledgerExists bool
	if err := checker.Pool.QueryRow(
		ctx,
		`SELECT to_regclass('berry_schema_migrations') IS NOT NULL`,
	).Scan(&ledgerExists); err != nil {
		return errors.New("migration ledger check failed")
	}
	if !ledgerExists {
		return errors.New("migration ledger is missing")
	}

	rows, err := checker.Pool.Query(
		ctx,
		"SELECT version, name, checksum FROM berry_schema_migrations ORDER BY version",
	)
	if err != nil {
		return errors.New("migration ledger read failed")
	}
	defer rows.Close()

	applied := make(map[int]struct {
		name     string
		checksum string
	})
	for rows.Next() {
		var version int
		var name, checksum string
		if err := rows.Scan(&version, &name, &checksum); err != nil {
			return errors.New("migration ledger row is invalid")
		}
		applied[version] = struct {
			name     string
			checksum string
		}{name: name, checksum: checksum}
	}
	if rows.Err() != nil {
		return errors.New("migration ledger iteration failed")
	}
	if len(applied) != len(checker.Expected) {
		return errors.New("database migrations are not current")
	}
	for _, expected := range checker.Expected {
		record, ok := applied[expected.Version]
		if !ok || record.name != expected.Name || record.checksum != expected.Checksum {
			return errors.New("database migration ledger does not match this binary")
		}
	}
	return nil
}
