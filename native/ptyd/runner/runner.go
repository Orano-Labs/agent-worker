package runner

import (
	"context"
	"fmt"
	"io/fs"
	"os"

	"github.com/urfave/cli/v3"

	"agent-worker/ptyd/internal/terminal"
)

// defaultPort is the HTTP port used when none is provided on the CLI.
const defaultPort = 7689

// Runner parses command-line flags and drives the terminal HTTP server.
type Runner struct {
	static fs.FS
	cli    *cli.Command
}

// New builds a Runner serving the given static files (the frontend) and
// reporting the provided version.
func New(static fs.FS, version string) *Runner {
	r := &Runner{static: static}

	r.cli = &cli.Command{
		Name:    "ptyd",
		Usage:   "Web terminal backed by a PTY process",
		Version: version,
		Flags: []cli.Flag{
			&cli.IntFlag{
				Name:  "port",
				Value: defaultPort,
				Usage: "HTTP server listen port",
			},
			&cli.StringFlag{
				Name:  "command",
				Value: terminal.DefaultCommand,
				Usage: "command to run in the terminal",
			},
			&cli.StringSliceFlag{
				Name:    "arg",
				Aliases: []string{"a"},
				Usage:   "argument passed to the command (repeatable); or pass arguments after '--'",
			},
			&cli.StringFlag{
				Name:  "dir",
				Usage: "working directory of the command",
			},
			&cli.StringSliceFlag{
				Name:  "env",
				Usage: "environment variable KEY=VALUE for the command (repeatable)",
			},
			&cli.DurationFlag{
				Name:  "idle-timeout",
				Value: terminal.DefaultIdleTimeout,
				Usage: "shut the terminal down after this idle period (0 disables the idle shutdown)",
			},
			&cli.UintFlag{
				Name:  "scrollback",
				Value: terminal.DefaultScrollback,
				Usage: "number of scrollback lines to retain",
			},
		},
		Action: func(ctx context.Context, c *cli.Command) error {
			args := c.StringSlice("arg")
			args = append(args, c.Args().Slice()...)

			cfg := terminal.Config{
				Command:     c.String("command"),
				Args:        args,
				Dir:         c.String("dir"),
				Env:         c.StringSlice("env"),
				IdleTimeout: c.Duration("idle-timeout"),
				Scrollback:  c.Uint("scrollback"),
			}
			addr := fmt.Sprintf("0.0.0.0:%d", c.Int("port"))
			return runServer(ctx, r.static, addr, cfg)
		},
	}

	return r
}

// Run parses os.Args and starts the server.
func (r *Runner) Run() error {
	return r.cli.Run(context.Background(), os.Args)
}
