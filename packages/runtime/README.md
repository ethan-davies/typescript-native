# @typescript-native/runtime

C runtime library linked into every `tsn run` binary.

## Layout

| Type | Memory layout |
| --- | --- |
| Class object | `{ TsnObjectHeader { i32 type_id, void *vtable }, fields… }` |
| Array | `{ i64 length, i64 capacity, ptr data }` — 24 bytes (`TSN_ARRAY_HEADER_SIZE`) |
| Map | `{ i64 len, i64 cap, char **keys, void **vals }` — 32 bytes |
| String | NUL-terminated `char *` |

## Build

```bash
pnpm --filter @typescript-native/runtime build
pnpm --filter @typescript-native/runtime test
```

Produces `dist/libtsn_runtime.a`.

## Public API

See [`include/tsn/runtime.h`](include/tsn/runtime.h). Symbols are prefixed with `tsn_` and declared in generated LLVM IR; the CLI links the static archive at run time.
