# Progress

Living checklist for **sonite** — what’s done, what’s in flight, and what’s still ahead.

Last updated: 2026-07-22

---

## Vision

Build a programming language with TypeScript-like syntax that ahead-of-time compiles to native code via LLVM. The compiler itself is written in TypeScript (Node.js).

Target pipeline:

```
.sn source → lexer → parser → validate → typecheck → LLVM IR → clang (bundled/cached) → native binary
```

---

## Done

### Project scaffolding
- [x] pnpm workspace monorepo (Node 20+)
- [x] `@sonite/compiler` — lexer, parser, validate, typecheck, codegen, formatter
- [x] `@sonite/cli` — `sn` CLI (depends on compiler)
- [x] `@sonite/runtime` — C runtime (`libsn_runtime.a`)
- [x] `@sonite/std` — standard library (prelude + modules)
- [x] `@sonite/lsp` / VS Code extension
- [x] Strict TypeScript configs (`tsconfig.base.json` + per-package)
- [x] Vitest in the compiler package
- [x] `.gitignore`, `.editorconfig`, VS Code workspace hints
- [x] `README.md`, MIT `LICENSE`
- [x] Examples under `examples/`

### Compiler pipeline (working)
- [x] `compile()` / `compileFile()` API in `@sonite/compiler`
- [x] Diagnostic collector with source spans and severity
- [x] Formatted diagnostic output for the CLI
- [x] Post-parse validation requiring exactly one `main(): void` (other functions allowed)
- [x] Type checker for the current language surface
- [x] Source formatter (`formatSource` / `sn fmt`) — parse → pretty-print; comments not preserved yet

### CLI / toolchain
- [x] `sn` entrypoint using **Commander**
- [x] `project.toml` project manifest (name, version, entry, build.outdir, …)
- [x] `sn init` — scaffold project
- [x] `sn build` — compile project entry to native binary in `dist/`
- [x] `sn run [file]` — single-file or project build+run
- [x] `sn fmt [--check]` — format `.sn` files
- [x] `sn compile` — emit LLVM IR
- [x] `sn <file.sn>` — shorthand for `run`
- [x] Clang resolution: `SN_CLANG` → system PATH → download/cache pinned LLVM under `~/.cache/sn/`
- [x] `pnpm dev` builds the compiler then runs the CLI via `tsx`

### Language surface
(See README for the full feature list — modules, generics, classes, interfaces, control flow, exceptions, std, etc.)

---

## Next up

Add features one at a time (implement end-to-end when adding — no stubs):

1. **Formatter polish** — preserve comments; optional style config
2. **CLI polish** — `--emit-ast`, colored diagnostics, keep temp binaries on failure
3. **Project dependencies** — `[dependencies]` in `project.toml` when a package story exists

---

## Deferred / later

- [ ] Package registry / dependency resolution
- [ ] Cross-compilation targets
- [ ] Memory model / GC maturity
- [ ] CI (GitHub Actions: typecheck + test + build)

---

## Known limitations (today)

| Area | Limitation |
| --- | --- |
| Formatter | Comments are stripped; style is fixed (2-space, K&R braces) |
| Native binary | First-time clang download (if no system clang) fetches a large LLVM archive (~1–2 GB) into `~/.cache/sn/` |
| Strings | Concat allocates via `sn_alloc` (no automatic free yet) |

---

## How to work from this file

1. Pick the top item under **Next up**.
2. Implement it fully (lexer → IR) behind tests — no half-stubs for unused features.
3. Check it off here and adjust **Known limitations**.
4. Keep the README high-level; keep detailed status here.
