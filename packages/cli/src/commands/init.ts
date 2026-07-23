import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DEFAULT_MAIN = `function main(): void {
  print("Hello, world!");
}
`;

const DEFAULT_GITIGNORE = `dist/
.sn/
*.ll
`;

export interface InitOptions {
  readonly directory: string;
  readonly force: boolean;
  readonly name?: string;
}

export function runInit(options: InitOptions): number {
  const dir = resolve(options.directory);
  mkdirSync(dir, { recursive: true });

  const name = options.name ?? basename(dir);
  const manifestPath = join(dir, "project.toml");
  const srcDir = join(dir, "src");
  const mainPath = join(srcDir, "main.sn");
  const gitignorePath = join(dir, ".gitignore");

  if (!options.force) {
    for (const path of [manifestPath, mainPath]) {
      if (existsSync(path)) {
        console.error(
          `error: ${path} already exists (pass --force to overwrite)`,
        );
        return 1;
      }
    }
  }

  const manifest = `[package]
name = ${tomlString(name)}
version = "0.1.0"
description = ""
license = "MIT"
authors = []
entry = "src/main.sn"

[build]
outdir = "dist"
`;

  mkdirSync(srcDir, { recursive: true });
  writeFileSync(manifestPath, manifest, "utf8");
  writeFileSync(mainPath, DEFAULT_MAIN, "utf8");
  if (!existsSync(gitignorePath) || options.force) {
    writeFileSync(gitignorePath, DEFAULT_GITIGNORE, "utf8");
  }

  console.log(`created project '${name}' in ${dir}`);
  console.log(`  ${manifestPath}`);
  console.log(`  ${mainPath}`);
  return 0;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
