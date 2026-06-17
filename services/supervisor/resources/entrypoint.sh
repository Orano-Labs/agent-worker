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
    info "Enforcing WebDAV sync on /workspace via recursive traversal before abrupt shutdown..."

    # Recursively traverse the WebDAV mount point.
    # Since davfs2 is configured with 'delay_upload 0' (instant upload on close),
    # this forces davfs2 to flush all local caches, pending uploads, and metadata
    # back to the remote storage before the OS cuts the power.
    ls -R /workspace > /dev/null 2>&1

    # -f forces immediate poweroff/reboot bypassing sysvinit/systemd.
    # Essential for microVMs to prevent hanging on teardown.
    poweroff -f || reboot -f || exit 1
}

# Global exit handler triggered by any trap event (EXIT, ERR, SIGTERM, SIGINT).
# This functions as a "bulletproof" firewall ensuring the VM ALWAYS powers off.
cleanup_and_poweroff() {
    # CRITICAL STEP: Immediately capture the exit status code.
    # Must be the absolute first line to prevent subsequent commands from overwriting $?.
    _actual_exit_code=${NODE_EXIT_CODE:-$?}

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

# Mount Core Virtual File Systems (Required for PID 1 Init)
info "Mounting core file systems..."

mountpoint -q /dev  || mount -t devtmpfs devtmpfs /dev   || fatal "Failed to mount /dev"
mountpoint -q /proc || mount -t proc     proc     /proc  || fatal "Failed to mount /proc"
mountpoint -q /sys  || mount -t sysfs    sysfs    /sys   || fatal "Failed to mount /sys"

info "Mounting core file systems completed successfully."

# Log configuration metadata for troubleshooting/auditing
info "RUNNER ID: ${AW_RUNNER_ID}"
info "RUNNER FS USERNAME: ${AW_RUNNER_FS_USERNAME}"
info "RUNNER FS PASSWORD: ${AW_RUNNER_FS_PASSWORD}"
info "RUNNER PROJECT: ${AW_RUNNER_PROJECT}"

# Purge redundant init files to free up memory and prevent container escape vectors
rm -rf /mnt
rm -rf /init
rm -rf /entrypoint

info "Configuring WebDAV (davfs2)..."

# Inject secrets required for davfs2 auto-authentication
echo "http://10.123.0.1:2049 $AW_RUNNER_FS_USERNAME $AW_RUNNER_FS_PASSWORD" >> /etc/davfs2/secrets

# Optimize davfs2 parameters for low-latency, real-time sync environments:
# - delay_upload 0: Instantly upload files on close (no delayed caching).
# - dir_refresh / file_refresh: Minimal aggressive caching for metadata sync.
# - cache_dir / cache_size: Cap memory/disk footprints in constraints of MicroVMs.
echo "delay_upload 0" >> /etc/davfs2/davfs2.conf
echo "dir_refresh 10" >> /etc/davfs2/davfs2.conf
echo "file_refresh 1" >> /etc/davfs2/davfs2.conf
echo "cache_dir /tmp/davfs2-cache" >> /etc/davfs2/davfs2.conf
echo "cache_size 64" >> /etc/davfs2/davfs2.conf
echo "table_size 512" >> /etc/davfs2/davfs2.conf
echo "use_locks 0" >> /etc/davfs2/davfs2.conf
echo "debug locks,cache,kernel" >> /etc/davfs2/davfs2.conf

info "Mounting remote file system to /workspace..."

mount.davfs http://10.123.0.1:2049 /workspace

info "All file systems mounted successfully."
info "Current System Metrics before starting target application:"

if command -v free >/dev/null 2>&1; then
    free -h | sed 's/^/[AW-ENTRYPOINT] /'
else
    info "MemTotal: $(awk '/MemTotal/ {print $2" "$3}' /proc/meminfo)"
    info "MemAvailable: $(awk '/MemAvailable/ {print $2" "$3}' /proc/meminfo)"
fi

if command -v uptime >/dev/null 2>&1; then
    info "CPU Load: $(uptime)"
else
    info "CPU Load (1/5/15 min): $(cat /proc/loadavg | awk '{print $1", "$2", "$3}')"
fi

info "Starting target application..."

# Temporarily disable 'set -e' to safely capture the Node.js exit status code.
# If Node.js throws an unhandled exception or exits with status > 0, we want
# our shell to capture it cleanly into $NODE_EXIT_CODE rather than blowing up here.
set +e

# Run Node.js through 'tini' as a sub-reaper.
# Tini properly forwards OS signals (like SIGTERM) to Node.js and reaps zombie processes.
/sbin/tini -gs -- /usr/bin/node /app

# Safely latch the exit code into a global variable readable by the EXIT trap handler
NODE_EXIT_CODE=$?

# Restore strict shell error checking
set -e

# Terminate the shell script.
# This triggers the 'EXIT' trap ('cleanup_and_poweroff'), flowing directly into the shutdown sequence.
exit $NODE_EXIT_CODE
