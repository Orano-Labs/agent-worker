#!/usr/bin/env bash
#
# build.sh — cross-compile ptyd as fully static, libc-independent binaries
# for every Unix-like system and 64-bit architecture Go supports. The script
# takes no arguments; output goes to ./dist.
#
# The project is pure Go (no cgo), so CGO_ENABLED=0 produces a self-contained
# binary with no dynamic/libc dependencies. 32-bit targets (e.g. 386, arm)
# are excluded because the xterm-go dependency requires a 64-bit int.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BIN="ptyd"
OUTDIR="dist"
VERSION="$(git describe --tags --always 2>/dev/null || echo dev)"

# Unix-like systems (excludes windows, plan9, js/wasm, android, ios).
UNIX_OS=(aix darwin dragonfly freebsd illumos linux netbsd openbsd solaris)
# 64-bit architectures only.
ARCH64=(amd64 arm64 ppc64 ppc64le riscv64 s390x loong64 mips64 mips64le)

if ! command -v go >/dev/null 2>&1; then
  echo "error: 'go' not found in PATH" >&2
  exit 1
fi

contains() {
  local needle="$1"
  shift
  for w in "$@"; do
    [[ "$w" == "$needle" ]] && return 0
  done
  return 1
}

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

# Enumerate valid GOOS/GOARCH pairs and build each supported (unix, 64-bit) one.
go tool dist list | tr ' ' '\n' | sed '/^$/d' | while IFS=/ read -r os arch; do
  if contains "$os" "${UNIX_OS[@]}" && contains "$arch" "${ARCH64[@]}"; then
    build "$os" "$arch"
  fi
done

echo "done: outputs in $OUTDIR"
