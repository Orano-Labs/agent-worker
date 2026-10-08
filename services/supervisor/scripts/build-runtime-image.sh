#!/usr/bin/env bash

# build-runtime-image.sh — build the read-only runtime.squashfs root image
# that is booted inside each Firecracker microVM.
#
# Building the image is a build-time concern, and
# should happen independently of the runtime (the Supervisor only verifies
# the artifact and copies it into the jail root at boot).
#
# The buildah operations run in rootless mode (buildah unshare) so the script
# does not need root privileges. This requires the vfs storage driver.
#
# Usage:
#   build-runtime-image.sh [OUTPUT]         # default: ./runtime.squashfs
#
# Environment:
#   ALPINE_MIRROR_MAIN             apk main repository URL
#
# Requires: buildah, mksquashfs (squashfs-tools), bash, curl, npm/node.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve the supervisor service root relative to this script (scripts/..).
SERVICE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RESOURCES_DIR="${SERVICE_DIR}/resources"
ALPINE_MIRROR_MAIN="https://mirrors.nju.edu.cn/alpine/latest-stable/main/"

TARGET_PATH="${1:-${SERVICE_DIR}/runtime.squashfs}"

ARCH="$(uname -m)"

case "${ARCH}" in
  x86_64) PTYD_BINARY="${PTYD_BINARY:-ptyd-linux-amd64}" ;;
  aarch64) PTYD_BINARY="${PTYD_BINARY:-ptyd-linux-arm64}" ;;
  *)
    echo "error: unsupported architecture: ${ARCH}" >&2
    exit 1
    ;;
esac

if [[ -n "${PTYD_SOURCE:-}" ]]; then
  PTYD_PATH="${PTYD_SOURCE}"
else
  if ! pnpm --filter @aw/ptyd build; then
    echo "error: failed to build @aw/ptyd" >&2
    exit 1
  fi

  PTYD_RESOLVED="$(node -e "try { console.log(require.resolve('@aw/ptyd')) } catch { process.exit(1) }" 2>/dev/null || true)"

  if [[ -n "${PTYD_RESOLVED}" ]]; then
    PTYD_PATH="$(cd "$(dirname "${PTYD_RESOLVED}")" && pwd)/${PTYD_BINARY}"
  else
    echo "error: unable to resolve @aw/ptyd." >&2
    exit 1
  fi
fi

if [[ ! -f "${PTYD_PATH}" ]]; then
  echo "error: ptyd binary not found at ${PTYD_PATH}" >&2
  exit 1
fi

for f in "init.sh" "entrypoint.sh"; do
  if [[ ! -f "${RESOURCES_DIR}/${f}" ]]; then
    echo "error: required resource missing: ${RESOURCES_DIR}/${f}" >&2
    exit 1
  fi
done

if ! command -v buildah >/dev/null 2>&1; then
  echo "error: 'buildah' not found in PATH" >&2
  exit 1
fi

if ! command -v mksquashfs >/dev/null 2>&1; then
  echo "error: 'mksquashfs' (squashfs-tools) not found in PATH" >&2
  exit 1
fi

echo "Target image: ${TARGET_PATH}"
echo "Architecture: ${ARCH} (ptyd: ${PTYD_BINARY})"

mkdir -p "$(dirname "${TARGET_PATH}")"

CONTAINER=""

cleanup() {
  if [[ -n "${CONTAINER}" ]]; then
    echo "Cleaning up buildah container [${CONTAINER}]..."
    buildah rm "${CONTAINER}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

echo "Pulling alpine base image via buildah..."

CONTAINER="$(buildah from alpine:latest | tr -d '[:space:]')"

echo "Installing packages (mirror: ${ALPINE_MIRROR_MAIN})..."

# tini (PID 1)
# libcap-utils (capsh for capability dropping)
# nodejs/npm
# curl
# bash (shell)
# fd/ripgrep (pi agent deps)
# git (source control / agent workflows)
# jq (JSON processing)
# less (paging / log inspection)
# procps (ps/top/process inspection)
# iproute2 (network/process diagnostics)
# ca-certificates (HTTPS/TLS)
# tzdata (timezone handling)
DEPS=(
  tini
  libcap-utils
  nodejs
  npm
  curl
  bash
  fd
  ripgrep
  git
  jq
  less
  procps
  iproute2
  ca-certificates
  tzdata
)

buildah run --net=host "${CONTAINER}" -- apk update --repository="${ALPINE_MIRROR_MAIN}"
buildah run --net=host "${CONTAINER}" -- apk add ca-certificates --repository="${ALPINE_MIRROR_MAIN}"
buildah run --net=host "${CONTAINER}" -- apk add "${DEPS[@]}" --repository="${ALPINE_MIRROR_MAIN}"
buildah run --net=host "${CONTAINER}" -- node -v
buildah run --net=host "${CONTAINER}" -- npm -v

buildah run --net=host "${CONTAINER}" -- npm install -g --ignore-scripts @earendil-works/pi-coding-agent

echo "Staging init/entrypoint/ptyd into container..."

buildah copy "${CONTAINER}" "${RESOURCES_DIR}/init.sh" /init
buildah copy "${CONTAINER}" "${RESOURCES_DIR}/entrypoint.sh" /entrypoint
buildah copy "${CONTAINER}" "${PTYD_PATH}" /usr/local/bin/ptyd

buildah run --net=host "${CONTAINER}" -- chmod +x /init
buildah run --net=host "${CONTAINER}" -- chmod +x /entrypoint
buildah run --net=host "${CONTAINER}" -- chmod +x /usr/local/bin/ptyd
buildah run --net=host "${CONTAINER}" -- mkdir -p /workspace

echo "Mounting container rootfs (rootless via buildah unshare) and building squashfs..."

# buildah unshare enters a user namespace so `buildah mount` + mksquashfs work
# without root. The mount, squashfs pack, and unmount must all happen inside the
# same user namespace.
buildah unshare bash -c '
  set -euo pipefail

  container="$1"
  target="$2"

  mountpoint="$(buildah mount "${container}" | tr -d "[:space:]")"

  mksquashfs "${mountpoint}" "${target}" -comp xz -noappend

  buildah unmount "${container}"
' bash "${CONTAINER}" "${TARGET_PATH}"

buildah rm "${CONTAINER}"

echo "Done! Runtime image built at: ${TARGET_PATH}"
