package terminal

import (
	"bytes"
	"testing"
	"time"
)

func TestTerminalOutputAndSnapshot(t *testing.T) {
	cfg := Config{
		Command: "/bin/sh",
		Args:    []string{"-c", "printf 'hello\\n'; sleep 0.1; printf 'world\\n'"},
	}

	term, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer term.Close()

	// First subscriber should receive a snapshot + the live "world" line.
	live := make(chan []byte, 16)
	sub1 := term.Subscribe(func(b []byte) {
		live <- b
	})
	defer sub1()

	// Wait for the process to exit.
	if err := term.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}

	// Drain all live output in the main goroutine until it goes quiet.
	var all []byte
	drain := time.Now().Add(2 * time.Second)
	for time.Now().Before(drain) {
		select {
		case b := <-live:
			all = append(all, b...)
			drain = time.Now().Add(2 * time.Second)
		case <-time.After(200 * time.Millisecond):
			drain = time.Now()
		}
	}
	if !bytes.Contains(all, []byte("hello")) || !bytes.Contains(all, []byte("world")) {
		t.Fatalf("subscriber missing live output, got: %q", all)
	}

	// A late subscriber should reconstruct the full buffer from its snapshot.
	snapshotCh := make(chan []byte, 16)
	sub2 := term.Subscribe(func(b []byte) { snapshotCh <- b })
	sub2()

	var snapshot []byte
	select {
	case snapshot = <-snapshotCh:
	case <-time.After(2 * time.Second):
		t.Fatal("snapshot was not delivered")
	}
	if !bytes.Contains(snapshot, []byte("hello")) || !bytes.Contains(snapshot, []byte("world")) {
		t.Fatalf("snapshot missing output, got: %q", snapshot)
	}
	t.Logf("snapshot: %q", snapshot)
	t.Logf("sub1 total: %q", all)
}

func TestTerminalResizeAndWrite(t *testing.T) {
	cfg := Config{
		Command: "/bin/sh",
		Args:    []string{"-c", "cat; exit"},
	}

	term, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer term.Close()

	if err := term.Resize(120, 40); err != nil {
		t.Fatalf("Resize: %v", err)
	}

	if err := term.Write([]byte("echo resize-ok\n\x04")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	if err := term.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
}

func TestTerminalIdleShutdownDisabled(t *testing.T) {
	// A zero (or negative) IdleTimeout must disable the idle reaper: a silent,
	// unattended terminal stays alive instead of being killed after the default
	// 20s would have elapsed. We assert it survives far past the reaper's check
	// granularity for a short explicit timeout.
	for _, idleTimeout := range []time.Duration{0, -1 * time.Second} {
		cfg := Config{
			Command:     "/bin/sh",
			Args:        []string{"-c", "sleep 30"},
			IdleTimeout: idleTimeout,
		}

		term, err := New(cfg)
		if err != nil {
			t.Fatalf("New (IdleTimeout=%v): %v", idleTimeout, err)
		}

		waitErr := make(chan error, 1)
		go func() { waitErr <- term.Wait() }()

		select {
		case err := <-waitErr:
			term.Close()
			t.Fatalf("IdleTimeout=%v: terminal exited despite disabled idle shutdown: %v", idleTimeout, err)
		case <-time.After(700 * time.Millisecond):
			// Still running, as expected.
		}

		term.Close()
	}
}

func TestConfigNormalizeKeepsZeroIdleTimeout(t *testing.T) {
	// Normalize must not silently map IdleTimeout==0 to the CLI default,
	// otherwise callers could never opt out of the idle reaper.
	cfg := Config{Command: "/bin/true"}.Normalize()
	if cfg.IdleTimeout != 0 {
		t.Fatalf("expected IdleTimeout to stay 0 (disabled), got %v", cfg.IdleTimeout)
	}
}

func TestTerminalIdleShutdown(t *testing.T) {
	cfg := Config{
		Command:     "/bin/sh",
		Args:        []string{"-c", "sleep 30"},
		IdleTimeout: 300 * time.Millisecond,
	}

	term, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// No subscribers and no output for IdleTimeout should terminate the process.
	waitErr := make(chan error, 1)
	go func() { waitErr <- term.Wait() }()

	select {
	case err := <-waitErr:
		t.Logf("idle shutdown: process exited with %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("terminal did not shut down after idle timeout")
	}
}
