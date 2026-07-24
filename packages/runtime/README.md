# @sonite/runtime

C runtime library linked into every `sn run` binary.

## Layout

| Type | Memory layout |
| --- | --- |
| Class object | `{ SnObjectHeader { i32 type_id, void *vtable }, fields… }` |
| Array | `{ i64 length, i64 capacity, ptr data }` — 24 bytes (`SN_ARRAY_HEADER_SIZE`) |
| Map | `{ i64 len, i64 cap, char **keys, void **vals }` — 32 bytes |
| String | NUL-terminated `char *` (immutable; concat allocates a new buffer) |
| Closure | Handle `%__Callable { code*, env* }`; environment is a separate heap blob |
| Future | Heap `SnFuture` (`SN_TYPEID_FUTURE` = 6): state, value/error, waiters, compose hook |
| Task | Heap `SnTask` (`SN_TYPEID_TASK` = 7): frame, entry, result future, awaiting future |

`type_id` on class instances indexes runtime `TypeInfo` (class IDs start at `SN_TYPEID_CLASS_BASE` = 256). Builtin IDs 1–7 cover string/array/map/closure/env/future/task. Arrays, maps, and strings do **not** embed `type_id` in their current ABI; the GC side table records type identity via `sn_gc_set_type` / `sn_gc_set_array_meta` / `sn_gc_set_map_meta`. Aggregate / box layouts use registered `SN_KIND_STRUCT` TypeInfo entries (≥ 256).

## Layout (platform abstraction)

```text
src/
├── common/     # alloc, GC, strings, arrays, async scheduler, timers, …
├── posix/      # Unix FS, paths, process, sockets, TLS, …
├── linux/      # epoll reactor
├── macos/      # kqueue reactor
└── windows/    # Win32 FS/paths/process + Winsock/IOCP reactor + TLS
```

## Async runtime

Single-threaded cooperative concurrency:

- **Scheduler / event loop** — `sn_task_spawn`, runnable queue, `sn_event_loop_run` / `sn_future_await_run`
- **Timers** — `sn_timer_sleep_ms` → `Future<void>`
- **Bytes** — length-prefixed `SnBytes` buffers (`sn_bytes_*`)
- **TCP / UDP** — non-blocking sockets registered with the platform reactor (epoll / kqueue / IOCP)
- **DNS** — `sn_dns_resolve` via a worker thread + Future completion
- **TLS** — OpenSSL client/server (`sn_tls_*`); handshakes run on detached threads so they compose with nested `await_run`, then I/O returns to the non-blocking reactor
- **Compose** — `sn_future_all` / `sn_future_race` over `Future*[]`

See `src/common/async.c`, platform `reactor.c`, `posix/net.c`, and `tests/async_smoke.c`.

Linking native programs requires system libraries such as `pthread` (and, when OpenSSL is not bundled, `ssl` / `crypto`) in addition to `libsn_runtime.a`. The `sn` CLI adds these via the target toolchain config, and prefers absolute bundled OpenSSL archives from `getBundledOpenSslLibraries()` when present.

## Heap & GC

Canonical SN heap API: `sn_alloc` / `sn_realloc` / `sn_free`. Higher-level helpers (`sn_array_new`, `sn_map_new`, `sn_str_concat`, …) allocate through that API; generated code must not call libc `malloc` for SN-managed objects.

All `sn_alloc` traffic is GC-managed (mark-and-sweep). The compiler registers live references on a shadow stack (`sn_gc_root_push` / `sn_gc_root_restore` with a per-function checkpoint). Exception unwind restores the same stack via EH-frame checkpoints before `longjmp`. Collection runs when allocated bytes exceed a threshold, or via `sn_gc_collect()`. The collector follows TypeInfo fields and array/map side-table meta to mark reachable graphs through classes, arrays, maps, nested structs, closures, and typed boxes.

## Build

```bash
pnpm --filter @sonite/runtime build
pnpm --filter @sonite/runtime test
```

Produces `dist/libsn_runtime.a` and copies it to `prebuilt/<host-platform>/libsn_runtime.a` for packaging.

### Bundled OpenSSL

TLS uses OpenSSL. For reproducible linking, pin and build a static OpenSSL into `deps/openssl/<platform>/`:

```bash
pnpm --filter @sonite/runtime openssl
```

When `deps/openssl/<platform>/lib/libssl.a` exists, the Makefile and CLI prefer those archives over system `-lssl -lcrypto`. `installHostPrebuilt` also copies them into `prebuilt/<platform>/`. Override the search root with `SONITE_OPENSSL_ROOT`.

On Windows, use `make -f Makefile.win` to produce `sn_runtime.lib` (includes Winsock async/net and OpenSSL TLS when headers/libs are available).

**Maintainer note:** building the C sources still uses `clang` (or `CC`) via the Makefile. End-user `sn build` / `sn run` never invoke clang; they link the prebuilt archive through `@sonite/llvm`.

Supported prebuilt platform ids: `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, `win32-x64`.

## Public API

See [`include/sn/runtime.h`](include/sn/runtime.h). Symbols are prefixed with `sn_` and declared in generated LLVM IR; the CLI links the static archive at run time.
