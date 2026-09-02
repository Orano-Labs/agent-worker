package terminal

import "time"

const (
	DefaultCommand     = "/bin/sh"
	DefaultCols        = 80
	DefaultRows        = 24
	DefaultScrollback  = 3000
	DefaultIdleTimeout = 20 * time.Second
)

type Config struct {
	Command    string
	Args       []string
	Dir        string
	Env        []string
	Cols       uint16
	Rows       uint16
	Scrollback uint
	// IdleTimeout is how long the terminal may stay idle (no subscribers and
	// no output) before it shuts itself down. Zero selects DefaultIdleTimeout.
	IdleTimeout time.Duration
}

func (c Config) Normalize() Config {
	cfg := c

	cfg.Args = append([]string(nil), c.Args...)
	cfg.Env = append([]string(nil), c.Env...)

	if cfg.Command == "" {
		cfg.Command = DefaultCommand
	}

	if cfg.Cols == 0 {
		cfg.Cols = DefaultCols
	}

	if cfg.Rows == 0 {
		cfg.Rows = DefaultRows
	}

	if cfg.Scrollback == 0 {
		cfg.Scrollback = DefaultScrollback
	}

	if cfg.IdleTimeout == 0 {
		cfg.IdleTimeout = DefaultIdleTimeout
	}

	return cfg
}
