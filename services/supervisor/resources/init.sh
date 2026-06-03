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

# Signal trapping: Ensure that if the host sends SIGTERM/SIGINT to PID 1,
# the VM gracefully forwards the intent to the poweroff handler instead of hanging.
trap 'log_info "Termination signal received, exiting..."; power_off_now' INT TERM

log_info "Mounting core file systems..."

mountpoint -q /dev  || mount -t devtmpfs devtmpfs /dev   || log_fatal "Failed to mount /dev"
mountpoint -q /proc || mount -t proc     proc     /proc  || log_fatal "Failed to mount /proc"
mountpoint -q /sys  || mount -t sysfs    sysfs    /sys   || log_fatal "Failed to mount /sys"

# 暂时未实现 NFS
# log_info "Attempting to mount Network File System (NFSv4)..."

# if ! mount -t nfs -o nfsvers=4,tcp,nolock,port=11111 10.123.0.1:/ /workspace 2>&1; then
#     log_fatal "NFS mount failed completely! Cannot proceed with application startup."
# fi

log_info "All file systems mounted successfully."
log_info "Starting target application..."

# Temporarily disable 'set -e' to safely capture the Node.js exit status code
set +e

/sbin/tini -gs -- /usr/bin/node /app && NODE_EXIT_CODE=$?

# Restore strict error checking
set -e

if [ $NODE_EXIT_CODE -eq 0 ]; then
    log_info "Node process exited normally (Exit Code: 0)."
else
    log_error "Node process crashed! (Exit Code: $NODE_EXIT_CODE)."
fi

log_info "Preparing to tear down MicroVM..."

power_off_now
