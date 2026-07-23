# Features

Currently supported features:

- A single top-level `function main(): void` or `async function main(): void` with no parameters (return type required)
- Types: `i32`, `i64`, `f32`, `f64`, `bool`, `string`, `char`, `void`, `null`, arrays `T[]`, tuples `[T, U]`, `struct`, `enum`, `class`, `interface`, and `Future<T>` types
- Async/await: `async function`, `await` expressions (async functions only), cooperative single-threaded tasks, timers, and TCP via the event loop
- Generics: type parameters on structs, classes, interfaces, functions, and methods; constraints (`T extends I`); nested type arguments; call-site inference; compile-time monomorphization (no runtime generics)
- Type aliases (`type Name = ...`), including generic aliases, unions (`|`), intersections (`&`), literal types, `keyof` / `typeof` type operators, conditional and mapped types
- Control-flow narrowing via `typeof` checks, `== null` / `!= null`, and `is` type checks on union / nullable values; early `return` / `break` / `continue` refine types in subsequent code
- Index signatures (`[key: string]: T`) as string-keyed maps
- Struct declarations, literals (`Person { name: "...", age: 16 }`), field access, field assignment, and instance methods
- Classes: `new`, constructors, instance/static fields and methods, `public`/`private`, `readonly`, inheritance (`extends`), and `abstract` classes (heap reference types)
- Interfaces: method contracts with `implements` / `extends`, optional index signatures, compile-time compliance checks, and fat-pointer dynamic dispatch when typed as an interface
- `let` / `const` variables with optional annotations and inference (`5` → `i32`, `3.14` → `f64`); annotated `let` may omit an initializer (`let x: T | null;`); tuple destructuring (`let [a, b] = pair`); module-level `export const` / `export let` / `const` / `let` (simple names, required initializer)
- Reassignment for `let` only (`=`, `+=`, `-=`, `++`, `--` on numeric lets)
- Arrays: literals `[1, 2, 3]`, indexing, element assignment, `.length`, and prelude methods (`.push` / `.pop` / `.map` / `.filter` / `.forEach` / `.findIndex` / …)
- String methods via the auto-loaded prelude (`.contains`, `.startsWith`, `.trim`, `.trimStart`, `.slice`, `.replaceAll`, `.join`, …)
- Template literals with interpolation: `` `Hello ${name}!` `` (lowered to `sn_*_to_string` + `sn_str_concat`)
- Extension methods: `export function contains(this: string, needle: string): bool` callable as `"hi".contains("h")`
- `extern function` declarations for calling C runtime symbols from SN
- Explicit standard-library modules via `import { … } from "std/…"`:
  - `std/math` — abs/min/max/clamp/floor/ceil/round/sqrt/pow, trig (sin/cos/tan/asin/acos/atan/atan2), constants `PI`/`E`/`TAU`
  - `std/random` — `random` / `randomInt` / `randomFloat` / `randomBool` / `seed` (pseudo-random, not crypto)
  - `std/collections` — `Stack`, `Queue`, `Set`, `List`, `Map`, `Deque`
  - `std/io` — `readLine`, stream write helpers (`console.*` builtins need no import)
  - `std/fs` — file/directory/path helpers
  - `std/process` — `args`, `getEnv`, `setEnv`, `cwd`, `exit`
  - `std/time` — `Instant`, `Duration`, async `sleep`, `sleepSync`, `now`
  - `std/async` — `sleep`, `spawn`, `all`, `race`
  - `std/net` — async TCP `listen` / `accept` / `connect` / `read` / `write` / `close`
  - `std/encoding` — UTF-8 helpers, base64, hex
- Modules / imports:
  - Relative imports require `./` or `../` (e.g. `import { User } from "./models"`)
  - Core std via `std/…`; installed packages via bare name or `pkg/subpath` (versions from `project.lock`)
  - Named imports with aliases, `import * as ns from "…"`, and legacy `import "./mod"` / `import "./mod" as a`
  - `export` on declarations; re-exports `export { X as Y } from "…"` and `export * from "…"`
  - Formal export tables; private declarations are not importable; circular imports/re-exports diagnosed
  - No default exports
- Tuples: fixed-length heterogeneous products `[string, i32]`, const/dynamic indexing (dynamic → union), `.length`, element assignment with constant indexes, destructuring with holes
- Function types `(i32, i32) => i32`: annotate variables, parameters, and return types; use in `type` aliases; assign and pass named functions as first-class values; call through function-typed expressions
- Default parameter values (`greeting: string = "Hello"`) evaluated at the call site when omitted; required parameters must precede defaults
- Named call arguments (`createPerson(age: 16, name: "Ethan")`), any order, mixed with leading positionals; can skip middle defaults (`configure(host, secure: true)`). Defaults and named args apply only to direct function/method references — not through function-typed values
- Arrow lambdas `(a: i32, b: i32) => a + b` and block bodies; contextual typing from an expected function type; closures with capture-by-reference for `let` (heap boxes) and by-value for `const` (no generic lambdas yet)
- Literals: integers, floats, booleans, strings, chars, `null`, template literals
- `print(...)` and `console.log` / `console.error` / `console.warn` of printable values; `console.readLine()` reads stdin
- String concatenation with `+` and template interpolation
- Comparisons (`== != < <= > >=`) and logical ops (`&& || !`)
- Value-position `typeof` expression (returns type tags such as `"string"`, `"i32"`, `"bool"`, `"null"`, `"object"`)
- `value is Type` type checks (including `is null` and class types) with narrowing
- Control flow: `if` / `elseif` / `else`, `while`, C-style `for`, element `for (i in arr)`, `switch` / `case` / `default`, `break`, `continue`
- Exceptions: built-in `Error` class (`message`), `throw`, `try` / `catch` / `finally` (every thrown value must be `Error` or a subclass)
- `//` line comments and `/* */` block comments

`print` and `console.*` are builtins. They lower to `sn_print_*` / `sn_eprint_*` / `sn_read_line` runtime calls in the generated LLVM IR, and `sn run` links `libsn_runtime.a` when building the native binary.
`createMap()` is a builtin that allocates an empty string-keyed map (for index-signature types).
