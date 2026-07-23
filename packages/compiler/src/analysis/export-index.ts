import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import type { Program } from "../ast/nodes.js";
import { DiagnosticCollector } from "../diagnostics/diagnostic.js";
import { Lexer } from "../lexer/lexer.js";
import { getStdRootPath, moduleIdForStdPath } from "../modules/resolve.js";
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

const STD_PUBLIC_MODULES = ["math", "collections", "random"] as const;

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
  return (
    stdSpecifierForPath(targetPath) ??
    relativeSpecifier(importerPath, targetPath)
  );
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
  const moduleSpecifier = specifierFor(importerPath, absolutePath);
  collectExportsFromAst(ast, absolutePath, moduleSpecifier, out);
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

  return out;
}
