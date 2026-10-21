# Changelog

All notable user-facing changes will be documented here. The project follows
[Semantic Versioning](https://semver.org/) after its first public release.

## [Unreleased]

- Add a persistent Simplified Chinese/English interface setting shared by the
  main window, floating views, and camera-safe views.
- Use one canonical logo source for the in-app brand mark, browser icon, and
  generated platform application icons.
- Prepare bilingual documentation, community health files, continuous
  integration, and a guarded macOS release process.
- Seal and verify local macOS application bundles before creating checksummed
  verification archives.

## [0.1.1] - 2026-10-21

### Fixed

- Show each project source as soon as it returns, so slow official token
  requests no longer delay Git, local task, or milestone data.
- Refresh the selected project's data every minute while visible and when
  returning to the main window, without overlapping reads or repeating the
  initial project request.
- Preserve secondary usage windows and their reset times. Summaries show the
  tightest reported window, and detailed views show both windows separately.
- Keep English quota labels and percentages readable in compact views.
- Move keyboard focus into the settings dialog, keep navigation inside it,
  and return focus to its trigger when it closes.
- Keep the floating-view settings save action at the bottom of the window,
  outside the scrolling form.
- Keep an unread task state unknown instead of prematurely displaying Idle.

### Maintenance

- Add regressions for exhausted and unknown secondary quota windows.
- Record the weekly maintenance process and source-release verification scope.

### Distribution

- This is an alpha source update. Existing signing, notarization, and binary
  license gates remain required before publishing an end-user macOS download.

## [0.1.0] - 2026-09-05

- Initial alpha implementation of the local project dashboard.
- Compact, summary, and detailed camera-safe and floating views.
- Source-labelled Codex usage, milestone progress, task, Git, and local system
  metrics with explicit unavailable states.
