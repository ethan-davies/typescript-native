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

- Diagnostics (lexer / parser / validate / typecheck via `analyzeFile`, including unused-import warnings)
- Hover
- Go to definition
- Find references (`includeDeclaration` supported)
- Rename symbol (with conflict detection)
- Signature help
- Code actions (add missing import, remove unused import, organize imports)
- Completion (keywords, in-scope bindings, module symbols, members after `.`, import path strings, auto-import)
- Document symbols
- Semantic tokens (full document)
