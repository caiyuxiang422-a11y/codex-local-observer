# Third-party notices

This file is included in source distributions and macOS application bundles.
`package-lock.json` and `src-tauri/Cargo.lock` are the authoritative version
inventories. A release maintainer must review this notice whenever either lock
file changes.

## Runtime frameworks

The application uses React and ReactDOM under the MIT License, plus Tauri and
the Tauri JavaScript API under the MIT License or Apache License 2.0. The native
window layer uses `window-vibrancy`, `objc2`, and related Rust crates under their
respective MIT and/or Apache-2.0 terms. Their unmodified source and license files
are available from the versions recorded in the lockfiles:

- [React](https://github.com/facebook/react)
- [Tauri](https://github.com/tauri-apps/tauri)
- [tauri-plugin-vibrancy / window-vibrancy](https://github.com/tauri-apps/tauri-plugin-vibrancy)
- [objc2](https://github.com/madsmtm/objc2)

Tauri's macOS window stack also includes `tao` under Apache-2.0. Binary release
archives must retain this notice and the upstream license information.

## liquid-glass-react 1.1.1

This project bundles the npm package [`liquid-glass-react`](https://github.com/rdev/liquid-glass-react) version `1.1.1` as an optional visual adapter. It is distributed under the MIT License.

Copyright 2025 MAX ROVENSKY

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The package source notes that its shader utility is adapted from
[`shuding/liquid-glass`](https://github.com/shuding/liquid-glass), also under
the MIT License. This application does not copy that repository directly, but
the upstream attribution is retained here for the bundled dependency's
provenance.

## sysinfo 0.39.6

The Rust backend uses [`sysinfo`](https://crates.io/crates/sysinfo) 0.39.6 for
read-only CPU, process, memory, disk, and network counters. The crate is
distributed under the MIT License. The authoritative license text is included
in the crate source as `LICENSE` and the source repository is
[`GuillaumeGomez/sysinfo`](https://github.com/GuillaumeGomez/sysinfo).

## battery 0.7.8

On macOS the backend uses [`battery`](https://crates.io/crates/battery) 0.7.8
to read notebook battery information through the platform adapter. The crate
is dual-licensed under Apache-2.0 OR MIT; the authoritative texts are included
in the crate source as `LICENSE-APACHE` and `LICENSE-MIT`. Source repository:
[`svartalf/rust-battery`](https://github.com/svartalf/rust-battery).

The application only consumes these crates' local sensor APIs. It does not
ship their license files as a replacement for the upstream notices; release
artifacts should retain the corresponding Cargo vendor/registry notices when
vendoring dependencies.

## MPL-2.0 transitive components

The Tauri rendering dependency graph includes the following unmodified
MPL-2.0 crates in the versions locked by `src-tauri/Cargo.lock`:

- `cssparser` and `cssparser-macros`: <https://github.com/servo/rust-cssparser>
- `dtoa-short`: <https://github.com/upsuper/dtoa-short>
- `option-ext`: <https://github.com/soc/option-ext>
- `selectors`: <https://github.com/servo/stylo>

Their source form is available at the linked upstream repositories and on
crates.io. This project does not modify those crates. MPL-2.0 applies to the
covered upstream files, not to this project's independently written MIT code.

## Other transitive licenses

The locked runtime graph also contains permissively licensed components under
MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unicode-3.0, Zlib, CC0, 0BSD,
and compatible dual-license combinations. Keep both lockfiles in source releases
and do not remove upstream copyright/license files when vendoring dependencies.

This notice is a practical distribution inventory, not legal advice. The
tracked `THIRD_PARTY_LICENSES.txt` placeholder keeps public binary automation
blocked until a complete report has been generated from the locked npm and
Cargo dependency graphs and manually reviewed for the matching version.
