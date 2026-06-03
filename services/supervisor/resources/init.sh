#!/bin/sh

set -eu

# Function to trigger an immediate kernel-level poweroff
power_off_now() {
    echo "[INIT] Triggering forced kernel poweroff..."
    # -f forces immediate poweroff/reboot without invoking sysvinit/systemd,
    # which cleanly exits the Firecracker vCPU loop.
    poweroff -f || reboot -f || exit 1
}

# Signal trapping: Ensure that if the host sends SIGTERM/SIGINT to PID 1,
# the VM gracefully forwards the intent to the poweroff handler instead of hanging.
trap 'echo "[INIT] Termination signal received, exiting..."; power_off_now' INT TERM

echo "[INIT] Mounting core file systems..."

mountpoint -q /dev  || mount -t devtmpfs devtmpfs /dev   || { echo "❌ [FATAL] Failed to mount /dev"; power_off_now; }
mountpoint -q /proc || mount -t proc     proc     /proc  || { echo "❌ [FATAL] Failed to mount /proc"; power_off_now; }
mountpoint -q /sys  || mount -t sysfs    sysfs    /sys   || { echo "❌ [FATAL] Failed to mount /sys"; power_off_now; }

echo "[INIT] Attempting to mount Network File System (NFSv4)..."

if ! mount -t nfs -o nfsvers=4,tcp,nolock,port=11111 10.123.0.1:/ /workspace 2>&1; then
    echo "[FATAL] NFS mount failed completely! Cannot proceed with application startup."
    power_off_now
fi

echo "[INIT] All file systems mounted successfully."
echo "[INIT] Starting target application..."

# Temporarily disable 'set -e' to safely capture the Node.js exit status code
set +e

# Execute the Node application using Tini as the zombie/orphan reaper.
# We omit 'exec' so this sh script remains PID 1 to monitor the Node process.
/sbin/tini -g -- /usr/bin/node /app
NODE_EXIT_CODE=$?

# Restore strict error checking
set -e

if [ $NODE_EXIT_CODE -eq 0 ]; then
    echo "[INIT] Node process exited normally (Exit Code: 0)."
else
    echo "[INIT] Node process crashed! (Exit Code: $NODE_EXIT_CODE)."
fi
echo "[INIT] Preparing to tear down MicroVM..."

power_off_now
