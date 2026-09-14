#!/bin/sh

# Exit immediately if a command exits with a non-zero status
# Treat unset variables as an error when substituting
set -eu

# Custom logging function

info() {
  echo "[AW-ENTRYPOINT] $*"
}

error() {
  echo "[AW-ENTRYPOINT] ERROR: $*" >&2
}

fatal() {
  echo "[AW-ENTRYPOINT] FATAL: $*" >&2
  exit 1
}

# Lifecycle & Lifecycle Teardown Management
# Triggers an immediate kernel-level poweroff.
# This forces the Firecracker vCPU loop to exit cleanly and instantly.
power_off_now() {
  info "Triggering forced kernel poweroff..."

  # sync || true

  # -f forces immediate poweroff/reboot bypassing sysvinit/systemd.
  # Essential for microVMs to prevent hanging on teardown.
  poweroff -f || reboot -f || exit 1
}

# Global exit handler triggered by any trap event (EXIT, ERR, SIGTERM, SIGINT).
# This functions as a "bulletproof" firewall ensuring the VM ALWAYS powers off.
cleanup_and_poweroff() {
  # CRITICAL STEP: Immediately capture the exit status code.
  # Must be the absolute first line to prevent subsequent commands from overwriting $?.
  _actual_exit_code=${APPLICATION_EXIT_CODE:-$?}

  # Detach all traps to prevent accidental infinite recursion loops during teardown.
  # '|| true' ensures that even if unbinding fails, 'set -e' won't halt the execution.
  trap - EXIT SIGTERM SIGINT ERR || true

  if [ "$_actual_exit_code" -eq 0 ]; then
    info "MicroVM execution completed successfully (Exit Code: 0)." || true
  else
    error "MicroVM terminated abnormally! (Last Exit Code: $_actual_exit_code)." || true
  fi

  info "Preparing to tear down MicroVM..." || true

  power_off_now
}

# Intercept VM termination signals and shell exits.
# Ensures that if the host sends SIGTERM/SIGINT to PID 1, or if a command fails via 'set -e',
# the VM gracefully forwards control to the cleanup handler instead of hanging indefinitely.
trap cleanup_and_poweroff EXIT SIGTERM SIGINT ERR

info "Starting target application..."

# Temporarily disable 'set -e' to safely capture the Node.js exit status code.
# If Node.js throws an unhandled exception or exits with status > 0, we want
# our shell to capture it cleanly into $APPLICATION_EXIT_CODE rather than blowing up here.
set +e

# --idle-timeout=30s reaps a terminal only after 30 seconds of inactivity.
# /sbin/tini -gs -- \
/usr/local/bin/ptyd --port 8000 --idle-timeout 10s --command /usr/local/bin/pi \
  --env PI_CODING_AGENT_DIR=/workspace/.pi/agent \
  --env PI_CODING_AGENT_SESSION_DIR=/workspace/.pi/agent/sessions \
  -- \
  --continue

# Safely latch the exit code into a global variable readable by the EXIT trap handler
APPLICATION_EXIT_CODE=$?

# Restore strict shell error checking
set -e

# Terminate the shell script.
# This triggers the 'EXIT' trap ('cleanup_and_poweroff'), flowing directly into the shutdown sequence.
exit $APPLICATION_EXIT_CODE
