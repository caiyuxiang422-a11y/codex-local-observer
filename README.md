# Codex Local Observer

[简体中文](README.zh-CN.md)

An unofficial, local-first macOS dashboard for observing Codex work without
turning unknown data into made-up numbers.

> [!IMPORTANT]
> This project is independent and is not affiliated with, endorsed by, or an
> official client of OpenAI. “Codex” and related product names belong to their
> respective owners.

The project is currently **alpha software**. The source is suitable for review
and local development. A public macOS binary should only be offered after it
has been Developer ID signed and notarized; an ad-hoc or unsigned build is not
an end-user release.

## What it shows

- The selected project's Git state, user-defined milestone progress, running
  and failed observer tasks, and recent changes.
- Project and account usage only when the local Codex integration actually
  returns it. Missing historical token data remains “unavailable”, never zero.
- Official rate-limit window percentages, reset times, credits, and plan data
  when exposed by the local App Server.
- Read-only CPU, memory, storage, network, and battery context useful while
  coding.
- Compact, summary, and detailed views, either attached to the macOS camera
  safe area or placed as a draggable floating window.
- User-selected metrics and Chinese/English interface preferences.

The camera-safe presentation is an application window positioned with public
AppKit screen geometry. It cannot control or replace the physical camera area.

## Data honesty

| Value | Meaning |
| --- | --- |
| Project tokens | Usage reported for matching project threads, or locally observed task usage. The two scopes are not added together. |
| Account activity | Token activity returned by the account endpoint; it is not a quota. |
| Usage remaining | An official window percentage or credits balance when available. It cannot be converted into an absolute number of tokens. |
| Project completion | A weighted calculation from milestones the user defines. It is not inferred from token count, file count, or commits. |
| Running/failed tasks | Tasks started or recorded by this observer, not every task running in other Codex clients. |
| Pending approvals | Unknown until a supported approval event integration is available. |

Every important snapshot carries its source, update time, confidence, and
evidence where practical. See the [architecture decisions](docs/decisions/) for
the detailed contracts and known compromises.

## Privacy and security

- Project access is limited to directories explicitly selected by the user.
- The app does not read `~/.codex/auth.json`, browser cookies, or another app's
  private storage.
- Prompts are sent to the child process over stdin and are not saved by default.
- Full prompts, reasoning, source files, and full command output are not kept in
  the local task history.
- The default Codex task runs with a read-only, ephemeral sandbox.
- Test and build scripts run only after an explicit action. Treat them as code
  from the selected repository: they can write files or access the network.
- Local preferences, milestones, workspace registrations, and bounded task
  metadata are stored in the Tauri application-data directory.
- There is no application telemetry or cloud sync in the current implementation.

Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Requirements

- macOS 11 or later. Apple silicon is the currently tested development target;
  Intel and universal release builds require separate verification.
- Node.js 20.19 or later and npm.
- A stable Rust toolchain and Xcode Command Line Tools.
- Git and a locally available Codex CLI for live Codex data.

Tauri's platform prerequisites are documented at
[v2.tauri.app/start/prerequisites](https://v2.tauri.app/start/prerequisites/).

## Run locally

```bash
npm ci
npm run dev
```

The browser preview cannot access local projects or start Codex. It clearly
reports that the desktop backend is unavailable.

Desktop development:

```bash
rustup default stable
source "$HOME/.cargo/env"
npm run tauri:dev
```

If the app cannot discover Codex, provide its executable explicitly:

```bash
export CODEX_MONITOR_CODEX_BIN=/path/to/codex
npm run tauri:dev
```

`CODEX_MONITOR_PROJECT_DIR` may be used as a development default. Packaged
release builds do not probe the directory in which they were compiled.

## Verify a change

```bash
npm run check

cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The repository contains frontend model tests and Rust tests for event parsing,
path validation, bounded persistence, redaction, process outcomes, project
progress, usage normalization, and platform fallbacks. Hardware camera-area
geometry and visual material still require real-device testing.

## Package and release

For a local macOS verification archive:

```bash
npm run package:macos
```

This writes an app zip, SHA-256 checksum, build metadata, and notices to
`release/`. Without an Apple Developer ID and notarization credentials, the
result is deliberately labelled unnotarized and must not be described as a
ready-to-install public download.

The complete maintainer checklist, bundle-identifier decision, optional Apple
secrets, and GitHub release behavior are documented in [RELEASE.md](RELEASE.md).

## Project structure

```text
src/                    React UI, view models, and frontend tests
src-tauri/src/          Rust adapters, process control, storage, and AppKit bridge
src-tauri/capabilities/ Tauri window capability policy
docs/decisions/         Architecture decision records
.github/workflows/      Continuous integration and guarded macOS release workflow
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). New integrations must preserve the
project's local-first, least-privilege, source-labelled data model.

## License

Project code is licensed under the [MIT License](LICENSE). Bundled dependency
attributions and source links are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
