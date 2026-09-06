#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_DIR/release"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS packaging must run on macOS." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

for command_name in npm node cargo ditto shasum codesign lipo spctl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

cd "$PROJECT_DIR"

if [[ "${SKIP_CHECKS:-0}" != "1" ]]; then
  npm ci
  npm run check
  cargo fmt --manifest-path src-tauri/Cargo.toml --check
  cargo test --locked --manifest-path src-tauri/Cargo.toml
  cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
fi

VERSION="$(node -p 'require("./package.json").version')"
TAURI_TARGET="${TAURI_BUILD_TARGET:-}"
LICENSE_REVIEW_STATE="incomplete"
if grep -Fxq "Review-Status: complete" "$PROJECT_DIR/THIRD_PARTY_LICENSES.txt" && \
  grep -Fxq "Reviewed-For-Version: $VERSION" "$PROJECT_DIR/THIRD_PARTY_LICENSES.txt"; then
  LICENSE_REVIEW_STATE="complete"
fi

# Rust panic locations otherwise retain the local username and checkout path in
# release binaries. Encoded flags preserve spaces in checkout directory names.
FLAG_SEPARATOR=$'\x1f'
PATH_REMAP_FLAGS="--remap-path-prefix=$PROJECT_DIR=.${FLAG_SEPARATOR}--remap-path-prefix=$HOME=~"
if [[ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]]; then
  export CARGO_ENCODED_RUSTFLAGS="${CARGO_ENCODED_RUSTFLAGS}${FLAG_SEPARATOR}${PATH_REMAP_FLAGS}"
else
  export CARGO_ENCODED_RUSTFLAGS="$PATH_REMAP_FLAGS"
fi

TAURI_ARGUMENTS=(build --bundles app)
if [[ -n "$TAURI_TARGET" ]]; then
  TAURI_ARGUMENTS+=(--target "$TAURI_TARGET")
  BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/$TAURI_TARGET/release/bundle/macos"
else
  BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/release/bundle/macos"
fi

npm run tauri -- "${TAURI_ARGUMENTS[@]}"

APP_PATH="$BUNDLE_DIR/Codex 本地观察台.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Expected app bundle was not produced: $APP_PATH" >&2
  exit 1
fi

for notice in LICENSE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt; do
  if [[ ! -f "$APP_PATH/Contents/Resources/$notice" ]]; then
    echo "Release bundle is missing $notice." >&2
    exit 1
  fi
done

# A normal unsigned local Tauri build only carries the Mach-O linker's ad-hoc
# signature. That is not a valid signature for the completed .app bundle once
# Info.plist, icons, and bundled notices are present. Seal the whole bundle for
# local verification. Developer ID builds are signed/notarized by Tauri and
# must pass verification as-is; silently replacing that identity with an
# ad-hoc signature would make a broken release look healthy.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  codesign --force --deep --sign - "$APP_PATH"
fi

if ! codesign --verify --deep --strict "$APP_PATH"; then
  echo "The completed app bundle has an invalid code signature." >&2
  exit 1
fi

ARCHITECTURES="$(lipo -archs "$APP_PATH/Contents/MacOS/codex-local-observer")"
case "$ARCHITECTURES" in
  "arm64") ARCH_LABEL="arm64" ;;
  "x86_64") ARCH_LABEL="x64" ;;
  *"arm64"*"x86_64"* | *"x86_64"*"arm64"*) ARCH_LABEL="universal" ;;
  *) ARCH_LABEL="unknown-arch" ;;
esac

SIGNATURE_DETAILS="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 || true)"
if grep -q "Signature=adhoc" <<<"$SIGNATURE_DETAILS"; then
  SIGNATURE_STATE="ad-hoc"
elif grep -q "Authority=Developer ID Application" <<<"$SIGNATURE_DETAILS"; then
  SIGNATURE_STATE="developer-id"
else
  SIGNATURE_STATE="signed-with-unrecognized-identity"
fi

NOTARIZATION_STATE="not-notarized"
if command -v xcrun >/dev/null 2>&1 && xcrun stapler validate "$APP_PATH" >/dev/null 2>&1; then
  NOTARIZATION_STATE="notarized"
fi

TRUST_LABEL="unnotarized"
PUBLIC_DISTRIBUTION_READY="no"
if [[ "$SIGNATURE_STATE" == "developer-id" && "$NOTARIZATION_STATE" == "notarized" ]] && \
  spctl --assess --type execute "$APP_PATH" >/dev/null 2>&1; then
  if [[ "$LICENSE_REVIEW_STATE" == "complete" ]]; then
    TRUST_LABEL="notarized"
    PUBLIC_DISTRIBUTION_READY="yes"
  else
    TRUST_LABEL="notarized-license-review-required"
  fi
fi

mkdir -p "$OUTPUT_DIR"
BASE_NAME="Codex-Local-Observer-v${VERSION}-macos-${ARCH_LABEL}-${TRUST_LABEL}"
ARCHIVE_PATH="$OUTPUT_DIR/${BASE_NAME}.app.zip"
METADATA_PATH="$OUTPUT_DIR/${BASE_NAME}.metadata.txt"

rm -f "$ARCHIVE_PATH" "$ARCHIVE_PATH.sha256" "$METADATA_PATH"

if SOURCE_COMMIT="$(git rev-parse --verify HEAD 2>/dev/null)"; then
  :
else
  SOURCE_COMMIT="uncommitted"
fi

ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ARCHIVE_PATH"
(
  cd "$OUTPUT_DIR"
  shasum -a 256 "$(basename "$ARCHIVE_PATH")" >"$(basename "$ARCHIVE_PATH").sha256"
)
cp "$PROJECT_DIR/LICENSE" "$OUTPUT_DIR/LICENSE"
cp "$PROJECT_DIR/THIRD_PARTY_NOTICES.md" "$OUTPUT_DIR/THIRD_PARTY_NOTICES.md"
cp "$PROJECT_DIR/THIRD_PARTY_LICENSES.txt" "$OUTPUT_DIR/THIRD_PARTY_LICENSES.txt"

{
  echo "Version: $VERSION"
  echo "Architectures: $ARCHITECTURES"
  echo "Signature: $SIGNATURE_STATE"
  echo "Notarization: $NOTARIZATION_STATE"
  echo "Binary license inventory: $LICENSE_REVIEW_STATE"
  echo "Public distribution ready: $PUBLIC_DISTRIBUTION_READY"
  echo "Source commit: $SOURCE_COMMIT"
} >"$METADATA_PATH"

echo "Created $ARCHIVE_PATH"
echo "Created $ARCHIVE_PATH.sha256"
echo "Created $METADATA_PATH"
if [[ "$PUBLIC_DISTRIBUTION_READY" != "yes" ]]; then
  echo "WARNING: This build is not a trusted end-user release." >&2
fi
