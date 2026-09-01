package runner

import (
	"context"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"agent-worker/ttyd/internal/terminal"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

// wsMessage is the JSON frame exchanged over /ws. The browser sends
// {"type":"data",...} for keystrokes and {"type":"resize",...} for viewport
// changes; the server streams raw terminal output as plain text frames.
type wsMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// runServer serves the frontend at / and a shared terminal over /ws until the
// terminal process exits or the context is cancelled.
func runServer(ctx context.Context, static fs.FS, addr string, cfg terminal.Config) error {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))

	term, err := terminal.New(cfg)
	if err != nil {
		return err
	}
	defer term.Close()

	hub := &hub{term: term}
	mux.HandleFunc("/ws", hub.handleWS)

	// Notify us when the process is asked to stop.
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	server := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	// Signals the goroutine when the terminal process has exited.
	termDone := make(chan error, 1)
	go func() { termDone <- term.Wait() }()

	// Shut the server down gracefully as soon as either the terminal exits
	// (e.g. via the idle timeout) or an OS signal is received.
	go func() {
		select {
		case err := <-termDone:
			if err != nil {
				slog.Warn("terminal exited", "err", err)
			} else {
				slog.Info("terminal exited")
			}
		case <-ctx.Done():
			slog.Info("signal received; shutting down", "signal", ctx.Err())
		}

		stop()
		_ = term.Close()

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	slog.Info("http server listening", "addr", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// hub coordinates access to the single shared terminal. Only one WebSocket
// connection may be active at a time.
type hub struct {
	term *terminal.Terminal

	mu     sync.Mutex
	active bool
}

// acquire marks the hub as busy. It returns false if another connection is
// already active.
func (h *hub) acquire() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.active {
		return false
	}
	h.active = true
	return true
}

// release clears the busy flag so a new connection may take over.
func (h *hub) release() {
	h.mu.Lock()
	h.active = false
	h.mu.Unlock()
}

// handleWS bridges the browser to the shared Terminal. If another connection
// is already active, the new one is rejected.
func (h *hub) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("websocket upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	if !h.acquire() {
		slog.Warn("rejecting websocket: another session is active")
		_ = conn.WriteMessage(websocket.TextMessage,
			[]byte("\r\n\x1b[31mAnother terminal session is already active.\r\n\x1b[0m"))
		return
	}
	defer h.release()
	slog.Info("websocket session active")

	// Apply the size advertised by the client to the shared terminal.
	if v, err := strconv.ParseUint(r.URL.Query().Get("cols"), 10, 16); err == nil {
		if rv, rerr := strconv.ParseUint(r.URL.Query().Get("rows"), 10, 16); rerr == nil {
			if rerr := h.term.Resize(uint16(v), uint16(rv)); rerr != nil {
				slog.Warn("resize terminal failed", "err", rerr)
			}
		}
	}

	// Forward the snapshot and all live output to this client.
	sub := h.term.Subscribe(func(b []byte) {
		if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
			slog.Warn("write websocket message failed", "err", err)
		}
	})
	defer sub()

	// Bridge incoming client frames to the shared PTY.
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m wsMessage
			if err := json.Unmarshal(msg, &m); err != nil {
				slog.Debug("ignoring non-json websocket message")
				continue
			}
			switch m.Type {
			case "data":
				if err := h.term.Write([]byte(m.Data)); err != nil {
					slog.Warn("write terminal input failed", "err", err)
				}
			case "resize":
				if err := h.term.Resize(m.Cols, m.Rows); err != nil {
					slog.Warn("resize terminal failed", "err", err)
				}
			}
		}
	}()

	<-readDone
	slog.Info("websocket session ended")
}
