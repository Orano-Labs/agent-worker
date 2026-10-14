#!/bin/sh

# Exit immediately if a command exits with a non-zero status
# Treat unset variables as an error when substituting
set -eu

# Custom Logging Functions
log() {
  echo "[INIT] $*"
}

fatal() {
  echo "[INIT] FATAL: $*" >&2
  exit 1
}

SCRATCH_DEV=vdb
SCRATCH_MNT=/mnt/scratch

OVERLAY_BASE=$SCRATCH_MNT/overlay
OVERLAY_UPPER=$OVERLAY_BASE/upper
OVERLAY_WORK=$OVERLAY_BASE/work
OVERLAY_ROOT=$OVERLAY_BASE/root

if [ ! -b "/dev/$SCRATCH_DEV" ]; then
  fatal "Scratch device /dev/$SCRATCH_DEV does not exist!"
fi

log "Preparing temporary mount environment and mounting /dev/$SCRATCH_DEV..."

# Create a minimal tmpfs bootstrap directory to prevent modifying the read-only rootfs
mkdir -p /mnt
mount -t tmpfs -o noatime,nosuid,nodev,mode=0755,size=1M tmpfs /mnt || fatal "Failed to mount bootstrap /mnt"

log "Mounting scratch filesystem from $SCRATCH_DEV..."

mkdir -p "$SCRATCH_MNT"
mount -t ext4 -o noatime,nosuid,nodev "/dev/$SCRATCH_DEV" "$SCRATCH_MNT" || fatal "Failed to mount /dev/$SCRATCH_DEV"

log "Configuring OverlayFS layers..."

mkdir -p "$OVERLAY_UPPER" "$OVERLAY_WORK" "$OVERLAY_ROOT" || fatal "Failed to create OverlayFS directories!"
mount -t overlay overlay "$OVERLAY_ROOT" -o "lowerdir=/,upperdir=$OVERLAY_UPPER,workdir=$OVERLAY_WORK" || fatal "Failed to mount OverlayFS"

# pivot_root requires put_old to exist below the new root.
mkdir -p "$OVERLAY_ROOT/rom" || fatal "Failed to create old-root mountpoint!"

# Prevent propagation of mounts between the old and new root trees.
mount --make-rprivate / || fatal "Failed to make root mount private"

log "Pivoting root filesystem..."

pivot_root "$OVERLAY_ROOT" "$OVERLAY_ROOT/rom" || fatal "pivot_root failed"
# pivot_root does not change the caller's current working directory.
cd / || fatal "Failed to change working directory to new root!"

log "Detaching old root filesystem and cleaning up init artifacts..."

# The old root, including the bootstrap /mnt tmpfs, is now reachable at /rom.
# Lazy unmount removes it from the visible mount topology while allowing
# outstanding kernel references to remain until they disappear.
umount -l /rom || fatal "Failed to detach old root"

# /rom is now only an ordinary directory in the overlay namespace.
rm -rf /rom

# Hide the original init from the OverlayFS view.
#
# If /init exists only in the lower layer, OverlayFS records this deletion
# as an upper-layer whiteout.
rm -f /init || fatal "Failed to remove old init!"

log "Mounting core virtual filesystems..."

mkdir -p /dev /proc /sys /run

mountpoint -q /dev  || mount -t devtmpfs devtmpfs /dev                                    || fatal "Failed to mount /dev"
mountpoint -q /proc || mount -t proc     proc     /proc                                   || fatal "Failed to mount /proc"
mountpoint -q /sys  || mount -t sysfs    sysfs    /sys                                    || fatal "Failed to mount /sys"
mountpoint -q /run  || mount -t tmpfs    tmpfs    /run -o mode=0755,nosuid,nodev,size=16M || fatal "Failed to mount /run"

mkdir -p /dev/pts /dev/shm

mountpoint -q /dev/pts || mount -t devpts devpts /dev/pts -o mode=0620,ptmxmode=0666,gid=5   || fatal "Failed to mount /dev/pts"
mountpoint -q /dev/shm || mount -t tmpfs tmpfs /dev/shm   -o mode=1777,nosuid,nodev,size=64M || fatal "Failed to mount /dev/shm"

log "Core virtual filesystems mounted successfully."

###############################################################################
# Multi-NFS Mounting (Must run before dropping CAP_SYS_ADMIN)
#
# Configuration File Format: /etc/nfs.conf
# Format (fstab-style): <file system> <mount point> [options]
# Fields (space/tab-separated):
#   1. <file system> : NFS export (Required, e.g., 10.123.0.1:/exports/data)
#   2. <mount point> : Local mount point in VM (Required, e.g., /workspace/data)
#   3. <options>     : Mount options (Optional, default: defaults,_netdev,nofail)
#
# Examples:
#   10.123.0.1:/exports/code    /workspace/code     defaults,_netdev,nofail,vers=4.1,port=26088
#   10.123.0.1:/exports/data    /workspace/data     defaults,_netdev,nofail
#   10.123.0.2:/exports/datasets /workspace/datasets ro,soft,vers=4.0,port=2049
###############################################################################
NFS_CONFIG="/etc/nfs.conf"

