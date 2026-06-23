package main

import "agent-worker/webdav/cmd"

func main() {
	if err := cmd.NewRunner().Run(); err != nil {
		panic(err)
	}
}
