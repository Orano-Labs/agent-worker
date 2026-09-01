#!/bin/bash
set -e

DEFAULT_TARGET="${HOME}/.aw-supervisor/kernel/vmlinux"
TARGET_PATH="${1:-$DEFAULT_TARGET}"

ARCH=$(uname -m)

if [ "$ARCH" == "x86_64" ]; then
    CONFIG_NAME="microvm-kernel-ci-x86_64-6.1.config"
elif [ "$ARCH" == "aarch64" ]; then
    CONFIG_NAME="microvm-kernel-ci-aarch64-6.1.config"
else
    echo "Unsupported Arch: $ARCH"
    exit 1
fi

KERNEL_DIR="/tmp/linux-amazon"

# Clone Amazon Linux kernel if not present
if [ ! -d "${KERNEL_DIR}" ]; then
    echo "Cloning Amazon Linux kernel..."
    git clone --depth 1 --branch microvm-kernel-6.1.102-1.182.amzn2023 \
        https://github.com/amazonlinux/linux.git "${KERNEL_DIR}"
fi

cd "${KERNEL_DIR}"

echo "Downloading Firecracker kernel config..."

curl -L -o .config "https://raw.githubusercontent.com/firecracker-microvm/firecracker/refs/heads/main/resources/guest_configs/$CONFIG_NAME"

# Disable certificate/keyring stuff that requires OpenSSL
./scripts/config --disable SYSTEM_TRUSTED_KEYRING
./scripts/config --disable SECONDARY_TRUSTED_KEYRING
./scripts/config --disable SYSTEM_REVOCATION_KEYS
./scripts/config --disable MODULE_SIG
./scripts/config --disable INTEGRITY
./scripts/config --disable IMA
./scripts/config --disable EVM
./scripts/config --set-str SYSTEM_TRUSTED_KEYS ""
./scripts/config --set-str SYSTEM_REVOCATION_KEYS ""

# Enable virtio-mmio cmdline devices (needed for Firecracker to register devices)
./scripts/config --enable VIRTIO_MMIO_CMDLINE_DEVICES
./scripts/config --disable BLK_DEV_INTEGRITY

# Enable NFSv3 client support
./scripts/config --enable NFS_V3
./scripts/config --enable NFS_V3_ACL
./scripts/config --enable LOCKD_V4

# Update config
make olddefconfig

echo "Building kernel..."

if [ "$ARCH" == "x86_64" ]; then
  # Use C11 to avoid C23 keyword conflicts with older kernel versions
  make -j$(nproc) vmlinux CC="gcc -std=gnu11"

  echo "Done! Kernel built at: ${KERNEL_DIR}/vmlinux"

  cd ..
  cp "${KERNEL_DIR}/vmlinux" "$TARGET_PATH"

  echo "DONE!"
elif [ "$ARCH" == "aarch64" ]; then
  # ARM64 下 Firecracker 需要 Image 格式，而非 vmlinux
  make -j$(nproc) Image CC="gcc -std=gnu11"

  echo "Done! Kernel built at: ${KERNEL_DIR}/arch/arm64/boot/Image"

  cd ..
  cp "${KERNEL_DIR}/arch/arm64/boot/Image" "$TARGET_PATH"

  echo "DONE!"
fi
