package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/laravel42/berry-circle/server/internal/config"
	"github.com/laravel42/berry-circle/server/internal/database"
	"github.com/laravel42/berry-circle/server/internal/observability"
	"github.com/laravel42/berry-circle/server/internal/seed"
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
	logger := observability.NewLogger(os.Stderr, cfg.LogLevel, cfg.ServiceName+"-seed", cfg.Environment)
	if cfg.DatabaseURL == "" {
		logger.Error("seed failed", "error", "DATABASE_URL is not configured")
		return 1
	}

	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	pool, err := database.Open(ctx, cfg.DatabaseURL, cfg.ServiceName+"-seed")
	if err != nil {
		logger.Error("seed failed", "error", err)
		return 1
	}
	defer pool.Close()

	if err := seed.Apply(ctx, pool, time.Now().UTC()); err != nil {
		logger.Error("seed failed", "error", err)
		return 1
	}
	logger.Info(
		"development seed data is current",
		"userEmail", seed.UserEmail,
		"workspaceSlug", seed.WorkspaceSlug,
		"boardSlug", seed.BoardSlug,
	)
	return 0
}
