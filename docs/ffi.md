# Sonite FFI & Native Interoperability

Sonite’s memory-safety guarantees **do not automatically extend across native code**. FFI is an explicit unsafe boundary.

## Overview

```text
Sonite source
    │  extern declarations + Ptr / @repr("C") / FnPtr
    ▼
LLVM IR (C ABI)
    │
    ▼
LLD + [native] libraries
    │
    ▼
Native executable
```

## `extern function`

```sn
@symbol("strlen")
@abi("C")
extern function c_strlen(value: Ptr<u8>): usize;

unsafe function stringByteLength(p: Ptr<u8>): usize {
    return c_strlen(p);
}
```

- C ABI only (`@abi("C")` is the default for extern).
- Link symbol defaults to the function name; override with `@symbol("…")`.
- Calling an extern function requires an `unsafe` context (stdlib/prelude is a trusted boundary and may call runtime `sn_*` symbols without wrapping every site).

Do **not** declare `extern function sn_…` in application code — those symbols are the internal runtime ABI.

## Unsafe

```sn
unsafe {
    let v: i32 = *ptr;
    *ptr = 42;
}

unsafe function poke(p: Ptr<i32>, v: i32): void {
    *p = v;
}
```

Unsafe is required for:

- Pointer dereference (`*p`) and stores through pointers
- Pointer / integer casts (`as`)
- Calling `extern` functions (outside trusted std modules)
- Calling through `FnPtr`
- Converting a top-level Sonite function to `FnPtr`

## Pointers: `Ptr<T>`

```sn
let p: Ptr<i32> = null;
let q: Ptr<void> = null;

unsafe {
    let x: i32 = *p;
    *p = x + 1;
    let asBytes: Ptr<u8> = p as Ptr<u8>;
    let addr: usize = p as usize;
}
```

`null` is assignable to any `Ptr<T>`. The compiler does **not** track whether native code retains a pointer after a call returns — that is the caller’s responsibility.

## C-compatible structs

```sn
@repr("C")
struct NativePoint {
    x: i32;
    y: i32;
}
```

Rules:

- Field order, padding, and alignment follow the C ABI / LLVM data layout for the target.
- Fields must be C-compatible (integers, floats, `Ptr`, nested `@repr("C")` structs, fixed `T[N]`).
- Not allowed: `string`, `bool`, classes, Sonite `T[]`, closures, unmarked structs.
- Fixed-size arrays: `u8[16]` (only in `@repr("C")` fields).

## Function pointers & callbacks

```sn
FnPtr<(i32) => void>

extern function register_callback(cb: FnPtr<(i32) => void>): void;

function onEvent(value: i32): void {
    // Prefer not to throw across FFI
}

unsafe function setup(): void {
    register_callback(onEvent);
}
```

- `FnPtr` is distinct from Sonite `(T) => U` callables (which carry an environment).
- Only top-level, non-capturing functions may convert to `FnPtr`.
- **Sonite exceptions must not cross a C ABI boundary.** Callbacks should catch errors at the edge; the current codegen does not insert an automatic exception barrier.

## C-sized integers

FFI-oriented primitives: `i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `isize`, `usize`, plus `f32` / `f64` / `char`.

Prefer these over `bool` / `string` at the ABI boundary.

## Memory ownership

| Pattern | Meaning |
| --- | --- |
| Caller-owned | Sonite allocates (or borrows), C reads for the call duration, Sonite frees |
| Callee-owned | C allocates, Sonite receives a `Ptr`, Sonite calls a documented free function |
| Shared | Explicit refcount or other protocol — GC will **not** manage native pointers |

Assume native code may retain pointers unless the API documents otherwise. Copy when in doubt.

## Callback lifetime

A `FnPtr` to a top-level Sonite function remains valid for the process lifetime. Do not pass pointers to stack data or short-lived buffers that native code may call later.

## Native linking (`project.toml`)

```toml
[native]
libraries = ["foo"]
library_paths = ["native/lib"]
link_args = ["-pthread"]
headers = ["include/foo.h"]   # documentation only — not compiled

[native.linux]
libraries = ["foo"]

[native.macos-arm64]
library_paths = ["native/macos-arm64"]
```

Resolution for the host platform (`linux-x64`, `macos-arm64`, …):

1. Merge `[native]` with matching `[native.<os>]` then `[native.<os>-<arch>]`.
2. Search `library_paths` and `native/<platform>/` for `libfoo.a` / `.so` / `.dylib` / `.lib`.
3. Prefer a found artifact file; otherwise link as a system library (`-lfoo`).
4. Apply `link_args` as raw linker arguments.

Header paths are recorded for documentation; Sonite does **not** invoke a C compiler or parse headers.

## Internal runtime ABI

Runtime symbols use `sn_<subsystem>_<operation>` and are linked via `libsn_runtime`. They are not a public FFI surface. See `packages/runtime/README.md`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `requires an unsafe context` | Wrap the op/call in `unsafe { }` or mark `unsafe function` |
| `not marked @repr("C")` | Add `@repr("C")` or pass a `Ptr` instead of a Sonite struct |
| `string` / `bool` rejected | Use `Ptr<u8>` / `u8` / `i32` at the ABI edge |
| Undefined symbol at link | Add the library under `[native]` or ship it in `native/<platform>/` |
| Crash after native call | ABI mismatch (wrong types/layout) — Sonite cannot detect all mismatches |
