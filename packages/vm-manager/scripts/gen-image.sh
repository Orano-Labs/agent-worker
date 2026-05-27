#!/bin/sh

set -e

log() {
  printf "\n"
  printf "\033[32m+---------------------------------------------------------------------\033[0m\n" >&2
  printf "\033[32m+ %s\033[0m\n" "$1" >&2
  printf "\033[32m+----------------------------------------------------------------------------\033[0m\n" >&2
  printf "\n"
}

# 获取当前脚本文件所在的绝对路径
SCRIPT_DIR=$(cd "$(dirname "$0")"; pwd)
ROOTFS_IMG="$SCRIPT_DIR/alpine-rootfs.ext4"

IMAGE_NAME="alpine-fc-base"

log "Updating system and installing required packages..."

# sudo apt update
sudo apt install -y buildah qemu-utils e2fsprogs

log "Pulling Alpine base image..."

CONTAINER=$(sudo buildah from alpine:latest)
CTR_DIR=$(sudo buildah mount $CONTAINER)

log "Container $CONTAINER created and mounted at $CTR_DIR. Installing dependencies inside the container..."

sudo cp /etc/resolv.conf $CTR_DIR/etc/resolv.conf

sudo chroot $CTR_DIR apk update
sudo chroot $CTR_DIR apk add --no-cache git nodejs npm tini

log "Creating disk image: $ROOTFS_IMG"

dd if=/dev/zero of=$ROOTFS_IMG bs=1M count=2048
mkfs.ext4 -F $ROOTFS_IMG

# 挂载空的磁盘
MNT_DIR=$(mktemp -d)

sudo mount $ROOTFS_IMG $MNT_DIR

log "Synchronizing data from container mount point to ext4 image..."

# 直接将容器数据复制进磁盘
sudo cp -a $CTR_DIR/. $MNT_DIR/

log "Injecting custom init script and sample Node.js application..."

# Create a directory for the Node.js application inside the rootfs
sudo mkdir -p $MNT_DIR/app

# Write a demo Node.js application
cat << 'EOF' | sudo tee $MNT_DIR/app/app.js
const http = require('http');

console.log("");
console.log("==================================================");
console.log("   Hello from Node.js inside Firecracker MicroVM! ");
console.log(`   Node.js version: ${process.version}            `);
console.log(`   Now: ${Date.now()}                             `);
console.log("==================================================");
console.log("");

// Create a simple HTTP server to keep the process alive
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello World from Firecracker!\n');
});

server.listen(8080, '0.0.0.0', () => {
  console.log('Server is running on http://0.0.0.0:8080');
});

setTimeout(() => {
  throw new Error("Error ....")
}, 3000)
EOF

# Write the PID 1 /init script
cat << 'EOF' | sudo tee $MNT_DIR/init
#!/bin/sh

mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys

echo "=== Base system initialized. Now: $(date +%s) ==="

# /sbin/tini -s -- /usr/bin/node /app/app.js

exec /sbin/tini -g -- /usr/bin/node /app/app.js

echo "Node.js application exited. Powering off MicroVM..."
reboot -f
EOF

# Make the init script executable
sudo chmod +x $MNT_DIR/init

log "Sync and injection complete. Cleaning up mounts and destroying temporary container..."

sudo umount $MNT_DIR && rmdir $MNT_DIR

sudo buildah rm $CONTAINER

log "Build complete! Temporary container assets removed. Final ext4 image generated at: $ROOTFS_IMG"

log "TEST ........... $(date +%s)"

sudo rm -f /tmp/firecracker.socket
sudo ./bin/firecracker --api-sock /tmp/firecracker.socket --config-file config.json
