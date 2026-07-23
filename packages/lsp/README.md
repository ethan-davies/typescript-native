# @sonite/lsp

Language server for Sonite (`.sn`).

## Run

```bash
pnpm --filter @sonite/compiler build
pnpm --filter @sonite/lsp build
node packages/lsp/dist/server.js --stdio
```

Speaks LSP over stdio. Used by `sonite-vscode`.

## Features

- Diagnostics (lexer / parser / validate / typecheck via `analyzeFile`)
- Hover
- Go to definition
- Find references
- Completion (keywords, in-scope bindings, module symbols, members after `.`, import path strings, auto-import)
- Document symbols
