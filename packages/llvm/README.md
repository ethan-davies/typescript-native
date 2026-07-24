# @sonite/llvm

Pinned LLVM 22.1.8 + LLD native binding for the Sonite toolchain.

## End-user install

`@sonite/llvm` pulls the matching platform package via `optionalDependencies`:

- `@sonite/llvm-linux-x64`
- `@sonite/llvm-linux-arm64`
- `@sonite/llvm-macos-x64`
- `@sonite/llvm-macos-arm64`
- `@sonite/llvm-win32-x64`
- `@sonite/llvm-win32-arm64` (stub — deferred)

Each platform package ships `native/sonite_llvm.node` plus bundled `lib/` LLVM/LLD shared libraries. Users do **not** need system LLVM, clang, llc, or ld.lld.

When publishing to npm, bump all `@sonite/llvm-*` packages in lockstep with `@sonite/llvm` and replace `workspace:*` optionalDependency ranges with the published version. Add `os`/`cpu` filters to each published platform package so npm installs only the matching artifact (they are omitted in the monorepo to avoid pnpm Unsupported platform WARNs on workspace members).

## Contributor build

```bash
pnpm build:native
```

This:

1. Downloads the pinned LLVM 22.1.8 SDK into `~/.cache/sonite/llvm-sdk-22.1.8-<platform>/` (or uses `SONITE_LLVM_SDK`)
2. Compiles the N-API addon against that SDK
3. Bundles required shared libraries into `packages/llvm-<platform>/lib`
4. Validates that `ldd`/`otool` does not resolve libLLVM/liblld from the system

Override with `SONITE_LLVM_SDK=/path/to/sdk`. For emergency local iteration only: `SONITE_BUNDLE_FROM_SYSTEM=1` (still bundles libs into the package).

Version pin: [`scripts/llvm-version.json`](scripts/llvm-version.json) / [`src/version.ts`](src/version.ts).

## API

```ts
import { Backend, Linker, getLlvmVersion } from "@sonite/llvm";
```
