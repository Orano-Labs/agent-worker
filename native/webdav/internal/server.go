package internal

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"
)

type Server struct {
	ctl    *controller
	port   int
	root   string
	socket string
	logger *slog.Logger
}

func (s *Server) Serve(ctx context.Context) error {
	s.logger.Info("server starting ....", "root", s.root, "port", s.port)

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)

	defer func() {
		stop()
	}()

	g, ctx := errgroup.WithContext(ctx)

	// internal unix server

	g.Go(func() error {
		s.logger.Info("starting internal controller service", "socket", s.socket)

		// Ensure clean initialization by removing any stale socket files remaining from bad exits
		if err := os.Remove(s.socket); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to remove stale unix socket: %w", err)
		}

		listener, err := net.Listen("unix", s.socket)

		if err != nil {
			return fmt.Errorf("failed to listen on unix socket %s: %w", s.socket, err)
		}

		server := &http.Server{
			Handler: http.HandlerFunc(s.ctl.serveInternal),
		}

		go func() {
			<-ctx.Done()

			s.logger.Info("shutting down internal controller service...")

			shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)

			defer cancel()

			if err := server.Shutdown(shutdownCtx); err != nil {
				s.logger.Error("controller graceful shutdown failed", "error", err)
			}
		}()

		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("controller server failed: %w", err)
		}

		return nil
	})

	// external webdav server

	g.Go(func() error {
		server := &http.Server{
			Handler: http.HandlerFunc(s.ctl.serveExternal),
			Addr:    fmt.Sprintf(":%d", s.port),
		}

		s.logger.Info("starting public webdav service", "addr", server.Addr)

		go func() {
			<-ctx.Done()

			s.logger.Info("shutting down public webdav service...")

			shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)

			defer cancel()

			if err := server.Shutdown(shutdownCtx); err != nil {
				s.logger.Error("webdav graceful shutdown failed", "error", err)
			}
		}()

		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("webdav server failed: %w", err)
		}

		return nil
	})

	err := g.Wait()

	// cleanup socket always safe
	os.Remove(s.socket)

	if err != nil {
		return fmt.Errorf("server failure: %w", err)
	}

	s.logger.Info("server stopped cleanly")

	return nil
}

func NewServer(root string, port int, socket string) *Server {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		AddSource: true,
		Level:     slog.LevelInfo,
	}))

	return &Server{
		ctl:    newController(root, logger),
		port:   port,
		root:   root,
		socket: socket,
		logger: logger,
	}
}
