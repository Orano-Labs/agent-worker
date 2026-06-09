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

log_info "Making /mnt writable via tmpfs..."

mount -t tmpfs -o size=1M tmpfs /tmp
mount -t tmpfs -o size=1M tmpfs /mnt

log_info "Mounting ephemeral ScratchFS..."

mkdir -p /mnt/scratch
mount /dev/vdb /mnt/scratch || log_fatal "ScratchFS device missing!"

log_info "Initializing temporary local JuiceFS backend..."

JSF_STORAGE="/mnt/scratch/jsf_storage";
JSF_CACHE="/mnt/scratch/jsf_cache";
JSF_MOUNT="/mnt/scratch/jsf_mount";
JSF_META="sqlite3://mnt/scratch/jfs_meta.db"
JSF_LOG="/mnt/scratch/jsf_log"

export TMPDIR="/mnt/scratch/tmp"

mkdir -p "$JSF_STORAGE" "$JSF_CACHE" "$JSF_MOUNT" "$TMPDIR"

/usr/local/bin/juicefs --help

/usr/local/bin/juicefs format --bucket "$JSF_STORAGE" "$JSF_META" jsf

log_info "Mounting JuiceFS on top of ScratchFS..."

/usr/local/bin/juicefs mount -o allow_root --cache-dir="$JSF_CACHE" --log "$JSF_LOG" --no-usage-report "$JSF_META" "$JSF_MOUNT"

# 暂时未实现 NFS
# log_info "Attempting to mount Network File System (NFSv4)..."

# if ! mount -t nfs -o nfsvers=4,tcp,nolock,port=11111 10.123.0.1:/ /workspace 2>&1; then
#     log_fatal "NFS mount failed completely! Cannot proceed with application startup."
# fi

log_info "All file systems mounted successfully."
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
  --dir /proc \
  --dir /sys \
  --dir /workspace \
  --proc /proc \
  --dev /dev \
  --tmpfs "$TMPDIR" \
  --chdir /workspace \
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
