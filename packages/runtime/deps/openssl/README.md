# Bundled OpenSSL

Static OpenSSL builds for the Sonite runtime live under this directory:

```text
deps/openssl/<platformId>/
├── include/openssl/…
├── lib/libssl.a      # or libssl.lib on Windows
└── lib/libcrypto.a   # or libcrypto.lib on Windows
```

Platform ids match the runtime: `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `win32-x64`.

Build (or rebuild) with:

```bash
pnpm --filter @sonite/runtime openssl
```

Requires a C toolchain (and on Windows: Perl + NASM for the MSVC `VC-WIN64A` target). Built trees are gitignored; only this README and `.gitkeep` are tracked.
