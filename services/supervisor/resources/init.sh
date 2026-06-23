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
mount -t tmpfs -o noatime,mode=0755,size=1M tmpfs /mnt

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

# Create a placeholder directory inside the new root to house the old read-only rootfs
mkdir -p "$OVERLAY_ROOT/rom"

log "Pivoting root file system..."

# Pivot the root filesystem: OVERLAY_ROOT becomes the new '/', and old '/' moves to '/rom'
pivot_root "$OVERLAY_ROOT" "$OVERLAY_ROOT/rom"

log "Handing over control to the main entrypoint..."

# Purge redundant init files to free up memory and prevent container escape vectors
rm -rf /mnt
rm -rf /init

# Replace the current shell process image with the next-stage /entrypoint script.
# This cleanly passes down all positional arguments ($@).
exec /entrypoint "$@"
