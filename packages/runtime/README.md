# @typescript-native/runtime

C runtime library linked into every `tsn run` binary.

## Layout

| Type | Memory layout |
| --- | --- |
| Class object | `{ TsnObjectHeader { i32 type_id, void *vtable }, fields… }` |
| Array | `{ i64 length, i64 capacity, ptr data }` — 24 bytes (`TSN_ARRAY_HEADER_SIZE`) |
| Map | `{ i64 len, i64 cap, char **keys, void **vals }` — 32 bytes |
| String | NUL-terminated `char *` (immutable; concat allocates a new buffer) |
| Closure | Handle `%__Callable { code*, env* }`; environment is a separate heap blob |

`type_id` on class instances indexes runtime `TypeInfo` (class IDs start at `TSN_TYPEID_CLASS_BASE` = 256). Builtin IDs 1–5 cover string/array/map/closure/env. Arrays, maps, and strings do **not** embed `type_id` in their current ABI; the GC side table records type identity via `tsn_gc_set_type` / `tsn_gc_set_array_meta` / `tsn_gc_set_map_meta`. Aggregate / box layouts use registered `TSN_KIND_STRUCT` TypeInfo entries (≥ 256).

## Heap & GC

Canonical TSN heap API: `tsn_alloc` / `tsn_realloc` / `tsn_free`. Higher-level helpers (`tsn_array_new`, `tsn_map_new`, `tsn_str_concat`, …) allocate through that API; generated code must not call libc `malloc` for TSN-managed objects.

All `tsn_alloc` traffic is GC-managed (mark-and-sweep). The compiler registers live references on a shadow stack (`tsn_gc_root_push` / `tsn_gc_root_restore` with a per-function checkpoint). Exception unwind restores the same stack via EH-frame checkpoints before `longjmp`. Collection runs when allocated bytes exceed a threshold, or via `tsn_gc_collect()`. The collector follows TypeInfo fields and array/map side-table meta to mark reachable graphs through classes, arrays, maps, nested structs, closures, and typed boxes.

## Build

```bash
pnpm --filter @typescript-native/runtime build
pnpm --filter @typescript-native/runtime test
```

Produces `dist/libtsn_runtime.a`.

## Public API

See [`include/tsn/runtime.h`](include/tsn/runtime.h). Symbols are prefixed with `tsn_` and declared in generated LLVM IR; the CLI links the static archive at run time.
