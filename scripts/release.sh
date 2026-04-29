#!/usr/bin/env bash
# Build all release artifacts for the current package.json version.
#
# Outputs (under release/<version>/):
#   - dash0-lambda-cli-<version>.tgz             (npm tarball; needs Node 20+)
#   - dash0-lambda-<version>-darwin-arm64        (Bun binary; mac Apple silicon)
#   - dash0-lambda-<version>-darwin-x64          (Bun binary; mac Intel)
#   - dash0-lambda-<version>-linux-x64           (Bun binary; standard Linux)
#   - dash0-lambda-<version>-linux-arm64         (Bun binary; ARM Linux / Graviton)
#   - SHASUMS256.txt                              (sha256 of every file above)
#
# The Bun binaries embed the runtime — customers don't need Node installed.
# The npm tarball is for customers who already have Node and prefer
# `npm install -g <tarball>`.
#
# Usage:
#   scripts/release.sh
#
# Pre-reqs:
#   - bun 1.3+ on PATH (or at ~/.bun/bin/bun)
#   - npm 9+
#   - the working tree should be clean — set ALLOW_DIRTY=1 to bypass
#
# Notes:
#   - Bun cross-compiles natively, so a single Mac can produce all four
#     binary variants. No Docker, no CI matrix needed.
#   - npm pack runs the prepack hook, which builds + tests. So a release
#     can never ship stale dist or failing tests.
#   - We don't sign or notarize the Mac binaries here. For App Store /
#     gatekeeper-friendly distribution, that's a separate Apple Developer
#     workflow. Without it, customers see a "downloaded from internet"
#     warning on first run and must right-click → Open once.

set -euo pipefail

# ── Pre-flight ────────────────────────────────────────────────────────

# Find Bun. CI environments often have it on PATH; locally it usually
# lives under ~/.bun/bin/bun unless the user re-shelled.
if command -v bun >/dev/null 2>&1; then
  BUN=bun
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "✘ bun not found. Install with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "✘ npm not found"
  exit 1
fi

# Refuse to build from a dirty tree unless explicitly bypassed. Catches
# the common mistake of releasing un-committed local edits.
if [[ -z "${ALLOW_DIRTY:-}" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "✘ working tree is dirty. Commit or set ALLOW_DIRTY=1." >&2
    git status -s >&2
    exit 1
  fi
fi

VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")

# Reject pre-release versions accidentally getting tagged. CI can override.
if [[ "${VERSION}" == *-* && -z "${ALLOW_PRERELEASE:-}" ]]; then
  echo "✘ version '${VERSION}' looks like a pre-release. Bump to a real semver, or set ALLOW_PRERELEASE=1." >&2
  exit 1
fi

OUTDIR="release/${VERSION}"
rm -rf "${OUTDIR}"
mkdir -p "${OUTDIR}"

echo "▶ Building ${NAME}@${VERSION} into ${OUTDIR}/"

# ── 1. npm tarball (runs prepack: build + test) ──────────────────────

echo ""
echo "── npm pack ─────────────────────────────────────────"
npm pack --pack-destination "${OUTDIR}"

# ── 2. Bun binaries, four targets ────────────────────────────────────

# Each target: (filename-suffix, bun-target). Filename uses the
# canonical "<name>-<os>-<arch>" suffix so customers can `uname` and
# pick the right one without thinking.
TARGETS=(
  "darwin-arm64:bun-darwin-arm64"
  "darwin-x64:bun-darwin-x64"
  "linux-x64:bun-linux-x64"
  "linux-arm64:bun-linux-arm64"
)

for entry in "${TARGETS[@]}"; do
  suffix="${entry%%:*}"
  target="${entry##*:}"
  out="${OUTDIR}/dash0-lambda-${VERSION}-${suffix}"
  echo ""
  echo "── bun build (${target}) ────────────────────────────"
  "${BUN}" build src/cli.ts \
    --compile \
    --target="${target}" \
    --outfile "${out}"
  chmod +x "${out}"
  ls -lh "${out}"
done

# ── 3. Checksums ─────────────────────────────────────────────────────

echo ""
echo "── checksums ────────────────────────────────────────"
(
  cd "${OUTDIR}"
  # shasum: present on macOS by default, on most Linux distros.
  shasum -a 256 -- * | tee SHASUMS256.txt
)

# ── 4. Summary ───────────────────────────────────────────────────────

echo ""
echo "✔ Release artifacts in ${OUTDIR}/"
ls -lh "${OUTDIR}"
echo ""
echo "Next steps:"
echo "  - Smoke-test at least one binary on the matching platform."
echo "  - Tag the release: git tag v${VERSION} && git push --tags"
echo "  - Upload to GitHub Releases (or your distribution channel)."
