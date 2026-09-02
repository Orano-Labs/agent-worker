package main

import (
	"embed"
	"io/fs"
	"os"

	"agent-worker/ttyd/runner"
)

//go:embed static
var static embed.FS

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	staticFS, err := fs.Sub(static, "static")
	if err != nil {
		panic(err)
	}

	if err := runner.New(staticFS, version).Run(); err != nil {
		os.Exit(1)
	}
}