if [ -f "$NFS_CONFIG" ]; then
  log "Processing multi-NFS mount configuration from $NFS_CONFIG..."

  # Strip comments (#) and empty lines, then iterate through each mount entry
  grep -v '^[[:space:]]*#' "$NFS_CONFIG" | grep -v '^[[:space:]]*$' | while read -r FS MNT OPTS || [ -n "$FS" ]; do

    # Sanitize inputs by trimming leading/trailing spaces and carriage returns
    FS=$(echo "$FS" | tr -d '\r')
    MNT=$(echo "$MNT" | tr -d '\r')
    OPTS=$(echo "$OPTS" | tr -d '\r')

    # Validate mandatory fields
    if [ -z "$FS" ] || [ -z "$MNT" ]; then
      log "WARNING: Skipping invalid NFS line: '$FS $MNT $OPTS' (file system and mount point are required)"
      continue
    fi

    # Apply default parameters if omitted in configuration
    [ -n "$OPTS" ] || OPTS="defaults,_netdev,nofail"

    log "Mounting NFS: $FS -> $MNT (opts: $OPTS)..."

    mkdir -p "$MNT" || fatal "Failed to create mountpoint $MNT"

    mount -t nfs -o "$OPTS" "$FS" "$MNT" || fatal "Failed to mount $FS to $MNT!"

    log "Successfully mounted $MNT"
  done

  log "Removing NFS configuration file to protect internal network topology..."
  rm -f "$NFS_CONFIG"
fi

###############################################################################
# Restrict userspace access to the OverlayFS backing storage.
###############################################################################

log "Removing direct access to /dev/$SCRATCH_DEV..."

# OverlayFS has already acquired the required references to upperdir/workdir.
#
# No userspace operation from the final root should access the scratch block
# device directly through the normal device-node path.
rm -f "/dev/$SCRATCH_DEV" || fatal "Failed to remove /dev/$SCRATCH_DEV!"

log "Hiding OverlayFS backing filesystem..."

# Hide the scratch filesystem from the final root hierarchy.
#
# The scratch filesystem MUST remain mounted because OverlayFS still uses:
#  upperdir = /mnt/scratch/overlay/upper
#  workdir = /mnt/scratch/overlay/work
# Therefore /mnt is covered by a new tmpfs rather than unmounting scratch.
mount -t tmpfs -o noatime,nosuid,nodev,mode=0755,size=1M tmpfs /mnt || fatal "Failed to hide scratch filesystem!"

USER_INIT=/sbin/init

if [ ! -x "$USER_INIT" ]; then
  fatal "Userspace init $USER_INIT does not exist!"
fi

if ! command -v capsh >/dev/null 2>&1; then
  fatal "capsh is required to drop CAP_SYS_ADMIN!"
fi

log "Removing CAP_SYS_ADMIN from userspace capability state..."

