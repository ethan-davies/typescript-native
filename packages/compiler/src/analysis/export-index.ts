import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import type { Program } from "../ast/nodes.js";
import { DiagnosticCollector } from "../diagnostics/diagnostic.js";
import { Lexer } from "../lexer/lexer.js";
import {
  getPackageRoots,
  getStdRootPath,
  moduleIdForPackagePath,
  moduleIdForStdPath,
  resolveImportSpecifier,
  type PackageRootInfo,
} from "../modules/resolve.js";
import { Parser } from "../parser/parser.js";
import type { CompletionSymbolKind } from "./semantic.js";
import type { ExportIndexEntry } from "./query.js";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "target",
  "out",
  ".turbo",
]);

const STD_PUBLIC_MODULES = [
  "math",
  "collections",
  "random",
  "io",
  "fs",
  "process",
  "time",
  "encoding",
] as const;

export interface BuildExportIndexOptions {
  /** Absolute workspace roots to scan for `.sn` files. */
  readonly workspaceRoots?: readonly string[];
  /** Absolute path of the file receiving completions (for relative specifiers). */
  readonly importerPath: string;
  /** Optional overlay for open editor buffers. */
  readonly readFile?: (absolutePath: string) => string;
}

function parseProgram(source: string, fileName: string): Program | null {
  const diagnostics = new DiagnosticCollector();
  diagnostics.setFile(fileName);
  try {
    const lexer = new Lexer(source, diagnostics);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens, diagnostics);
    const ast = parser.parse();
    // Soft-fail: still index exports even if there are parse errors later in the file.
    return ast;
  } catch {
    return null;
  }
}

function collectExportsFromAst(
  ast: Program,
  modulePath: string,
  moduleSpecifier: string,
  out: ExportIndexEntry[],
  seen: Set<string>,
  readFile?: (absolutePath: string) => string,
  importerPath?: string,
): void {
  for (const decl of ast.body) {
    let name: string | null = null;
    let kind: CompletionSymbolKind | null = null;
    let exported = false;
    let isExtension = false;

    switch (decl.kind) {
      case "FunctionDeclaration":
        exported = decl.exported;
        name = decl.name.name;
        kind = "function";
        isExtension = decl.params[0]?.isReceiver === true;
        break;
      case "StructDeclaration":
        exported = decl.exported;
        name = decl.name.name;
        kind = "struct";
        break;
      case "ClassDeclaration":
        exported = decl.exported;
        name = decl.name.name;
        kind = "class";
        break;
      case "InterfaceDeclaration":
        exported = decl.exported;
        name = decl.name.name;
        kind = "interface";
        break;
      case "EnumDeclaration":
        exported = decl.exported;
        name = decl.name.name;
        kind = "enum";
        break;
      case "TypeAliasDeclaration":
        exported = decl.exported;
        name = decl.name.name;
        kind = "type";
        break;
      case "ModuleVariableDeclaration":
        exported = decl.exported;
        name = decl.name.name;
        kind = "variable";
        break;
      case "ExportNamedFromDeclaration":
        for (const spec of decl.specifiers) {
          out.push({
            name: spec.exportName.name,
            exportName: spec.exportName.name,
            kind: "function",
            moduleSpecifier,
            modulePath,
          });
        }
        continue;
      case "ExportAllFromDeclaration": {
        // Resolve and index the source module's exports under this specifier.
        try {
          const resolved = resolveImportSpecifier(
            dirname(modulePath),
            decl.source.value,
          );
          if (resolved && !seen.has(resolved.replace(/\\/g, "/"))) {
            indexFile(
              resolved,
              importerPath ?? modulePath,
              out,
              seen,
              readFile,
              moduleSpecifier,
            );
          }
        } catch {
          // ignore
        }
        continue;
      }
      default:
        break;
    }

    if (!exported || !name || !kind || isExtension) {
      continue;
    }
    out.push({
      name,
      exportName: name,
      kind,
      moduleSpecifier,
      modulePath,
    });
  }
}

function stdSpecifierForPath(absolutePath: string): string | null {
  const root = getStdRootPath();
  if (!root) {
    return null;
  }
  if (moduleIdForStdPath(absolutePath) === null) {
    return null;
  }
  const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
  let rel = absolutePath.replace(/\\/g, "/");
  if (!rel.startsWith(`${rootNorm}/`)) {
    return null;
  }
  rel = rel.slice(rootNorm.length + 1);
  if (rel.toLowerCase().endsWith(".sn")) {
    rel = rel.slice(0, -".sn".length);
  }
  if (rel.endsWith("/index")) {
    rel = rel.slice(0, -"/index".length);
  }
  if (rel === "" || rel === "index") {
    return "std";
  }
  return `std/${rel}`;
}

