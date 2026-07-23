# Features

Currently supported features:

- A single top-level `function main(): void` with no parameters (return type required)
- Types: `i32`, `i64`, `f32`, `f64`, `bool`, `string`, `char`, `void`, `null`, arrays `T[]`, tuples `[T, U]`, `struct`, `enum`, `class`, and `interface` types
- Generics: type parameters on structs, classes, interfaces, functions, and methods; constraints (`T extends I`); nested type arguments; call-site inference; compile-time monomorphization (no runtime generics)
- Type aliases (`type Name = ...`), including generic aliases, unions (`|`), intersections (`&`), literal types, `keyof` / `typeof` type operators, conditional and mapped types
- Control-flow narrowing via `typeof` checks, `== null` / `!= null`, and `is` type checks on union / nullable values; early `return` / `break` / `continue` refine types in subsequent code
- Index signatures (`[key: string]: T`) as string-keyed maps
- Struct declarations, literals (`Person { name: "...", age: 16 }`), field access, field assignment, and instance methods
- Classes: `new`, constructors, instance/static fields and methods, `public`/`private`, `readonly`, inheritance (`extends`), and `abstract` classes (heap reference types)
- Interfaces: method contracts with `implements` / `extends`, optional index signatures, compile-time compliance checks, and fat-pointer dynamic dispatch when typed as an interface
- `let` / `const` variables with optional annotations and inference (`5` → `i32`, `3.14` → `f64`); annotated `let` may omit an initializer (`let x: T | null;`); tuple destructuring (`let [a, b] = pair`)
- Reassignment for `let` only (`=`, `+=`, `-=`, `++`, `--` on numeric lets)
- Arrays: literals `[1, 2, 3]`, indexing, element assignment, `.length`, and prelude methods (`.push` / `.pop` / `.includes` / `.indexOf` / `.map` / `.filter` / `.reduce` / `.join` / `.concat` / …)
- String methods via the auto-loaded prelude (`.contains`, `.startsWith`, `.trim`, `.toUpperCase`, `.indexOf`, `.padStart`, `.join`, …)
- Extension methods: `export function contains(this: string, needle: string): bool` callable as `"hi".contains("h")`
- `extern function` declarations for calling C runtime symbols from SN
- Explicit standard-library modules via `import { … } from "std/…"` (`std/math`, `std/random`, `std/collections`; `std/strings` / `std/io` reserved for future specialized APIs)
- Tuples: fixed-length heterogeneous products `[string, i32]`, const/dynamic indexing (dynamic → union), `.length`, element assignment with constant indexes, destructuring with holes
- Function types `(i32, i32) => i32`: annotate variables, parameters, and return types; use in `type` aliases; assign and pass named functions as first-class values; call through function-typed expressions
- Default parameter values (`greeting: string = "Hello"`) evaluated at the call site when omitted; required parameters must precede defaults
- Named call arguments (`createPerson(age: 16, name: "Ethan")`), any order, mixed with leading positionals; can skip middle defaults (`configure(host, secure: true)`). Defaults and named args apply only to direct function/method references — not through function-typed values
- Arrow lambdas `(a: i32, b: i32) => a + b` and block bodies; contextual typing from an expected function type; closures with capture-by-reference for `let` (heap boxes) and by-value for `const` (no generic lambdas yet)
- Literals: integers, floats, booleans, strings, chars, `null`
- `print(...)` of printable values; multiple args are joined with spaces (compiler intrinsic, available through the prelude)
- String concatenation with `+`
- Comparisons (`== != < <= > >=`) and logical ops (`&& || !`)
- Value-position `typeof` expression (returns type tags such as `"string"`, `"i32"`, `"bool"`, `"null"`, `"object"`)
- `value is Type` type checks (including `is null` and class types) with narrowing
- Control flow: `if` / `elseif` / `else`, `while`, C-style `for`, element `for (i in arr)`, `switch` / `case` / `default`, `break`, `continue`
- Exceptions: built-in `Error` class (`message`), `throw`, `try` / `catch` / `finally` (every thrown value must be `Error` or a subclass)
- `//` line comments and `/* */` block comments

`print` is a builtin. It is lowered to `sn_print_*` runtime calls in the generated LLVM IR, and `sn run` links `libsn_runtime.a` when building the native binary.
`createMap()` is a builtin that allocates an empty string-keyed map (for index-signature types).
