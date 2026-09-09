#!/bin/sh

# Exit immediately if a command exits with a non-zero status
# Treat unset variables as an error when substituting
set -eu

# Custom Logging Functions
log() {
  echo "[AW-INIT] $*"
}

fatal() {
  echo "[AW-INIT] FATAL: $*" >&2
  exit 1
}

# Define the scratch block device assigned to the VM
SCRATCH_DEV=vdb

if [ ! -b "/dev/$SCRATCH_DEV" ]; then
  fatal "Scratch device /dev/$SCRATCH_DEV does not exist!"
fi

log "Preparing temporary mount environment and mounting /dev/$SCRATCH_DEV..."

# Create a minimal tmpfs bootstrap directory to prevent modifying the read-only rootfs
mkdir -p /mnt
mount -t tmpfs -o noatime,mode=0755,size=1M tmpfs /mnt

log "Mounting scratch filesystem from $SCRATCH_DEV..."

mkdir -p /mnt/scratch
mount -t ext4 -o noatime /dev/"$SCRATCH_DEV" /mnt/scratch || fatal "Failed to mount scratch drive /dev/$SCRATCH_DEV!"

log "Configuring OverlayFS layers..."

# Define directories for the OverlayFS structure
# - lowerdir: The original read-only root filesystem (/)
# - upperdir: The writable workspace located on the ext4 scratch device
# - workdir: Required by OverlayFS on the same filesystem as upperdir for atomic operations
# - root: The target unified directory that will become the new root
OVERLAY_LOWER=/
OVERLAY_UPPER=/mnt/scratch/overlay/upper
OVERLAY_WORK=/mnt/scratch/overlay/work
OVERLAY_ROOT=/mnt/scratch/overlay/root

mkdir -p "$OVERLAY_UPPER" "$OVERLAY_WORK" "$OVERLAY_ROOT"

# Assemble the OverlayFS
mount \
  -o noatime,lowerdir=${OVERLAY_LOWER},upperdir=${OVERLAY_UPPER},workdir=${OVERLAY_WORK} \
  -t overlay "overlayfs" ${OVERLAY_ROOT}

# Create a mountpoint inside the OverlayFS view to temporarily hold the old rootfs
mkdir -p "$OVERLAY_ROOT/rom"

# Ensure root mount propagation is private; required by pivot_root to avoid EINVAL
mount --make-rprivate / || fatal "Failed to set mount propagation to private!"

log "Pivoting root file system..."

# Pivot root: OVERLAY_ROOT becomes the new '/', and old '/' is moved to '/rom'
pivot_root "$OVERLAY_ROOT" "$OVERLAY_ROOT/rom" || fatal "pivot_root failed!"

log "Detaching old root filesystem and cleaning up init artifacts..."

# Lazy-unmount /rom to detach the old rootfs and bootstrap tmpfs mounts from the new mount namespace
umount -l /rom

# Remove the leftover /rom directory and mask the old /init executable via an OverlayFS whiteout
rm -rf /rom
rm -f  /init

log "Mounting core virtual file systems..."

mountpoint -q /dev  || mount -t devtmpfs devtmpfs /dev   || fatal "Failed to mount /dev"
mountpoint -q /proc || mount -t proc     proc     /proc  || fatal "Failed to mount /proc"
mountpoint -q /sys  || mount -t sysfs    sysfs    /sys   || fatal "Failed to mount /sys"

mkdir -p /dev/pts /dev/shm /run

mountpoint -q /dev/pts || mount -t devpts   devpts   /dev/pts -o mode=0620,ptmxmode=0666,gid=5   || fatal "Failed to mount /dev/pts"
mountpoint -q /dev/shm || mount -t tmpfs    tmpfs    /dev/shm -o mode=1777,nosuid,nodev,size=64M || fatal "Failed to mount /dev/shm"
mountpoint -q /run     || mount -t tmpfs    tmpfs    /run     -o mode=0755,nosuid,nodev,size=16M || fatal "Failed to mount /run"

log "Mounting core file systems completed successfully."
log "Handing over execution to entrypoint..."

# Replace the current shell process image with the next-stage /entrypoint script.
# This cleanly passes down all positional arguments ($@).
# exec /sbin/tini -g -- /entrypoint "$@"
/usr/local/bin/juicefs mount redis://:redis_xtd6tz@117.55.235.4:6379/3 /workspace --background --subdir "/projects/${AW_RUNNER_PROJECT}"  || fatal "Failed to mount /workspace"

exec bwrap \
  --die-with-parent \
  --unshare-all \
  --share-net \
  --tmpfs / \
  --tmpfs /run \
  --dev /dev \
  --proc /proc \
  --ro-bind /bin /bin \
  --ro-bind /sbin /sbin \
  --ro-bind /usr /usr \
  --ro-bind /etc /etc \
  --ro-bind /lib /lib \
  --ro-bind /sys /sys \
  --ro-bind /var /var \
  --bind /tmp /tmp \
  --bind /workspace /workspace \
  --ro-bind /entrypoint /entrypoint.sh \
  --clearenv \
  --setenv PATH "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -- /sbin/tini -g -- /entrypoint.sh "$@"
