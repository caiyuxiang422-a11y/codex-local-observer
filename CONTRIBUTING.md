# Contributing

Thanks for helping improve Codex Local Observer. This is a local-first desktop
application, so correctness, data provenance, privacy, and predictable macOS
behavior take priority over adding more cards to the interface.

## Before you start

- Search existing issues and architecture decisions in `docs/decisions/`.
- Use an issue to discuss changes that add a data source, persistence format,
  permission, network request, or platform-specific window behavior.
- Never include real prompts, account responses, access tokens, private project
  paths, or proprietary source code in an issue, fixture, screenshot, or test.
- Keep changes focused. Do not silently rewrite unrelated user work.

## Development setup

Requirements are listed in [README.md](README.md). Install with lockfiles:

```bash
npm ci
rustup default stable
source "$HOME/.cargo/env"
```

Run the browser preview with `npm run dev` or the desktop application with
`npm run tauri:dev`. Browser preview results are not evidence that native
process, filesystem, or AppKit behavior works.

The canonical application icon is `src-tauri/icons/app-icon.svg`. After changing
it, regenerate every platform derivative with `npm run icons:generate`, inspect
the macOS, Windows, Android, and iOS outputs, and commit them together. Do not
hand-edit one generated size independently.

## Engineering rules

1. Preserve unknown values. An unavailable token count, approval state, test
   result, or completion percentage must not become zero or “passed”.
2. Keep source, timestamp, confidence, and evidence attached to important
   metrics.
3. Do not read `auth.json`, cookies, or private UI state. Prefer documented
   Codex integration surfaces and degrade safely when fields change.
4. Keep project access user-selected and commands scoped to the canonicalized
   project directory. Do not introduce shell-string concatenation.
5. Do not persist full prompts, reasoning, source text, or unbounded command
   output by default.
6. New stored formats require a version, bounded input, atomic writes, restrictive
   permissions where available, and a migration/rollback plan.
7. Respect reduced motion, increased contrast, reduced transparency, keyboard
   navigation, and both interface languages.
8. Record non-obvious architecture decisions in a focused ADR.

## Verification

Before opening a pull request, run:

```bash
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Native window, camera-safe geometry, drag behavior, transparency, and appearance
changes also need manual validation on real macOS hardware. State what hardware,
macOS version, display arrangement, and accessibility appearance settings were
tested. Do not claim untested platforms work.

## Pull requests

Include:

- the problem and user-visible outcome;
- facts verified in code or tests, separated from estimates and design choices;
- privacy, permission, performance, compatibility, and licensing impact;
- screenshots or a short recording for visual changes, with personal data removed;
- exact commands run and any checks not run;
- a rollback or fallback for risky native/platform work.

By contributing, you agree that your contribution is licensed under the
repository's [MIT License](LICENSE) and that you have the right to submit it.
