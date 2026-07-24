#!/usr/bin/env node
/**
 * Bundle the VS Code extension + language server for Marketplace packaging.
 * Copies the Sonite standard library beside the bundled server.
 */
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const repoRoot = join(pkgRoot, "..", "..");
const dist = join(pkgRoot, "dist");
const stdSrc = join(repoRoot, "packages", "std", "src");
const stdlibOut = join(pkgRoot, "stdlib");

async function main() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  await esbuild.build({
    entryPoints: [join(pkgRoot, "src", "extension.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(dist, "extension.js"),
    external: ["vscode"],
    sourcemap: true,
    logLevel: "info",
  });

  await esbuild.build({
    entryPoints: [join(repoRoot, "packages", "lsp", "src", "server.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(dist, "server.js"),
    sourcemap: true,
    logLevel: "info",
    // vscode-languageserver and node builtins are bundled / marked external as needed
    banner: {
      js: "var __sonite_import_meta_url = require('url').pathToFileURL(__filename).href;",
    },
    define: {
      "import.meta.url": "__sonite_import_meta_url",
    },
  });

  if (!existsSync(stdSrc)) {
    throw new Error(`Standard library not found at ${stdSrc}`);
  }
  rmSync(stdlibOut, { recursive: true, force: true });
  cpSync(stdSrc, stdlibOut, { recursive: true });
  console.log("Bundled extension, server, and stdlib.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
