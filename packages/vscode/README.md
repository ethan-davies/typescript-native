# Sonite — VS Code / Cursor

Language support for **Sonite** (`.sn`).

## Features

- Syntax highlighting (TextMate grammar, `source.sn`)
- Editor language configuration (comments, brackets, auto-closing pairs)
- Language server: diagnostics, hover, go-to-definition, completion, document symbols

## Use in Cursor / VS Code (required)

Having this package in the monorepo does **not** load it automatically. Pick one:

### A) Extension Development Host (recommended while developing)

1. From the repo root, build:

```bash
pnpm --filter @sonite/compiler build
pnpm --filter @sonite/lsp build
pnpm --filter sonite-vscode build
```

2. Run **Launch SN Extension** from the Run and Debug view (F5).
3. In the new window, open a `.sn` file (e.g. `examples/modules/alias.sn`).
4. Check the status bar language mode says **Sonite**, then:
   - Hover a variable
   - Press **Ctrl+Space** for completions (also triggers while typing)
   - Open **Output → Sonite** for server logs

### B) Install into your normal Cursor window

Command Palette → **Developer: Install Extension from Location…** → select `packages/vscode`.

Rebuild after LSP/extension changes, then **Developer: Reload Window**.

## Troubleshooting

- No squiggles / no hover → extension not active in this window (use A or B above).
- Output channel shows resolve/start errors → rebuild compiler + lsp, then reload.
- Completions feel missing → press **Ctrl+Space**; member completions also trigger after `.`.
