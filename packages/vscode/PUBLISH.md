# Publishing the Sonite VS Code extension

This package ships a self-contained VSIX: the extension host, a bundled
`dist/server.js` language server, and a copied `stdlib/` tree. The `sn` CLI is
**not** required for IDE features.

## Prerequisites

1. A [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage)
   publisher named `sonite` (or update `publisher` in `package.json`).
2. A Personal Access Token with Marketplace publish scope.
3. From the repo root, dependencies installed (`pnpm install`).

## Build a VSIX locally

```bash
pnpm --filter @sonite/compiler build
pnpm --filter @sonite/std build
pnpm --filter sonite-vscode package
```

This runs the esbuild bundle and `vsce package --no-dependencies`, producing
`packages/vscode/sonite-vscode-<version>.vsix`.

Smoke-test:

```bash
# VS Code / Cursor: Extensions → … → Install from VSIX…
code --install-extension packages/vscode/sonite-vscode-0.1.0.vsix
```

Open a `.sn` file and confirm Output → Sonite shows the server starting.

## Publish to the Marketplace

```bash
cd packages/vscode
# One-time login (stores the token for vsce):
npx vsce login sonite

# Publish the current version:
npx vsce publish
```

Or publish an already-built VSIX:

```bash
npx vsce publish --packagePath sonite-vscode-0.1.0.vsix
```

## Open VSX (optional)

```bash
npx ovsx publish sonite-vscode-0.1.0.vsix -p <open-vsx-token>
```

## Version bumps

1. Update `version` in `packages/vscode/package.json`.
2. Add a section to `CHANGELOG.md`.
3. Run `pnpm --filter sonite-vscode package` and publish.