function relativeSpecifier(importerPath: string, targetPath: string): string {
  let rel = relative(dirname(importerPath), targetPath).replace(/\\/g, "/");
  if (rel.toLowerCase().endsWith(".sn")) {
    rel = rel.slice(0, -".sn".length);
  }
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

function specifierFor(importerPath: string, targetPath: string): string {
  const std = stdSpecifierForPath(targetPath);
  if (std) {
    return std;
  }
  const pkg = packageSpecifierForPath(targetPath);
  if (pkg) {
    return pkg;
  }
  return relativeSpecifier(importerPath, targetPath);
}

function packageSpecifierForPath(absolutePath: string): string | null {
  const roots = getPackageRoots();
  if (!roots) {
    return null;
  }
  const normalized = absolutePath.replace(/\\/g, "/");
  for (const [name, value] of roots) {
    const dir =
      typeof value === "string" ? value : (value as PackageRootInfo).dir;
    const rootNorm = dir.replace(/\\/g, "/").replace(/\/$/, "");
    if (!normalized.startsWith(`${rootNorm}/`) && normalized !== rootNorm) {
      continue;
    }
    if (moduleIdForPackagePath(absolutePath) === null) {
      continue;
    }
    let rel = normalized.slice(rootNorm.length + 1);
    if (rel.toLowerCase().endsWith(".sn")) {
      rel = rel.slice(0, -".sn".length);
    }
    if (rel.endsWith("/index")) {
      rel = rel.slice(0, -"/index".length);
    }
    if (
      rel === "" ||
      rel === "index" ||
      rel === "main" ||
      rel === "src/main"
    ) {
      return name;
    }
    return `${name}/${rel}`;
  }
  return null;
}

function walkSnFiles(root: string, out: string[]): void {
  if (!existsSync(root)) {
    return;
  }
  const st = statSync(root);
  if (st.isFile()) {
    if (root.toLowerCase().endsWith(".sn")) {
      out.push(resolvePath(root));
    }
    return;
  }
  if (!st.isDirectory()) {
    return;
  }
  for (const entry of readdirSync(root)) {
    if (SKIP_DIR_NAMES.has(entry)) {
      continue;
    }
    const full = join(root, entry);
    let childStat;
    try {
      childStat = statSync(full);
    } catch {
      continue;
    }
    if (childStat.isDirectory()) {
      walkSnFiles(full, out);
    } else if (childStat.isFile() && entry.toLowerCase().endsWith(".sn")) {
      out.push(resolvePath(full));
    }
  }
}

function readSource(
  absolutePath: string,
  readFile?: (absolutePath: string) => string,
): string | null {
  try {
    if (readFile) {
      return readFile(absolutePath);
    }
    return readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
}

function indexFile(
  absolutePath: string,
  importerPath: string,
  out: ExportIndexEntry[],
  seen: Set<string>,
  readFile?: (absolutePath: string) => string,
  /** Override the module specifier attributed to exports (for re-export barrels). */
  forceSpecifier?: string,
): void {
  const key = absolutePath.replace(/\\/g, "/");
  if (seen.has(key)) {
    return;
  }
  seen.add(key);

  // Skip prelude — extension methods are not free auto-import targets.
  const stdSpec = stdSpecifierForPath(absolutePath);
  if (stdSpec?.startsWith("std/prelude")) {
    return;
  }

  const source = readSource(absolutePath, readFile);
  if (source === null) {
    return;
  }
  const ast = parseProgram(source, absolutePath);
  if (!ast) {
    return;
  }
  const moduleSpecifier =
    forceSpecifier ?? specifierFor(importerPath, absolutePath);
  collectExportsFromAst(
    ast,
    absolutePath,
    moduleSpecifier,
    out,
    seen,
    readFile,
    importerPath,
  );
}

/**
 * Build an export index for auto-import completions from public std modules
 * and workspace `.sn` files.
 */
export function buildExportIndex(
  options: BuildExportIndexOptions,
): ExportIndexEntry[] {
  const out: ExportIndexEntry[] = [];
  const seen = new Set<string>();
  const importerPath = resolvePath(options.importerPath);

  const stdRoot = getStdRootPath();
  if (stdRoot) {
    for (const name of STD_PUBLIC_MODULES) {
      const direct = join(stdRoot, `${name}.sn`);
      const indexPath = join(stdRoot, name, "index.sn");
      const path = existsSync(direct)
        ? direct
        : existsSync(indexPath)
          ? indexPath
          : null;
      if (path) {
        indexFile(path, importerPath, out, seen, options.readFile);
      }
    }
  }

  for (const root of options.workspaceRoots ?? []) {
    const files: string[] = [];
    walkSnFiles(resolvePath(root), files);
    for (const file of files) {
      // Avoid double-indexing std if the workspace contains packages/std.
      if (stdSpecifierForPath(file)) {
        continue;
      }
      indexFile(file, importerPath, out, seen, options.readFile);
    }
  }

  const packageRoots = getPackageRoots();
  if (packageRoots) {
    for (const [, value] of packageRoots) {
      const dir =
        typeof value === "string" ? value : (value as PackageRootInfo).dir;
      const files: string[] = [];
      walkSnFiles(resolvePath(dir), files);
      for (const file of files) {
        indexFile(file, importerPath, out, seen, options.readFile);
      }
    }
  }

  return out;
}

/**
 * Suggest import module path completions for the partial specifier inside quotes.
 */
export function completeImportPaths(
  importerPath: string,
  partialSpecifier: string,
  workspaceRoots: readonly string[] = [],
): string[] {
  const suggestions = new Set<string>();
  const partial = partialSpecifier;

  if (partial.startsWith("./") || partial.startsWith("../") || partial === "." || partial === "..") {
    const baseDir = dirname(resolvePath(importerPath));
    // Resolve the directory prefix of the partial path.
    let dirPart = partial;
    let namePrefix = "";
    const lastSlash = partial.lastIndexOf("/");
    if (lastSlash >= 0) {
      dirPart = partial.slice(0, lastSlash + 1);
      namePrefix = partial.slice(lastSlash + 1);
    } else {
      dirPart = "./";
      namePrefix = partial.replace(/^\.\//, "");
    }
    const absDir = resolvePath(baseDir, dirPart);
    if (existsSync(absDir) && statSync(absDir).isDirectory()) {
      for (const entry of readdirSync(absDir)) {
        if (SKIP_DIR_NAMES.has(entry)) {
          continue;
        }
        if (namePrefix && !entry.startsWith(namePrefix) && !entry.startsWith(namePrefix.replace(/\.sn$/, ""))) {
          continue;
        }
        const full = join(absDir, entry);
        let childStat;
        try {
          childStat = statSync(full);
        } catch {
          continue;
        }
        if (childStat.isDirectory()) {
          suggestions.add(`${dirPart}${entry}/`);
          if (existsSync(join(full, "index.sn"))) {
            suggestions.add(`${dirPart}${entry}`);
          }
        } else if (entry.toLowerCase().endsWith(".sn")) {
          const withoutExt = entry.slice(0, -".sn".length);
          suggestions.add(`${dirPart}${withoutExt}`);
        }
      }
    }
  } else if (partial === "std" || partial.startsWith("std/")) {
    const stdRoot = getStdRootPath();
    if (stdRoot) {
      for (const name of STD_PUBLIC_MODULES) {
        const spec = `std/${name}`;
        if (spec.startsWith(partial) || partial === "std") {
          suggestions.add(spec);
        }
      }
      if ("std".startsWith(partial) || partial === "") {
        suggestions.add("std");
      }
    }
  } else {
    // Package names / subpaths
    const roots = getPackageRoots();
    if (roots) {
      for (const [name, value] of roots) {
        if (name.startsWith(partial) || partial === "") {
          suggestions.add(name);
        }
        if (partial === name || partial.startsWith(`${name}/`)) {
          const dir =
            typeof value === "string" ? value : (value as PackageRootInfo).dir;
          const rest = partial.slice(name.length + 1);
          const subDir = rest.includes("/")
            ? join(dir, rest.slice(0, rest.lastIndexOf("/")))
            : dir;
          const namePrefix = rest.includes("/")
            ? rest.slice(rest.lastIndexOf("/") + 1)
            : rest;
          if (existsSync(subDir) && statSync(subDir).isDirectory()) {
            for (const entry of readdirSync(subDir)) {
              if (namePrefix && !entry.startsWith(namePrefix)) {
                continue;
              }
              const full = join(subDir, entry);
              try {
                const st = statSync(full);
                const prefix = rest.includes("/")
                  ? `${name}/${rest.slice(0, rest.lastIndexOf("/") + 1)}`
                  : `${name}/`;
                if (st.isDirectory()) {
                  suggestions.add(`${prefix}${entry}`);
                } else if (entry.toLowerCase().endsWith(".sn")) {
                  suggestions.add(`${prefix}${entry.slice(0, -".sn".length)}`);
                }
              } catch {
                // skip
              }
            }
          }
        }
      }
    }
    // Also suggest relative from workspace when typing a bare name prefix? No —
    // bare names are packages only.
    void workspaceRoots;
  }

  return [...suggestions].sort();
}
