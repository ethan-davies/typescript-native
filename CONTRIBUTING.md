# Contributing to sonite

Thanks for your interest in contributing to **sonite**. This guide covers how to set up the repo, make changes, and open pull requests.

Please read the [Code of Conduct](./CODE_OF_CONDUCT.md) before participating. Security issues should follow the [Security Policy](./SECURITY.md) — do not open public issues for vulnerabilities.

## Requirements

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+
- A C++17 compiler and Node headers (to build `@sonite/llvm` from source)
- On Windows: Windows SDK / MSVC tools for system libraries when linking

**End users** do not need LLVM, Clang, LLD, llc, ld.lld, or OpenSSL installed separately. The `@sonite/llvm` package installs a platform-specific optional dependency (`@sonite/llvm-linux-x64`, …) that bundles the native addon and LLVM/LLD shared libraries. Runtime prebuilts under `@sonite/runtime` include the static Sonite runtime and, when built with `pnpm --filter @sonite/runtime openssl`, statically linked OpenSSL archives.

**Contributors** building the native binding:

```bash
pnpm build:native
```

This downloads the pinned LLVM **22.1.8** SDK into `~/.cache/sonite/` (override with `SONITE_LLVM_SDK` or `SN_CACHE_DIR`). For emergency local iteration only: `SONITE_BUNDLE_FROM_SYSTEM=1` (still copies libs into the platform package). **CI and release builds must not set `SONITE_BUNDLE_FROM_SYSTEM=1`.**

Optional: bundle OpenSSL for self-contained TLS linking:

```bash
pnpm --filter @sonite/runtime openssl
```

Runtime C sources are still built with `clang`/`make` for maintainers; `sn build` / `sn run` never invoke clang — they link `prebuilt/<platform>/libsn_runtime.a` (or `sn_runtime.lib` on Windows) through the direct LLVM/LLD toolchain.

### Supported platforms

| Platform | Architecture | Status |
| --- | --- | --- |
| Linux | x64 | Supported |
| Linux | ARM64 | Supported |
| macOS | x64 | Supported |
| macOS | ARM64 | Supported |
| Windows | x64 | Supported |
| Windows | ARM64 | Deferred |

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Run a source file without a full install of the `sn` binary:

```bash
pnpm dev examples/hello.sn
```

Useful development commands:

```bash
pnpm test          # compiler, runtime, LSP, and VS Code package tests
pnpm test:watch    # vitest watch (compiler)
pnpm typecheck     # type-check all packages
pnpm build         # build the workspace
pnpm dev fmt --check
```

Package-scoped work:

```bash
pnpm --filter @sonite/compiler test
pnpm --filter @sonite/runtime build
pnpm --filter @sonite/runtime test
pnpm --filter @sonite/cli exec sn build   # from a project directory
```

## Repository layout

This is a pnpm workspace. Most contributions land in one of these packages:

| Package | Role |
| --- | --- |
| [`packages/compiler`](./packages/compiler) | Lexer, parser, validation, typecheck, LLVM codegen |
| [`packages/llvm`](./packages/llvm) | TypeScript LLVM/LLD API + reproducible native build |
| [`packages/llvm-linux-x64`](./packages/llvm-linux-x64) (and siblings) | Platform-bundled `.node` + LLVM/LLD libs |
| [`packages/runtime`](./packages/runtime) | C runtime (`libsn_runtime.a` / `sn_runtime.lib`) |
| [`packages/std`](./packages/std) | Standard library written in SN (`.sn`) |
| [`packages/cli`](./packages/cli) | `sn` CLI |
| [`packages/lsp`](./packages/lsp) | Language server |
| [`packages/vscode`](./packages/vscode) | Editor extension + TextMate grammar |

Language examples live under [`examples/`](./examples). Source files use the `.sn` extension and must define `function main(): void`.

For runtime layout and GC details, see [`MEMORY_MODEL.md`](./MEMORY_MODEL.md) and [`packages/runtime/README.md`](./packages/runtime/README.md).

## Finding something to work on

- Open an issue before large language or ABI changes so design can be discussed early.
- Prefer small, focused pull requests over broad refactors.
- Good starting points: tests, examples, stdlib helpers, docs, LSP/editor polish, and focused compiler bug fixes.
- Match existing patterns in the package you touch (TypeScript for compiler/CLI/LSP; C for the runtime; SN for `packages/std` and examples).

## Pull requests

1. Fork and create a branch from the default branch.
2. Make your change with tests or an example when behavior changes.
3. Run `pnpm typecheck` and `pnpm test` locally.
4. Open a pull request with a clear summary of *why* the change is needed and how to verify it.

PR tips:

- Keep commits focused; avoid unrelated formatting or renames.
- For compiler changes, add or update Vitest coverage under `packages/compiler/tests/`.
- For runtime changes, update smoke tests under `packages/runtime/tests/` when applicable.
- For language surface changes, consider a short example under `examples/` and mention it in the PR.
- Update docs (`README.md`, package READMEs) only when user-facing behavior or workflow changes.

## Coding guidelines

- Follow the style already used in the surrounding file and package.
- Prefer minimal diffs: no drive-by refactors, unused abstractions, or unsolicited markdown.
- Compiler and tooling are TypeScript (ESM). Runtime is C with `sn_`-prefixed public symbols in [`packages/runtime/include/sn/runtime.h`](./packages/runtime/include/sn/runtime.h).
- Do not break the SN ABI or GC contracts without an explicit design discussion and docs update.
- Generated LLVM IR and linked binaries should remain consistent with the runtime’s heap/GC expectations.

## Reporting bugs

Include:

- A minimal `.sn` reproduction when possible
- Expected vs actual behavior
- OS, Node.js, and pnpm versions
- Relevant CLI output, diagnostics, or IR (`pnpm dev compile path/to/file.sn`)

Feature requests are welcome as issues; describe the use case and how it fits (or conflicts with) the current language surface in [`FEATURES.md`](./FEATURES.md) / the README.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
