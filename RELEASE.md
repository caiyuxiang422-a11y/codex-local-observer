# Release guide

This document separates two different outcomes:

1. **Open source publication** makes the reviewed source and lockfiles public.
2. **End-user distribution** additionally requires a correctly identified,
   signed, notarized, tested macOS binary.

Publishing source does not make a locally ad-hoc-signed `.app` a trusted release.

## One-time repository decisions

- Choose the final GitHub user or organization before the first public binary.
- Replace the placeholder bundle identifier `io.github.codex-local-observer` in
  `src-tauri/tauri.conf.json` with a stable reverse-DNS identifier owned by that
  GitHub user/organization. Do this before users accumulate application data and
  macOS privacy permissions: changing it later changes the app's identity.
- Enable GitHub private vulnerability reporting and review `SECURITY.md`.
- Configure branch protection so the CI workflow must pass before merging.
- Decide whether the supported artifact is Apple silicon only, Intel only, or a
  universal binary. The release workflow builds universal by default, but both
  architectures still require real-device validation.

## Version checklist

Keep these versions identical:

- `package.json` → `version`
- `src-tauri/Cargo.toml` → `package.version`
- `src-tauri/tauri.conf.json` → `version`
- the Git tag, prefixed with `v`

Update `CHANGELOG.md`, verify both README files, review all changed dependencies,
and confirm that `THIRD_PARTY_NOTICES.md` still covers bundled code.

Generate and manually review the complete binary dependency license inventory
from the exact npm and Cargo lockfiles. Replace the placeholder
`THIRD_PARTY_LICENSES.txt`, include every required license text and copyright
notice, then set `Review-Status: complete` and `Reviewed-For-Version: <version>`.
The packaging script will not mark a binary as publicly distributable unless
both headers match the package version.

`src-tauri/icons/app-icon.svg` is the canonical logo source. If it changed, run
`npm run icons:generate`, visually inspect the generated platform assets, and
confirm that all generated files are committed before packaging.

## Required verification

```bash
npm ci
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Also test compact, summary, and detailed views on real macOS hardware, including
reduced transparency, increased contrast, reduced motion, multiple displays,
camera-safe and no-camera-safe displays, direct floating-window drag, and both
languages.

## Local verification package

```bash
npm run package:macos
```

The script builds the app, checks that license notices are embedded, removes the
local workspace/home prefix from Rust source paths, and writes these files under
the ignored `release/` directory:

- `*.app.zip`
- `*.app.zip.sha256`
- `*.metadata.txt`
- `LICENSE`
- `THIRD_PARTY_NOTICES.md`
- `THIRD_PARTY_LICENSES.txt`

If Apple signing and notarization are unavailable, metadata says so and the file
name includes `unnotarized`. Such a package is useful for internal verification,
not as a public “double-click to install” download.

## Apple signing and notarization

The tag workflow accepts these GitHub Actions secrets:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`: password for that `.p12`
- `APPLE_SIGNING_IDENTITY`: exact Developer ID Application identity
- `APPLE_ID`: notarization Apple ID
- `APPLE_PASSWORD`: app-specific password
- `APPLE_TEAM_ID`: Apple Developer team ID

The workflow imports the certificate into an ephemeral keychain. Tauri uses the
identity for signing and the Apple account variables for notarization. Secrets
are optional for ordinary CI and source development, but all six are required
for the workflow to publish a binary GitHub Release.

When credentials are missing, signing fails, notarization fails, Gatekeeper
rejects the app, or the binary license inventory is incomplete, the workflow
stops before creating a GitHub Release. If packaging output already exists, it
uploads an Actions-only diagnostic artifact named
`UNTRUSTED-NOT-FOR-END-USERS`. Never rename that artifact to imply it is trusted.

The app currently enables `macOSPrivateApi` for transparent WKWebView
composition. Apple notarization behavior and App Store policy are separate. If
notarization rejects the build, do not bypass it; either remove the private API
path and verify the visual fallback or distribute source only while the native
host is redesigned.

## Tag release

After the default branch is clean and CI is green:

```bash
git tag -s v0.1.0 -m "Codex Local Observer 0.1.0"
git push origin v0.1.0
```

Use an annotated tag if signed Git tags are not yet configured. The release
workflow verifies the tag/version match, builds a universal app, validates the
signature, notarization ticket, and Gatekeeper assessment, then creates the
GitHub Release with checksums and notices.

Create a protected GitHub Environment named `release` and require maintainer
approval for it. The workflow also rejects a release tag whose commit is not
contained in the repository's default branch.

## Current non-goals

- There is no automatic updater. A release must not claim otherwise.
- The app is not an official OpenAI product.
- App Store distribution is not currently supported.
- A percentage-based usage window is not an absolute token balance.
