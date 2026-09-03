package terminal

import (
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gitpod-io/xterm-go"
)

// Terminal runs a PTY-backed process and keeps an in-memory rendering of its
// output. Output read from the process is fed into an xterm buffer so the
// current screen state can be replayed to late subscribers as a snapshot,
// while the live output stream is distributed to every subscribed callback.
//
// Concurrency model:
//   - mu guards the xterm buffer, the subscriber registry and lastOutput.
//   - closed is an atomic flag so it can be read/written without mu.
//   - Each subscriber owns a FIFO channel drained by its own goroutine, so
//     callbacks are never invoked while holding mu.
type Terminal struct {
	mu sync.Mutex

	xterm     *xterm.Terminal
	serialize *xterm.SerializeAddon
	p         *process

	subs    map[int]*subscriber
	nextSub int

	closed      atomic.Bool
	lastOutput  time.Time
	idleTimeout time.Duration
	done        chan struct{}
}

// subscriber delivers the snapshot followed by every subsequent output chunk
// to a callback, in order, via its own goroutine.
type subscriber struct {
	id   int
	ch   chan []byte
	stop chan struct{}
}

// Write forwards user input to the process's PTY. The echoed output is picked
// up by the read loop and rendered/distributed like any other output.
func (t *Terminal) Write(data []byte) error {
	if t.closed.Load() {
		return errors.New("terminal: write on closed terminal")
	}
	if _, err := t.p.write(data); err != nil {
		return err
	}
	return nil
}

// Resize updates both the PTY window size and the in-memory xterm viewport.
func (t *Terminal) Resize(cols, rows uint16) error {
	if t.closed.Load() {
		return errors.New("terminal: resize on closed terminal")
	}
	if err := t.p.resize(cols, rows); err != nil {
		return err
	}

	t.mu.Lock()
	t.xterm.Resize(int(cols), int(rows))
	t.mu.Unlock()

	slog.Debug("terminal resized", "pid", t.p.pid(), "cols", cols, "rows", rows)
	return nil
}

// Subscribe registers a callback that receives a snapshot of the current
// screen state followed by all subsequent process output. The returned
// function unregisters the callback.
func (t *Terminal) Subscribe(fn func([]byte)) func() {
	t.mu.Lock()
	snapshot := t.serialize.Serialize(nil)
	s := &subscriber{
		id:   t.nextSub,
		ch:   make(chan []byte, 128),
		stop: make(chan struct{}),
	}
	t.nextSub++
	t.subs[s.id] = s
	count := len(t.subs)
	t.mu.Unlock()

	slog.Info("terminal subscriber added", "id", s.id, "count", count)
	go t.runSubscriber(s, fn, snapshot)

	return func() {
		t.mu.Lock()
		if _, ok := t.subs[s.id]; ok {
			delete(t.subs, s.id)
			close(s.stop)
			count := len(t.subs)
			slog.Info("terminal subscriber removed", "id", s.id, "count", count)
		}
		t.mu.Unlock()
	}
}

// runSubscriber emits the snapshot first, then forwards every queued output
// chunk to the callback in FIFO order until the subscriber is removed.
func (t *Terminal) runSubscriber(s *subscriber, fn func([]byte), snapshot []byte) {
	fn(snapshot)
	for {
		select {
		case <-s.stop:
			return
		case chunk := <-s.ch:
			fn(chunk)
		}
	}
}

// Wait blocks until the underlying process has exited and returns its status.
func (t *Terminal) Wait() error {
	return t.p.Wait()
}

// Close shuts down the terminal by closing the PTY, which terminates the
// attached process and stops the read loop. It is safe to call multiple times.
func (t *Terminal) Close() error {
	if !t.closed.CompareAndSwap(false, true) {
		return nil
	}

	close(t.done)
	slog.Info("terminal closing", "pid", t.p.pid())
	_ = t.p.pty.Close()
	return t.p.kill()
}

// readLoop reads process output from the PTY, renders it into the in-memory
// xterm buffer and broadcasts each chunk to all subscribed callbacks.
func (t *Terminal) readLoop() {
	buf := make([]byte, 32*1024)

	for {
		n, err := t.p.read(buf)
		if err != nil {
			switch {
			case t.closed.Load():
				slog.Debug("terminal read loop stopped", "pid", t.p.pid())
			case errors.Is(err, io.EOF):
				slog.Info("terminal pty reached EOF", "pid", t.p.pid())
			default:
				slog.Warn("terminal pty read failed", "pid", t.p.pid(), "err", err)
			}
			return
		}
		if n == 0 {
			continue
		}

		chunk := make([]byte, n)
		copy(chunk, buf[:n])

		t.mu.Lock()

		t.xterm.Write(chunk)
		t.lastOutput = time.Now()

		subs := make([]*subscriber, 0, len(t.subs))

		for _, s := range t.subs {
			subs = append(subs, s)
		}

		t.mu.Unlock()

		for _, s := range subs {
			select {
			case <-s.stop:
				// unsubscribed while we were dispatching; skip it
			case s.ch <- chunk:
			}
		}
	}
}

// watchIdle shuts the terminal down once it has been idle for the configured
// duration, where idle means no subscribers and no process output. It stops as
// soon as the terminal is closed. A non-positive IdleTimeout disables the
// reaper entirely; callers then must rely on the process exiting on its own.
func (t *Terminal) watchIdle() {
	ticker := time.NewTicker(time.Second * 2)

	defer ticker.Stop()

	for {
		select {
		case <-t.done:
			return
		case <-ticker.C:
		}

		if t.closed.Load() {
			return
		}

		t.mu.Lock()
		subCount := len(t.subs)
		idleFor := time.Since(t.lastOutput)
		idle := subCount == 0 && idleFor >= t.idleTimeout
		t.mu.Unlock()

		if idle {
			slog.Info("terminal idle; shutting down", "pid", t.p.pid(), "idle_timeout", t.idleTimeout, "subscribers", subCount, "idle_for", idleFor.Round(time.Second).String())
			_ = t.Close()
			return
		}
	}
}

// New starts a new PTY-backed process and returns a Terminal rendering it.
func New(cfg Config) (*Terminal, error) {
	cfg = cfg.Normalize()

	p, err := newProcess(cfg)

	if err != nil {
		return nil, err
	}

	term := xterm.New(
		xterm.WithCols(int(cfg.Cols)),
		xterm.WithRows(int(cfg.Rows)),
		xterm.WithScrollback(int(cfg.Scrollback)),
	)

	serialize := xterm.NewSerializeAddon(term)

	t := &Terminal{
		xterm:       term,
		serialize:   serialize,
		p:           p,
		subs:        make(map[int]*subscriber),
		lastOutput:  time.Now(),
		idleTimeout: cfg.IdleTimeout,
		done:        make(chan struct{}),
	}

	slog.Info("terminal created", "cmd", cfg.Command, "args", cfg.Args, "pid", p.pid(), "cols", cfg.Cols, "rows", cfg.Rows, "idle_timeout", cfg.IdleTimeout)

	go t.readLoop()

	if cfg.IdleTimeout > 0 {
		go t.watchIdle()
	} else {
		slog.Debug("idle shutdown disabled", "pid", p.pid())
	}

	return t, nil
}
