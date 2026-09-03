package runner

import (
	"context"
	"net"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"

	"agent-worker/ptyd/internal/terminal"
)

// TestWebsocketKeepsTerminalAlive proves that a live WebSocket connection - even
// one that stays completely silent - prevents the idle reaper from killing the
// terminal, and that the terminal is only reaped once the connection is gone.
func TestWebsocketKeepsTerminalAlive(t *testing.T) {
	cfg := terminal.Config{
		Command:     "/bin/sh",
		Args:        []string{"-c", "sleep 30"},
		IdleTimeout: 400 * time.Millisecond,
	}

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("pick port: %v", err)
	}
	addr := l.Addr().String()
	l.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = runServer(ctx, fstest.MapFS{}, addr, cfg)
	}()

	wsURL := "ws://" + addr + "/ws?cols=80&rows=24"

	// Wait for the server to come up.
	var conn *websocket.Conn
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err == nil {
			conn = c
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if conn == nil {
		t.Fatal("server did not become reachable")
	}
	defer conn.Close()

	// Stay connected and silent for well over the idle timeout. The read
	// deadline expiring (not the connection closing) proves the terminal was
	// NOT reaped while a subscriber was attached. The first frames may be the
	// replayed snapshot, so drain until the connection goes quiet.
	aliveDeadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(aliveDeadline) {
		_ = conn.SetReadDeadline(time.Now().Add(1500 * time.Millisecond))
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue // snapshot / prompt output
		}
		ne, ok := err.(net.Error)
		if !ok || !ne.Timeout() {
			t.Fatalf("connection closed while subscriber was attached (terminal reaped?): %v", err)
		}
		break // went quiet for 1.5s: still alive
	}
	if time.Now().After(aliveDeadline) {
		t.Fatal("never reached a quiet period with the subscriber attached")
	}

	// Now drop the subscriber: with no output and no subscriber the terminal
	// should be reaped and the whole server should shut down shortly after.
	_ = conn.Close()

	shutDeadline := time.Now().Add(3 * time.Second)
	reaped := false
	for time.Now().Before(shutDeadline) {
		c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			if strings.Contains(err.Error(), "connection refused") {
				reaped = true
				break
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		_ = c.Close()
		time.Sleep(100 * time.Millisecond)
	}
	if !reaped {
		t.Fatal("terminal was not reaped after the subscriber disconnected")
	}
}
