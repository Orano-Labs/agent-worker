package main

import (
	"embed"
	"io/fs"
	"os"

	"agent-worker/ttyd/runner"
)

//go:embed static
var static embed.FS

func main() {
	staticFS, err := fs.Sub(static, "static")
	if err != nil {
		panic(err)
	}

	if err := runner.New(staticFS).Run(); err != nil {
		os.Exit(1)
	}
}
