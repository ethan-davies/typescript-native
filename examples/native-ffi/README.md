# Native FFI example

Demonstrates Phase 5 public FFI:

1. `extern function` with `@symbol`
2. `@repr("C")` struct
3. `Ptr<T>` and `FnPtr`
4. Linking a package-provided static library via `[native]`

## Build the C library (once per platform)

```bash
cc -c -O2 -fPIC native/sn_example.c -o /tmp/sn_example.o -I native
mkdir -p native/linux-x64   # or macos-arm64, etc.
ar rcs native/linux-x64/libsn_example.a /tmp/sn_example.o
```

## Run

From the repo root (with the Sonite CLI built):

```bash
cd examples/native-ffi
sn build
./dist/native-ffi-example
```

Expected output includes `42` (20+22) and a callback print of that value.
