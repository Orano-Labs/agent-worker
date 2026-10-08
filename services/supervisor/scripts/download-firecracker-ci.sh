#!/usr/bin/env bash

set -euo pipefail

S3="https://s3.amazonaws.com/spec.ccfc.min"
RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
DOWNLOAD_DIR="${1:-$(pwd)/firecracker-ci-artifacts}"

ARCH=$(uname -m)

echo "Target Architecture: ${ARCH}"

mkdir -p "$DOWNLOAD_DIR"

FIRECRACKER_LATEST=$(
  basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASE_URL}/latest")"
)

echo "Firecracker release: ${FIRECRACKER_LATEST}"

echo "${FIRECRACKER_LATEST}" > "${DOWNLOAD_DIR}/firecracker.version"

RELEASE_DIR="release-${FIRECRACKER_LATEST}-${ARCH}"
RELEASE_ARCHIVE="firecracker-${FIRECRACKER_LATEST}-${ARCH}.tgz"

curl -fsSL "${RELEASE_URL}/download/${FIRECRACKER_LATEST}/${RELEASE_ARCHIVE}" | tar -xz -C "$DOWNLOAD_DIR"

mv \
  "${DOWNLOAD_DIR}/${RELEASE_DIR}/firecracker-${FIRECRACKER_LATEST}-${ARCH}" \
  "${DOWNLOAD_DIR}/firecracker"

mv \
  "${DOWNLOAD_DIR}/${RELEASE_DIR}/jailer-${FIRECRACKER_LATEST}-${ARCH}" \
  "${DOWNLOAD_DIR}/jailer"

mv \
  "${DOWNLOAD_DIR}/${RELEASE_DIR}/seccompiler-bin-${FIRECRACKER_LATEST}-${ARCH}" \
  "${DOWNLOAD_DIR}/seccompiler-bin"

rm -rf "${DOWNLOAD_DIR:?}/${RELEASE_DIR}"

# Latest CI artifact

CI_ARTIFACTS_PREFIX=$(
  curl -fsSL \
    "${S3}?list-type=2&prefix=firecracker-ci/&delimiter=/" |
  grep -oP \
    '(?<=<Prefix>)firecracker-ci/[0-9]{8}-[^/]+/(?=</Prefix>)' |
  sort |
  tail -1
)

echo "CI artifacts: ${CI_ARTIFACTS_PREFIX}"

# Kernel

latest_kernel_key=$(
  curl -fsSL \
    "${S3}?list-type=2&prefix=${CI_ARTIFACTS_PREFIX}${ARCH}/vmlinux-" |
  grep -oP \
    "(?<=<Key>)(${CI_ARTIFACTS_PREFIX}${ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" |
  sort -V |
  tail -1
)

KERNEL_VERSION=$(basename "$latest_kernel_key" | sed 's/^vmlinux-//')

echo "Kernel: ${KERNEL_VERSION}"

wget \
    -q \
    -O "${DOWNLOAD_DIR}/vmlinux" \
    "${S3}/${latest_kernel_key}"

echo "${KERNEL_VERSION}" > "${DOWNLOAD_DIR}/vmlinux.version"
