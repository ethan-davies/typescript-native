# Prebuilt runtime archives

Place the static runtime library here for each supported platform:

| Platform | Artifact |
| --- | --- |
| `linux-x64/` | `libsn_runtime.a` |
| `linux-arm64/` | `libsn_runtime.a` |
| `macos-x64/` | `libsn_runtime.a` |
| `macos-arm64/` | `libsn_runtime.a` |
| `win32-x64/` | `sn_runtime.lib` |
| `win32-arm64/` | deferred |

Produced by `pnpm --filter @sonite/runtime build` (Unix) or `make -f Makefile.win` (Windows), which copies into `prebuilt/<host>/`.

When OpenSSL has been bundled (`pnpm --filter @sonite/runtime openssl`), `libssl.a` / `libcrypto.a` (or `.lib` on Windows) are copied alongside the runtime archive.
