# ServerDeck

[English](README.md) | [简体中文](README.zh-CN.md)

ServerDeck is a local-first server workbench for developers and operations teams, built with Rust, Tauri 2, Vue 3, and TypeScript. It brings terminals, files, Docker, and AI-assisted operations into a single host workspace over SSH/SFTP, without requiring a cloud account or a remote agent.

## Features

- **Host management**: Nested folders, search, drag and drop, duplication, connection tests, and preview-based import of a supported subset of OpenSSH Config. Passwords and private keys are stored in the system credential store.
- **Terminals**: Local and SSH shells, multiple sessions, split panes, search, keyboard shortcuts, native clipboard support, opening URLs, rz uploads, and dropping files or folders into the current shell directory. Jump hosts and proxies are supported.
- **File management**: Local/remote dual-pane SFTP, directory operations, background transfers, conflict handling, SHA-256 verification, confirmed user switching through sudo, separate text editor windows, and editing with Windows system applications.
- **Docker plugin**: Containers, images, Compose projects, read-only startup configuration and environment variables, logs, shells, confirmed container operations, and image import/export/remote transfer.
- **AI operations assistant**: Matches registered hosts, collects relevant information with sensitive data redacted, and streams model responses. Preview and execute plans with fixed targets, targeted text edits, and single-file transfers under the selected approval mode, then verify the results.
- **Model and plugin management**: Remote OpenAI-compatible models and local Codex/Claude Code sources; local plugin package installation, permissions, configuration, enabling, disabling, and removal, plus a downloadable standalone development kit.
- **Desktop workspace**: Host tabs, global search, light and dark themes, Chinese and English interfaces, font size and keyboard shortcut settings, data directory migration, and safe shutdown.

See the [product baseline](docs/product/PRD.md) for feature boundaries and the [user guide](https://ops.hiboot.cn/docs/) for instructions.

## Platforms and Versioning

The application version has a single source of truth: `[workspace.package].version` in [Cargo.toml](Cargo.toml). The SDK, plugin packages, and data formats are versioned independently.

Windows x64 is the primary release validation platform. macOS, Linux, and other architectures require separate native validation. The interface supports Simplified Chinese and English. A successful source build does not establish that installers or all platforms have passed release validation; follow the [release checklist](docs/release/RELEASE_CHECKLIST.md) before publishing.

## Getting Started

See the official [installation guide](https://ops.hiboot.cn/docs/installation.html) and [first connection tutorial](https://ops.hiboot.cn/docs/quickstart.html). Plugin authors can start in the [developer center](https://ops.hiboot.cn/developers/).

## Development and Build

Requirements: Rust stable 1.94+, Node.js 22.13+, npm, and the `wasm32-unknown-unknown` target. Windows also needs MSVC C++ Build Tools, the Windows SDK, and WebView2.

```powershell
npm ci
rustup target add wasm32-unknown-unknown
npm run plugins:fetch
npm run tauri -- dev
```

`npm run dev` starts the browser frontend only. Full functionality requires the Tauri/Rust backend. Bundled plugins are compiled independently with locked, offline dependencies; fetch them before the first build or after lockfile changes.

See [development and validation](docs/guides/DEVELOPMENT.md) for build commands, shared Cargo output, disk requirements, and plugin development kit verification. The application version comes from the Cargo workspace; SDK and plugin versions are independent.

## Testing

Use the [local checks](docs/guides/DEVELOPMENT.md#本地检查) and [native validation](docs/release/NATIVE_VALIDATION.md) appropriate to the change. Native tests run from copied executables in isolated QA directories. Real remote changes require an authorized test environment. These instructions do not claim that the current candidate has passed release checks.

## Limitations

- Operations fail explicitly when the system credential store is unavailable, without falling back to plaintext storage. Ed25519/ECDSA and RSA private keys are supported; RSA authentication requires the server to advertise SHA-2 signature support and does not fall back to SHA-1.
- Host keys must be verified. Changes require authorization under the host application's approval rules; privileges are not elevated automatically.
- Failed file transfers restart from the beginning; resuming transfers or recovering them across application restarts is not supported. Desktop text editing is limited to 2 MiB, and assistant text editing to 32 KiB. Atomic replacement does not guarantee preservation of ACLs, extended attributes, or hard links.
- Assistant tasks and conversations are retained only during the current run. Remote operations may already have taken effect after a timeout, disconnection, or cancellation. Verify the actual result rather than automatically replaying changes.
- In-app updates are available for stable Windows x64 NSIS installations, with signature and version verification. Plugin packages do not have cryptographic signature verification; file digests do not establish publisher identity.

See the [security notes](docs/release/SECURITY.md) for the full boundaries.

## Documentation and License

The [documentation index](docs/README.md) links to product development, architecture, public plugin contracts, release validation, and the official user documentation. Development requirements are in [AGENTS.md](AGENTS.md).

This project is licensed under the [MIT License](LICENSE). See the [dependency inventory](docs/release/DEPENDENCY_INVENTORY.md) and [third-party notices](docs/release/THIRD_PARTY_NOTICES.txt) for third-party dependencies and licenses.
