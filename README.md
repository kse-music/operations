# ServerDeck

[English](README.md) | [简体中文](README.zh-CN.md)

ServerDeck is a local-first server workbench for developers and operations teams, built with Rust, Tauri 2, Vue 3, and TypeScript. It brings terminals, files, Docker, and AI-assisted operations into a single host workspace over SSH/SFTP, without requiring a cloud account or a remote agent.

## Features

- **Host management**: Nested folders, search, drag and drop, duplication, connection tests, and preview-based import of a supported subset of OpenSSH Config. Passwords and private keys are stored in the system credential store.
- **Terminals**: Local and SSH shells, multiple sessions, split panes, search, keyboard shortcuts, native clipboard support, opening URLs, rz uploads, and dropping files or folders into the current shell directory. Jump hosts and proxies are supported.
- **File management**: Local/remote dual-pane SFTP, directory operations, background transfers, conflict handling, SHA-256 verification, confirmed user switching through sudo, separate text editor windows, and editing with Windows system applications.
- **Docker plugin**: Containers, images, Compose projects, resource and startup configuration, logs, shells, and confirmed start, stop, restart, deletion, and log cleanup operations.
- **AI operations assistant**: Matches registered hosts, collects relevant information with sensitive data redacted, and streams model responses. Preview and execute plans with fixed targets, targeted text edits, and single-file transfers under the selected approval mode, then verify the results.
- **Model and plugin management**: Remote OpenAI-compatible models and local Codex/Claude Code sources; local plugin package installation, permissions, configuration, enabling, disabling, and removal, plus a downloadable standalone development kit.
- **Desktop workspace**: Host tabs, global search, light and dark themes, Chinese and English interfaces, font size and keyboard shortcut settings, data directory migration, and safe shutdown.

See the [product baseline](docs/product/PRD.md) for feature boundaries and the [user guide](docs/guides/USER_GUIDE.md) for instructions.

## Platforms and Versioning

The application version has a single source of truth: `[workspace.package].version` in [Cargo.toml](Cargo.toml). The SDK, plugin packages, and data formats are versioned independently.

Windows x64 is the primary release validation platform. macOS, Linux, and other architectures require separate native validation. The interface supports Simplified Chinese and English. A successful source build does not establish that installers or all platforms have passed release validation; follow the [release checklist](docs/release/RELEASE_CHECKLIST.md) before publishing.

## Quick Start

This repository provides source code. Installers and checksum files are distributed separately through the release process. Read [installation and upgrades](docs/guides/USER_GUIDE.md#安装与升级) before installing.

1. Create a host, enter its address, port, username, and authentication details, test the connection, and save it.
2. On the first connection, verify the SHA-256 host fingerprint through a trusted channel. If the key changes, stop connecting and investigate.
3. Double-click a host to open its workspace and switch between SSH, SFTP, Docker, and the AI assistant.
4. Before using the assistant, configure a model in **Settings → Models**, then save the model binding in the assistant plugin settings.

## Development and Build

Requirements: Rust stable 1.94+, Node.js 22.13+, npm, and the `wasm32-unknown-unknown` target. Windows also requires MSVC C++ Build Tools, the Windows SDK, and WebView2. Other platforms require their corresponding Tauri system dependencies.

```powershell
npm ci
rustup target add wasm32-unknown-unknown
npm run plugins:fetch
npm run tauri -- dev
```

`npm run dev` starts only the browser frontend. Full functionality requires the Tauri/Rust backend.

Desktop development and packaging automatically scan `plugins/system/`, compile each plugin independently, and generate packages and the Rust registry. Plugin builds use locked, offline dependencies. Run `npm run plugins:fetch` before the first build or after plugin dependencies or lockfiles change. Rebuild the client after adding a plugin source directory.

```powershell
# Windows NSIS installer
node tools/tauri.mjs build --bundles nsis
# Debug executable with embedded frontend assets
node tools/tauri.mjs build --debug --no-bundle
```

For a release, change only the Cargo workspace version. The build entry point checks the version source and synchronizes workspace lockfile entries; commit the resulting `Cargo.lock` as well. See the [release checklist](docs/release/RELEASE_CHECKLIST.md) for artifact paths and native validation.

Before building, ensure the output drive has at least 10 GiB of free space. Follow `.cargo/config.toml`: incremental compilation is disabled, and development/test builds use line-table-only debug information. Desktop builds and native tests share the root `target/` directory; WASM caches use `.local/plugin-build/<plugin>/`. Run native QA from a copied EXE to avoid locking build outputs. `.local/` contains data and diagnostic artifacts and must not be deleted wholesale. Before cleaning caches, verify paths, usage, and directory links, and preserve installers and user data.

## Testing

Generate plugins and test fixtures before running Cargo checks that depend on plugin assets:

```powershell
npm run plugins:fetch
npm run plugins:build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm run test:build
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

These commands are entry points for validation, not a claim that checks have passed. Checks involving real SSH connections, system credentials, desktop interactions, and installers require isolated environments and appropriate authorization. See [native validation](docs/release/RELEASE_CHECKLIST.md#原生验收).

## Limitations

- Operations fail explicitly when the system credential store is unavailable, without falling back to plaintext storage. Ed25519/ECDSA and RSA private keys are supported; RSA authentication requires the server to advertise SHA-2 signature support and does not fall back to SHA-1.
- Host keys must be verified. Changes require authorization under the host application's approval rules; privileges are not elevated automatically.
- Failed file transfers restart from the beginning; resuming transfers or recovering them across application restarts is not supported. Desktop text editing is limited to 2 MiB, and assistant text editing to 32 KiB. Atomic replacement does not guarantee preservation of ACLs, extended attributes, or hard links.
- Assistant tasks and conversations are retained only during the current run. Remote operations may already have taken effect after a timeout, disconnection, or cancellation. Verify the actual result rather than automatically replaying changes.
- Automatic updates and cryptographic plugin signature verification are not currently available. File digests do not establish publisher identity.

See the [security notes](docs/release/SECURITY.md) for the full boundaries.

## Documentation and License

The [documentation index](docs/README.md) links to product, usage, architecture, plugin, and release documentation. Development requirements are in [AGENTS.md](AGENTS.md).

This project is licensed under the [MIT License](LICENSE). See the [dependency inventory](docs/release/DEPENDENCY_INVENTORY.md) and [third-party notices](docs/release/THIRD_PARTY_NOTICES.txt) for third-party dependencies and licenses.
