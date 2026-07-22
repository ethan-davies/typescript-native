# TypeScript Native — VS Code / Cursor

Language support for **TypeScript Native** (`.tsn`).

## Features

- Syntax highlighting (TextMate grammar, `source.tsn`)
- Editor language configuration (comments, brackets, auto-closing pairs)
- Language server (diagnostics, hover, go-to-definition, completion, document symbols)

## Development

From the monorepo root:

```bash
pnpm install
pnpm --filter @typescript-native/compiler build
pnpm --filter @typescript-native/lsp build
pnpm --filter typescript-native-vscode build
```

Then use **Launch TSN Extension** in `.vscode/launch.json` (F5) to open an Extension Development Host with the examples folder.

The extension starts `@typescript-native/lsp` over stdio and analyzes open `.tsn` files with the compiler’s `analyzeFile` pipeline (no LLVM codegen).
