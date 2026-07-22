# typescript-native

**typescript-native** is a programming language with TypeScript-like syntax that compiles to native code through LLVM. The compiler is written in TypeScript and exposed as the `tsn` CLI.

```ts
function main(): void {
  const name = "world";
  print("Hello", name);
}
```

```bash
pnpm install
pnpm dev examples/hello.tsn
# Hello, world!
```

## Packages

This repository is a pnpm workspace:

| Package | Name | Role |
| --- | --- | --- |
| [`packages/compiler`](./packages/compiler) | `@typescript-native/compiler` | Lexer, parser, validation, typecheck, LLVM codegen |
| [`packages/runtime`](./packages/runtime) | `@typescript-native/runtime` | C runtime (`libtsn_runtime.a`) for print, strings, arrays, maps |
| [`packages/cli`](./packages/cli) | `@typescript-native/cli` | `tsn` command-line tool |

## Requirements

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+
- [Clang](https://clang.llvm.org/) on your `PATH` (needed to run programs)

## Getting started

```bash
pnpm install
pnpm dev examples/hello.tsn
```

`pnpm dev` builds the compiler, then runs the CLI from the repo root. After a full workspace build:

```bash
pnpm build
node packages/cli/dist/cli.js examples/hello.tsn
```

Try the variables example next:

```bash
pnpm dev examples/variables.tsn
```

## CLI

| Command | Description |
| --- | --- |
| `tsn <file.tsn>` | Compile with Clang and run |
| `tsn run <file.tsn>` | Same as above |
| `tsn compile <file.tsn>` | Emit LLVM IR (`<file>.ll` by default) |
| `tsn compile <file.tsn> -o out.ll` | Emit LLVM IR to a specific path |

During development:

```bash
pnpm dev examples/hello.tsn
pnpm dev run examples/hello.tsn
pnpm dev compile examples/hello.tsn -o hello.ll
```

## Language

Programs are stored in `.tsn` files. Every program must define `function main(): void` — that is the entry point.

**Currently supported:**

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
- Arrays: literals `[1, 2, 3]`, indexing, element assignment, `.length`, `.push` / `.pop` / `.includes` / `.indexOf`
- Tuples: fixed-length heterogeneous products `[string, i32]`, const/dynamic indexing (dynamic → union), `.length`, element assignment with constant indexes, destructuring with holes
- Function types `(i32, i32) => i32`: annotate variables, parameters, and return types; use in `type` aliases; assign and pass named functions as first-class values; call through function-typed expressions
- Default parameter values (`greeting: string = "Hello"`) evaluated at the call site when omitted; required parameters must precede defaults
- Named call arguments (`createPerson(age: 16, name: "Ethan")`), any order, mixed with leading positionals; can skip middle defaults (`configure(host, secure: true)`). Defaults and named args apply only to direct function/method references — not through function-typed values
- Arrow lambdas `(a: i32, b: i32) => a + b` and block bodies; contextual typing from an expected function type; closures with capture-by-reference for `let` (heap boxes) and by-value for `const` (no generic lambdas yet)
- Literals: integers, floats, booleans, strings, chars, `null`
- `print(...)` of printable values; multiple args are joined with spaces
- String concatenation with `+`
- Comparisons (`== != < <= > >=`) and logical ops (`&& || !`)
- Value-position `typeof` expression (returns type tags such as `"string"`, `"i32"`, `"bool"`, `"null"`, `"object"`)
- `value is Type` type checks (including `is null` and class types) with narrowing
- Control flow: `if` / `elseif` / `else`, `while`, C-style `for`, element `for (i in arr)`, `break`, `continue`
- `//` line comments and `/* */` block comments

`print` is a builtin. It is lowered to `tsn_print_*` runtime calls in the generated LLVM IR, and `tsn run` links `libtsn_runtime.a` when building the native binary.
`createMap()` is a builtin that allocates an empty string-keyed map (for index-signature types).

### Examples

| File | Demonstrates |
| --- | --- |
| [`examples/hello.tsn`](./examples/hello.tsn) | Minimal `main` + `print` |
| [`examples/variables.tsn`](./examples/variables.tsn) | Types, inference, `let`/`const`, concat, multi-arg `print` |
| [`examples/arithmetic.tsn`](./examples/arithmetic.tsn) | Arithmetic and precedence |
| [`examples/control-flow.tsn`](./examples/control-flow.tsn) | `if` / `elseif` / `else`, comparisons |
| [`examples/loops.tsn`](./examples/loops.tsn) | `for` / `while`, updates, `break` / `continue` |
| [`examples/arrays.tsn`](./examples/arrays.tsn) | Array literals, indexing, methods, `for-in` |
| [`examples/tuples.tsn`](./examples/tuples.tsn) | Tuple types, indexing, destructuring, generics |
| [`examples/structs.tsn`](./examples/structs.tsn) | Struct decls, literals, fields, params |
| [`examples/struct-methods.tsn`](./examples/struct-methods.tsn) | Struct instance methods with `this` |
| [`examples/classes.tsn`](./examples/classes.tsn) | Classes, `new`, constructors, static/readonly/private |
| [`examples/inheritance.tsn`](./examples/inheritance.tsn) | Abstract classes, `extends`, virtual methods |
| [`examples/interfaces.tsn`](./examples/interfaces.tsn) | Interfaces, `implements`, itable dispatch |
| [`examples/generics.tsn`](./examples/generics.tsn) | Generic structs/classes/functions/methods, constraints, inference |
| [`examples/type-aliases.tsn`](./examples/type-aliases.tsn) | Type aliases and literal unions |
| [`examples/unions.tsn`](./examples/unions.tsn) | Union types and typeof narrowing |
| [`examples/nullability.tsn`](./examples/nullability.tsn) | `null`, nullable types, `is` checks, CFA narrowing |
| [`examples/multi-constraints.tsn`](./examples/multi-constraints.tsn) | Multi-constraints (`T extends A & B`) |
| [`examples/dictionaries.tsn`](./examples/dictionaries.tsn) | Index signatures as string-keyed maps |
| [`examples/type-operators.tsn`](./examples/type-operators.tsn) | `keyof` / `typeof` / conditionals / mapped types / `T[K]` |
| [`examples/function-types.tsn`](./examples/function-types.tsn) | Function type annotations, aliases, named functions as values |
| [`examples/default-named-args.tsn`](./examples/default-named-args.tsn) | Default parameters and named call arguments |
| [`examples/lambdas.tsn`](./examples/lambdas.tsn) | Arrow lambdas, contextual typing, closures |

## Development

```bash
pnpm test          # compiler test suite
pnpm test:watch    # vitest watch mode
pnpm typecheck     # type-check all packages
pnpm build         # build compiler + CLI
```

## License

[MIT](./LICENSE)
