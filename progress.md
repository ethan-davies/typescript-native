# Progress

Living checklist for **typescript-native** — what’s done, what’s in flight, and what’s still ahead.

Last updated: 2026-07-19

---

## Vision

Build a programming language with TypeScript-like syntax that ahead-of-time compiles to native code via LLVM. The compiler itself is written in TypeScript (Node.js).

Target pipeline:

```
.tsn source → lexer → parser → validate → typecheck → LLVM IR → llc/clang → native binary
```

---

## Done

### Project scaffolding
- [x] pnpm workspace monorepo (Node 20+)
- [x] `@typescript-native/compiler` — lexer, parser, validate, typecheck, codegen
- [x] `@typescript-native/cli` — `tsn` CLI (depends on compiler)
- [x] Strict TypeScript configs (`tsconfig.base.json` + per-package)
- [x] Vitest in the compiler package
- [x] `.gitignore`, `.editorconfig`, VS Code workspace hints
- [x] `README.md`, MIT `LICENSE`
- [x] Examples: `examples/hello.tsn`, `examples/variables.tsn`, `examples/arithmetic.tsn`

### Compiler pipeline (working)
- [x] `compile()` API in `@typescript-native/compiler`
- [x] Diagnostic collector with source spans and severity
- [x] Formatted diagnostic output for the CLI
- [x] Post-parse validation requiring exactly one `main(): void` (other functions allowed)
- [x] Type checker for bindings, inference, arithmetic, `print`, calls, and returns

### Language surface
Valid programs look like:

```ts
function add(a: i32, b: i32): i32 {
  return a + b;
}

function main(): void {
  let x = add(2, 3) * (4 - 1);
  print(x);
  print("Hello " + "world");
}
```

- [x] Exactly one `main` with no parameters and return type `void`; additional top-level functions allowed
- [x] User-defined functions with typed parameters, return types, and `return`
- [x] Types: `i32`, `i64`, `f32`, `f64`, `bool`, `string`, `char`, `void`
- [x] `let` / `const` with optional annotations; inference from literals
- [x] `let` reassignment; `const` is immutable
- [x] Literals: integer, float, bool, string, char
- [x] Numeric arithmetic: `+ - * / %` with precedence, parentheses, and unary `-`
- [x] `print(...)` with one or more printable args (comma joins with spaces)
- [x] String concatenation with `+`
- [x] `print` builtin mapped to libc `printf` in LLVM IR
- [x] Whitespace and `//` / `/* */` comments allowed

### Lexer (`packages/compiler/src/lexer/`)
- [x] Keywords: `function`, `let`, `const`, `return`, `true`, `false`
- [x] Identifiers, strings, chars, integers, floats
- [x] Punctuation: `( ) { } ; : , + - * / % =`
- [x] Decoded string/char values (quotes stripped, basic escapes)
- [x] Line and block comments
- [x] Source location tracking
- [x] Vitest coverage

### AST (`packages/compiler/src/ast/`)
- [x] Nodes: `Program`, `FunctionDeclaration`, `Parameter`, `VariableDeclaration`, `AssignmentStatement`,
      `ExpressionStatement`, `ReturnStatement`, `CallExpression`, `BinaryExpression`, `UnaryExpression`,
      literals, `TypeAnnotation`

### Parser (`packages/compiler/src/parser/`)
- [x] Recursive-descent grammar for current language surface
- [x] Required function return types

### Codegen (`packages/compiler/src/codegen/`)
- [x] LLVM IR emission with stack locals (`alloca`)
- [x] `printf` for `print`; string concat via `tsn_str_concat` (`tsn_alloc`)
- [x] Private string globals (`c"...\00"`) with proper escaping

### CLI (`packages/cli`)
- [x] `tsn` entrypoint using **Commander**
- [x] `tsn run <file.tsn>` — compile with clang and execute (temp files cleaned up)
- [x] `tsn <file.tsn>` — shorthand for `run`
- [x] `tsn compile <file.tsn> [-o out.ll]` — emit LLVM IR only
- [x] `pnpm dev` builds the compiler then runs the CLI via `tsx`

### Tests
- [x] Lexer / parser / compile suites in `packages/compiler/tests/`

---

## Next up

Add features one at a time (implement end-to-end when adding — no stubs):

1. **Comparisons** — `==`, `!=`, `<`, `>`, `<=`, `>=`
2. **Control flow** — `if` / `else`, `while` (return already supported)
3. **CLI polish** — `--emit-ast`, colored diagnostics, keep temp binaries on failure

---

## Deferred / later

- [ ] Modules / imports / exports
- [ ] Structs / classes / interfaces
- [ ] Generics
- [ ] Standard library beyond `print`
- [ ] Memory model / GC
- [ ] Language server / editor support
- [ ] CI (GitHub Actions: typecheck + test + build)

---

## Known limitations (today)

| Area | Limitation |
| --- | --- |
| Language | No comparisons or control flow (`if` / `while`) yet |
| Types | No implicit numeric conversions beyond int/float literal width annotations |
| Native binary | `tsn run` needs `clang` on `PATH` |
| Strings | Concat allocates via `tsn_alloc` (no automatic free yet) |

---

## How to work from this file

1. Pick the top item under **Next up**.
2. Implement it fully (lexer → IR) behind tests — no half-stubs for unused features.
3. Check it off here and adjust **Known limitations**.
4. Keep the README high-level; keep detailed status here.
