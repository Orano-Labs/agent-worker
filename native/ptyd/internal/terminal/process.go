package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

// process wraps a PTY-backed child process. The PTY master is the single I/O
// endpoint: read() consumes the process output, while write() and resize()
// send input and viewport changes downstream.
//
// Its lifecycle synchronization (the exit notification and the wait result)
// is encapsulated behind Done() and Wait(); callers never touch the internal
// state directly.
type process struct {
	cmd *exec.Cmd
	pty *os.File

	// done is closed exactly once, when the process has exited.
	done chan struct{}

	// waitOnce guarantees cmd.Wait runs exactly once, and that waitErr is
	// published to every concurrent Wait() caller.
	waitOnce sync.Once
	waitErr  error
}

// read consumes output from the PTY master.
func (p *process) read(buf []byte) (int, error) {
	return p.pty.Read(buf)
}

// write forwards input to the PTY master.
func (p *process) write(data []byte) (int, error) {
	return p.pty.Write(data)
}

// pid returns the OS process id, or 0 if the process has not started yet.
func (p *process) pid() int {
	if p.cmd.Process != nil {
		return p.cmd.Process.Pid
	}

	return 0
}

// resize updates the PTY window size so the child sees the new viewport.
func (p *process) resize(cols, rows uint16) error {
	return pty.Setsize(p.pty, &pty.Winsize{
		Cols: cols,
		Rows: rows,
	})
}

// kill terminates the attached process so that Wait returns. Any grandchildren
// are reparented once the shell is killed.
func (p *process) kill() error {
	if p.cmd.Process == nil {
		return nil
	}

	return p.cmd.Process.Kill()
}

// Done returns a channel that is closed exactly once, when the process has
// exited. It is safe to call from any goroutine.
func (p *process) Done() <-chan struct{} {
	return p.done
}

// Wait blocks until the process has exited and returns its exit status. It is
// safe to call concurrently: the underlying cmd.Wait runs exactly once and its
// result is shared atomically among all callers.
func (p *process) Wait() error {
	p.waitOnce.Do(func() {
		p.waitErr = p.cmd.Wait()
		close(p.done)
	})

	return p.waitErr
}

// newProcess starts a PTY-backed process from cfg. It returns an error if the
// process could not be spawned. The wait is initiated in the background so the
// process lifecycle is tracked from the moment it starts.
func newProcess(cfg Config) (*process, error) {
	cmd := exec.Command(cfg.Command, cfg.Args...)

	cmd.Dir = cfg.Dir
	cmd.Env = append(os.Environ(), cfg.Env...)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: cfg.Cols,
		Rows: cfg.Rows,
	})

	if err != nil {
		return nil, fmt.Errorf("start process: %w", err)
	}

	p := &process{
		cmd:  cmd,
		pty:  ptmx,
		done: make(chan struct{}),
	}

	go p.Wait()

	return p, nil
}
