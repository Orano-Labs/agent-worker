#!/bin/sh

set -eu

# Custom logging function
log_info() {
    echo "[AW-INIT] $*"
}

log_error() {
    echo "[AW-INIT] ERROR: $*" >&2
}

log_fatal() {
    echo "[AW-INIT] FATAL: $*" >&2
    power_off_now
}

# Function to trigger an immediate kernel-level poweroff
power_off_now() {
    log_info "Triggering forced kernel poweroff..."
    # -f forces immediate poweroff/reboot without invoking sysvinit/systemd,
    # which cleanly exits the Firecracker vCPU loop.
    poweroff -f || reboot -f || exit 1
}

verify_network() {
  local gw="10.123.0.1"
  local passed=0

  log_info "Auditing virtual machine network boundaries (DEBUG MODE)..."

  if ! ping -c 1 -W 1 "$gw" >/dev/null 2>&1; then
    log_error "Allowed traffic blocked: Default Gateway ($gw)"
    passed=1
  fi

  if ! timeout 2 nc -z 114.114.114.114 53 >/dev/null 2>&1; then
    log_error "Allowed traffic blocked: Whitelisted DNS TCP (114.114.114.114:53)"
    passed=1
  fi

  if ! timeout 2 nc -z 223.5.5.5 443 >/dev/null 2>&1; then
    log_error "Allowed traffic blocked: Public Web TCP (223.5.5.5:443)"
    passed=1
  fi

  if ping -c 1 -W 2 192.168.1.1 >/dev/null 2>&1; then
    log_error "Security leak: Private CIDR probing was not blocked (192.168.1.1)"
    passed=1
  fi

  if [ "$passed" -eq 0 ]; then
    log_info "Network boundary audit passed successfully."
  else
    log_error "Network boundary audit failed!"
  fi

  return $passed
}

# Signal trapping: Ensure that if the host sends SIGTERM/SIGINT to PID 1,
# the VM gracefully forwards the intent to the poweroff handler instead of hanging.
trap 'log_info "Termination signal received, exiting..."; power_off_now' INT TERM

log_info "Mounting core file systems..."

mountpoint -q /dev  || mount -t devtmpfs devtmpfs /dev   || log_fatal "Failed to mount /dev"
mountpoint -q /proc || mount -t proc     proc     /proc  || log_fatal "Failed to mount /proc"
mountpoint -q /sys  || mount -t sysfs    sysfs    /sys   || log_fatal "Failed to mount /sys"

log_info "Making /mnt writable via tmpfs..."

mount -t tmpfs -o size=1M tmpfs /mnt

mkdir -p /mnt/scratch/tmpfs
mkdir -p /mnt/scratch/tmp

mount /dev/vdb /mnt/scratch || log_fatal "ScratchFS device missing!"

mount -t nfs -o nfsvers=4,async,rsize=1048576,wsize=1048576,nocto,actimeo=60 10.123.0.1:/exports/aw-mount /workspace

log_info "All file systems mounted successfully."

# Trigger network boundary audit only if requested via kernel boot parameters
if grep -q "aw.audit_net=1" /proc/cmdline; then
    verify_network || log_error "Infrastructure compromised due to anomalous firewall states."
else
    log_info "Network boundary audit skipped (not requested via kernel args)."
fi

log_info "Current System Metrics before starting target application:"

if command -v free >/dev/null 2>&1; then
    free -h | sed 's/^/[AW-INIT] /'
else
    log_info "MemTotal: $(awk '/MemTotal/ {print $2" "$3}' /proc/meminfo)"
    log_info "MemAvailable: $(awk '/MemAvailable/ {print $2" "$3}' /proc/meminfo)"
fi

if command -v uptime >/dev/null 2>&1; then
    log_info "CPU Load: $(uptime)"
else
    log_info "CPU Load (1/5/15 min): $(cat /proc/loadavg | awk '{print $1", "$2", "$3}')"
fi

log_info "Starting target application..."

# Temporarily disable 'set -e' to safely capture the Node.js exit status code
set +e

/sbin/tini -gs -- /usr/bin/bwrap \
  --ro-bind-try /usr /usr \
  --ro-bind-try /etc /etc \
  --ro-bind-try /lib /lib \
  --ro-bind-try /bin /bin \
  --ro-bind-try /sbin /sbin \
  --ro-bind-try /app /app \
  --ro-bind-try /sys /sys \
  --bind /workspace /workspace \
  --bind /tmp /mnt/scratch/tmp \
  --dir /proc \
  --dir /sys \
  --proc /proc \
  --dev /dev \
  --tmpfs /mnt/scratch/tmpfs \
  /usr/bin/node /app && NODE_EXIT_CODE=$?

# Restore strict error checking
set -e

if [ $NODE_EXIT_CODE -eq 0 ]; then
    log_info "Node process exited normally (Exit Code: 0)."
else
    log_error "Node process crashed! (Exit Code: $NODE_EXIT_CODE)."
fi

log_info "Preparing to tear down MicroVM..."

power_off_now
