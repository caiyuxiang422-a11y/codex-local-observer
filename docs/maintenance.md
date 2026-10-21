# Maintenance

Maintenance prioritises data accuracy, Codex protocol compatibility, UI
legibility, predictable window behaviour, and privacy. Each weekly update
should deliver a small, reviewable improvement and add a dated entry to
`CHANGELOG.md`. If no defect is established, address a genuine gap in tests or
documentation. Do not create empty commits or cosmetic churn to meet a quota.

The owner has scheduled a weekly maintenance task in Codex for Monday at
10:00. This schedule belongs to the owner's desktop task, not this repository;
contributors are not automatically enrolled and GitHub Actions does not run
an autonomous agent from this file.

Before changing code, inspect the working tree, fetch the latest remote state,
and preserve unrelated work. Verify the relevant frontend, Rust, and visual
behaviour using `CONTRIBUTING.md`. Update the changelog, commit only reviewed
files, then push or open a pull request according to branch protection.

Report the concrete change, verification results, and the published commit or
pull request. Distinguish tests from hardware validation: a browser screenshot
does not verify AppKit materials, camera occlusion, multiple displays, or
native window levels. Document remaining limitations rather than claiming
untested platforms work.

Source updates and public app binaries are separate deliverables. Follow
`RELEASE.md` for versioning, licensing, signing, notarization, and publication.
Do not bypass a failed gate or publish a diagnostic artifact as an installer.