# The order matters: the restricted capabilities are removed from the
# capability sets before they are removed from the Bounding set.
# CAP_SETPCAP is therefore retained until all requested capability
# transformations have been performed.
exec capsh \
  --secbits=207 \
  --noamb \
  --no-new-privs \
  --drop=cap_sys_admin,cap_sys_module,cap_sys_rawio,cap_sys_ptrace,cap_dac_override,cap_dac_read_search,cap_net_admin,cap_net_raw,cap_sys_boot,cap_setuid,cap_setgid,cap_mac_admin,cap_mac_override,cap_bpf,cap_perfmon,cap_checkpoint_restore,cap_mknod,cap_setfcap,cap_setpcap \
  -- \
  -c '
    # Fail closed if capability state cannot be inspected.
    #
    # Do NOT use "capsh --print | grep cap_xxx" here.
    #
    # capsh --print can represent absent capabilities as "!cap_xxx", which
    # would still match a simple grep. The kernel-visible /proc/self/status
    # vectors below are therefore the authoritative checks.

    check_no_capability()
    {
      NAME="$1"
      VALUE="$2"
      CAP="$3"
      BIT="$4"

      VALUE=$((16#$VALUE))
      MASK=$((1 << BIT))

      if [ $((VALUE & MASK)) -ne 0 ]; then
        echo "FATAL: $CAP present in $NAME: $2" >&2
        exit 1
      fi
    }

    CAP_INH=$(awk "/^CapInh:/ {print \$2}" /proc/self/status)
    CAP_PRM=$(awk "/^CapPrm:/ {print \$2}" /proc/self/status)
    CAP_EFF=$(awk "/^CapEff:/ {print \$2}" /proc/self/status)
    CAP_BND=$(awk "/^CapBnd:/ {print \$2}" /proc/self/status)
    CAP_AMB=$(awk "/^CapAmb:/ {print \$2}" /proc/self/status)

    [ -n "$CAP_INH" ] || { echo "FATAL: CapInh unavailable" >&2; exit 1; }
    [ -n "$CAP_PRM" ] || { echo "FATAL: CapPrm unavailable" >&2; exit 1; }
    [ -n "$CAP_EFF" ] || { echo "FATAL: CapEff unavailable" >&2; exit 1; }
    [ -n "$CAP_BND" ] || { echo "FATAL: CapBnd unavailable" >&2; exit 1; }
    [ -n "$CAP_AMB" ] || { echo "FATAL: CapAmb unavailable" >&2; exit 1; }

    # Verify restricted capabilities in every capability set.

    for CAP in \
      "CAP_SYS_ADMIN:21" \
      "CAP_SYS_MODULE:16" \
      "CAP_SYS_RAWIO:17" \
      "CAP_SYS_PTRACE:19" \
      "CAP_DAC_OVERRIDE:1" \
      "CAP_DAC_READ_SEARCH:2" \
      "CAP_NET_ADMIN:12" \
      "CAP_NET_RAW:13" \
      "CAP_SYS_BOOT:22" \
      "CAP_SETUID:7" \
      "CAP_SETGID:6" \
      "CAP_SETPCAP:8" \
      "CAP_MAC_ADMIN:33" \
      "CAP_MAC_OVERRIDE:32" \
      "CAP_BPF:39" \
      "CAP_PERFMON:38" \
      "CAP_CHECKPOINT_RESTORE:40" \
      "CAP_MKNOD:27" \
      "CAP_SETFCAP:31"
    do
      NAME="${CAP%%:*}"
      BIT="${CAP##*:}"

      check_no_capability "Inheritable" "$CAP_INH" "$NAME" "$BIT"
      check_no_capability "Permitted"   "$CAP_PRM" "$NAME" "$BIT"
      check_no_capability "Effective"   "$CAP_EFF" "$NAME" "$BIT"
      check_no_capability "Bounding"    "$CAP_BND" "$NAME" "$BIT"
      check_no_capability "Ambient"     "$CAP_AMB" "$NAME" "$BIT"
    done

    # Verify no_new_privs.

    NO_NEW_PRIVS=$(awk "/^NoNewPrivs:/ {print \$2}" /proc/self/status)

    [ "$NO_NEW_PRIVS" = "1" ] || {
      echo "FATAL: NoNewPrivs is not enabled!" >&2
      exit 1
    }

    # Verify the important security properties using capsh output.
    #
    # Capability presence itself is NOT checked here; the kernel bitmasks above
    # are authoritative for that.

    STATE=$(capsh --print 2>/dev/null) || {
      echo "FATAL: unable to inspect final capability state" >&2
      exit 1
    }

    # Verify securebits using human-readable capsh output.

    echo "$STATE" | grep -q "secure-noroot: yes" || {
      echo "FATAL: SECBIT_NOROOT is not enabled!" >&2
      echo "$STATE" >&2
      exit 1
    }

    echo "$STATE" | grep -qE "secure-noroot: yes \(locked\)" || {
      echo "FATAL: SECBIT_NOROOT_LOCKED is not enabled!" >&2
      echo "$STATE" >&2
      exit 1
    }

    echo "$STATE" | grep -q "secure-no-suid-fixup: yes" || {
      echo "FATAL: SECBIT_NO_SETUID_FIXUP is not enabled!" >&2
      echo "$STATE" >&2
      exit 1
    }

    echo "$STATE" | grep -qE "secure-no-suid-fixup: yes \(locked\)" || {
      echo "FATAL: SECBIT_NO_SETUID_FIXUP_LOCKED is not enabled!" >&2
      echo "$STATE" >&2
      exit 1
    }

    echo "$STATE" | grep -q "secure-no-ambient-raise: yes" || {
      echo "FATAL: SECBIT_NO_CAP_AMBIENT_RAISE is not enabled!" >&2
      echo "$STATE" >&2
      exit 1
    }

    echo "$STATE" | grep -qE "secure-no-ambient-raise: yes \(locked\)" || {
      echo "FATAL: SECBIT_NO_CAP_AMBIENT_RAISE_LOCKED is not enabled!" >&2
      echo "$STATE" >&2
      exit 1
    }

    # Final verification of the scratch device path.

    if [ -e "/dev/vdb" ]; then
      echo "FATAL: /dev/vdb is still visible!" >&2
      exit 1
    fi

    # Final verification of the hidden scratch mountpoint.

    if [ -e /mnt/scratch ]; then
      echo "FATAL: /mnt/scratch is still visible!" >&2
      exit 1
    fi

    echo "Launching userspace init with Tini..."

    exec tini -- /entrypoint
  '

fatal "Failed to start userspace!"
