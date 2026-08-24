package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/laravel42/berry-circle/server/internal/config"
	"github.com/laravel42/berry-circle/server/internal/database"
	"github.com/laravel42/berry-circle/server/internal/observability"
	"github.com/laravel42/berry-circle/server/migrations"
)

func main() {
	os.Exit(run())
}

func run() int {
	cfg, err := config.FromEnv()
	if err != nil {
		slog.Error("configuration failed", "error", err)
		return 1
	}
	logger := observability.NewLogger(os.Stderr, cfg.LogLevel, cfg.ServiceName+"-migrate", cfg.Environment)
	if cfg.DatabaseURL == "" {
		logger.Error("migration failed", "error", "DATABASE_URL is not configured")
		return 1
	}

	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	pool, err := database.Open(ctx, cfg.DatabaseURL, cfg.ServiceName+"-migrate")
	if err != nil {
		logger.Error("migration failed", "error", err)
		return 1
	}
	defer pool.Close()

	if err := migrations.Apply(ctx, pool, logger); err != nil {
		logger.Error("migration failed", "error", err)
		return 1
	}
	logger.Info("database migrations are current")
	return 0
}
