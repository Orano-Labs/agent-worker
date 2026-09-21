#!/bin/sh
#
# build.sh — cross-compile ptyd as fully static, libc-independent binaries
# for linux/amd64 and linux/arm64. The script takes no arguments; output goes
# to ./dist.
#
# The project is pure Go (no cgo), so CGO_ENABLED=0 produces a self-contained
# binary with no dynamic/libc dependencies.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BIN="ptyd"
OUTDIR="dist"
VERSION="$(git describe --tags --always 2>/dev/null || echo dev)"

if ! command -v go >/dev/null 2>&1; then
  echo "error: 'go' not found in PATH" >&2
  exit 1
fi

build() {
  local os="$1" arch="$2"
  local name="${BIN}-${os}-${arch}"

  echo "build ${name}"
  if GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
      -o "$OUTDIR/$name" .; then
    echo "  -> $OUTDIR/$name"
  else
    echo "  !! failed: $name" >&2
  fi
}

mkdir -p "$OUTDIR"

build linux amd64
build linux arm64

echo "done: outputs in $OUTDIR"
