package cmd

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"agent-worker/webdav/internal"

	"github.com/urfave/cli/v3"
)

var (
	// FlagPort defines the command-line flag for the server listening port (default: 8080).
	FlagPort = &cli.IntFlag{
		Name:    "port",
		Value:   8080,
		Aliases: []string{"p"},
		Usage:   "Server listening port",
		Validator: func(i int) error {
			if i < 1 || i > 65535 {
				return fmt.Errorf("port must be between 1 and 65535 (got %d)", i)
			}
			return nil
		},
	}

	// FlagRoot defines the mandatory command-line flag for the local root directory path.
	FlagRoot = &cli.StringFlag{
		Name:     "root",
		Required: true,
		Aliases:  []string{"r"},
		Usage:    "Local directory path to expose via WebDAV",
		Validator: func(s string) error {
			if s == "" {
				return fmt.Errorf("root path cannot be empty")
			}

			cleanPath := filepath.Clean(s)
			info, err := os.Stat(cleanPath)

			if err != nil {
				if os.IsNotExist(err) {
					return fmt.Errorf("root directory does not exist: %s", cleanPath)
				}
				return fmt.Errorf("failed to access root directory: %w", err)
			}

			if !info.IsDir() {
				return fmt.Errorf("root path is not a directory: %s", cleanPath)
			}

			return nil
		},
	}

	FlagSocketPath = &cli.StringFlag{
		Name:     "socket",
		Required: true,
		Aliases:  []string{"s"},
		Usage:    "Path to the UNIX socket for controller",
	}
)

// Runner encapsulates the CLI application instance and its runtime logic.
type Runner struct {
	command *cli.Command
}

// Run parses the command-line arguments and executes the corresponding action.
// It blocks the current goroutine until the server stops or encounters an error.
func (r *Runner) Run() error {
	return r.command.Run(context.Background(), os.Args)
}

// NewRunner creates and initializes a new Runner for the WebDAV service.
func NewRunner() *Runner {
	return &Runner{
		command: &cli.Command{
			Name:  "AgentWorker-WebDAV",
			Usage: "A lightweight WebDAV server file agent",
			Flags: []cli.Flag{
				FlagPort,
				FlagRoot,
				FlagSocketPath,
			},
			Action: func(ctx context.Context, c *cli.Command) error {
				rootPath := c.String(FlagRoot.Name)
				port := c.Int(FlagPort.Name)
				socket := c.String(FlagSocketPath.Name)
				server := internal.NewServer(rootPath, port, socket)

				if err := server.Serve(ctx); err != nil {
					return fmt.Errorf("webdav server encountered a fatal error: %w", err)
				}

				return nil
			},
		},
	}
}
