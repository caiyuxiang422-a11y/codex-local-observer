# Security Policy

## Supported versions

The project is pre-1.0 alpha software. Security fixes are applied to the latest
commit on the default branch. Older commits and locally modified builds are not
maintained as supported releases.

No downloadable macOS build should be considered a trusted public release
unless its GitHub release notes identify it as Developer ID signed and notarized
and its checksum matches the published SHA-256 file.

## Reporting a vulnerability

Do **not** disclose an exploitable vulnerability in a public issue, discussion,
pull request, screenshot, or log.

Use the repository's **Security → Report a vulnerability** private advisory
form. Include a minimal reproduction, affected commit/version, impact, and any
suggested mitigation. Remove credentials, prompts, private source code, and
personal paths. If private advisories are unavailable, open a public issue that
only asks maintainers to enable a private reporting channel; do not include the
vulnerability details.

Maintainers should acknowledge a complete report within seven days. This is a
target, not a guaranteed service-level agreement. Publication timing is agreed
with the reporter after a fix or practical mitigation is available.

## Security boundaries

- The application launches a locally installed Codex executable and can run a
  selected repository's declared test/build scripts after explicit user action.
  A malicious executable or repository script is outside the app's trust boundary.
- The default Codex task is read-only and ephemeral, but that does not sandbox
  commands a project script itself performs.
- Project paths and bounded task metadata are local personal data. They must not
  be attached to reports without redaction.
- Account data is requested through the local Codex App Server. The app must not
  read or export login credential files.
- The camera-safe overlay is a normal application window. It is not a secure
  display surface and must not be used to show secrets over untrusted screen
  sharing or recording software.
- `macOSPrivateApi` is used for transparent WKWebView composition. This affects
  distribution compatibility and does not grant access to the physical camera.

High-priority reports include command/path injection, unintended writes outside
the selected project, credential exposure, persistent sensitive prompt/source
storage, unsafe update or release behavior, and remote content gaining access to
Tauri commands.

