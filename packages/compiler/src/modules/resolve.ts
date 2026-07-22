import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { ImportDeclaration, Program } from "../ast/nodes.js";
import type { DiagnosticCollector, SourceSpan } from "../diagnostics/diagnostic.js";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { moduleIdFromPath } from "./mangle.js";

export type ReadFileFn = (absolutePath: string) => string;

export type ModuleImportBinding =
  | {
      readonly kind: "namespace";
      readonly alias: string;
      readonly modulePath: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "named";
      readonly exportName: string;
      readonly localName: string;
      readonly modulePath: string;
      /** Original import specifier string for diagnostics. */
      readonly specifier: string;
      readonly span: SourceSpan;
    };

export interface ResolvedModule {
  readonly path: string;
  readonly source: string;
  readonly ast: Program;
  /** File basename without `.tsn`; used for LLVM mangling. */
  readonly moduleId: string;
  readonly isEntry: boolean;
  /** Namespace and named bindings declared by this module's imports. */
  readonly imports: readonly ModuleImportBinding[];
}

export interface ResolveResult {
  readonly modules: readonly ResolvedModule[];
  readonly success: boolean;
}

export type StdRootProvider = () => string | null;

let stdRootProvider: StdRootProvider | null = null;

/** Provide the absolute path to `packages/std/src` (or null if unavailable). */
export function setStdRootProvider(provider: StdRootProvider | null): void {
  stdRootProvider = provider;
}

export function getStdRootPath(): string | null {
  return stdRootProvider?.() ?? null;
}

function isStdSpecifier(specifier: string): boolean {
  const spec = specifier.trim();
  return spec === "std" || spec.startsWith("std/");
}

/**
 * Resolve a `std/...` specifier against the standard-library root.
 * Tries `std/math` → `$STD/math.tsn` then `$STD/math/index.tsn`.
 */
export function resolveStdSpecifier(specifier: string): string | null {
  const root = getStdRootPath();
  if (!root) {
    return null;
  }
  let rest = specifier.trim();
  if (rest === "std") {
    rest = "";
  } else if (rest.startsWith("std/")) {
    rest = rest.slice(4);
  } else {
    return null;
  }
  if (rest.toLowerCase().endsWith(".tsn")) {
    rest = rest.slice(0, -4);
  }

  if (rest === "") {
    const indexPath = join(root, "index.tsn");
    return existsSync(indexPath) ? indexPath : null;
  }

  const direct = join(root, `${rest}.tsn`);
  if (existsSync(direct)) {
    return direct;
  }
  const indexPath = join(root, rest, "index.tsn");
  if (existsSync(indexPath)) {
    return indexPath;
  }
  return direct;
}

/**
 * Stable mangling id for std modules, e.g. `math/index.tsn` → `std_math`.
 */
export function moduleIdForStdPath(absolutePath: string): string | null {
  const root = getStdRootPath();
  if (!root) {
    return null;
  }
  const normalized = absolutePath.replace(/\\/g, "/");
  const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normalized.startsWith(`${rootNorm}/`) && normalized !== rootNorm) {
    return null;
  }
  let rel = normalized.slice(rootNorm.length + 1);
  if (rel.toLowerCase().endsWith(".tsn")) {
    rel = rel.slice(0, -4);
  }
  if (rel.endsWith("/index")) {
    rel = rel.slice(0, -"/index".length);
  }
  if (rel === "" || rel === "index") {
    return "std";
  }
  return `std_${rel.replace(/\//g, "_")}`;
}

/**
 * Normalize an import specifier to an absolute `.tsn` path.
 * Accepts `"math"`, `"./math"`, `"math.tsn"`, `"./math.tsn"`, `"math/vector"`,
 * and `"std/math"` (resolved against the standard library root).
 */
export function resolveImportSpecifier(importerDir: string, specifier: string): string {
  if (isStdSpecifier(specifier)) {
    const stdPath = resolveStdSpecifier(specifier);
    if (stdPath) {
      return stdPath;
    }
    let rest = specifier.trim();
    if (rest.startsWith("std/")) {
      rest = rest.slice(4);
    }
    if (rest.toLowerCase().endsWith(".tsn")) {
      rest = rest.slice(0, -4);
    }
    const root = getStdRootPath() ?? resolvePath(importerDir, "std");
    return resolvePath(root, `${rest || "index"}.tsn`);
  }

  let spec = specifier.trim();
  if (spec.startsWith("./")) {
    spec = spec.slice(2);
  }
  if (spec.toLowerCase().endsWith(".tsn")) {
    spec = spec.slice(0, -4);
  }
  return resolvePath(importerDir, `${spec}.tsn`);
}

function defaultNamespaceFromPath(absolutePath: string): string {
  const stdId = moduleIdForStdPath(absolutePath);
  if (stdId) {
    const parts = stdId.replace(/^std_/, "").split("_");
    return parts[parts.length - 1] || "std";
  }
  return moduleIdFromPath(absolutePath);
}

/**
 * Load the entry file and transitively resolve all imports into a compilation unit.
 * Modules are returned with the entry first, then dependencies in discovery order.
 */
export function resolveModules(
  entryPath: string,
  readFile: ReadFileFn,
  diagnostics: DiagnosticCollector,
): ResolveResult {
  const absoluteEntry = resolvePath(entryPath);
  const parsed = new Map<string, ResolvedModule>();
  const visiting = new Set<string>();
  const order: string[] = [];

  function readModuleSource(absolutePath: string, preferRealFs: boolean): string {
    if (preferRealFs || moduleIdForStdPath(absolutePath) !== null) {
      return readFileSync(absolutePath, "utf8");
    }
    return readFile(absolutePath);
  }

  function visit(absolutePath: string, isEntry: boolean): boolean {
    if (parsed.has(absolutePath)) {
      return true;
    }
    if (visiting.has(absolutePath)) {
      diagnostics.error(
        `Circular import detected involving '${absolutePath}'`,
        { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
        "E0403",
      );
      return false;
    }

    visiting.add(absolutePath);

    const isStdModule = moduleIdForStdPath(absolutePath) !== null;
    let source: string;
    try {
      source = readModuleSource(absolutePath, isStdModule);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.error(
        `Failed to read module '${absolutePath}': ${message}`,
        { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
        "E0401",
      );
      visiting.delete(absolutePath);
      return false;
    }

    const fileName = absolutePath.replace(/\\/g, "/").split("/").pop() ?? absolutePath;
    const lexer = new Lexer(source, diagnostics);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens, diagnostics);
    const ast = parser.parse();

    void fileName;

    const importDecls = ast.body.filter(
      (d): d is ImportDeclaration => d.kind === "ImportDeclaration",
    );
    const bindings: ModuleImportBinding[] = [];
    const seenLocalNames = new Set<string>();
    const importerDir = dirname(absolutePath);
    let ok = true;

    for (const decl of importDecls) {
      const resolved = resolveImportSpecifier(importerDir, decl.source.value);
      const stdImport = isStdSpecifier(decl.source.value);

      try {
        if (stdImport || moduleIdForStdPath(resolved) !== null) {
          if (!existsSync(resolved)) {
            throw new Error("ENOENT");
          }
        } else {
          readFile(resolved);
        }
      } catch {
        diagnostics.error(
          `Cannot resolve module '${decl.source.value}' (looked for '${resolved}')`,
          decl.source.span,
          "E0401",
        );
        ok = false;
        continue;
      }

      if (!visit(resolved, false)) {
        ok = false;
        continue;
      }

      if (decl.clause.kind === "NamespaceImport") {
        const alias = decl.clause.localName?.name ?? defaultNamespaceFromPath(resolved);
        const span = decl.clause.localName?.span ?? decl.source.span;

        if (seenLocalNames.has(alias)) {
          diagnostics.error(`Duplicate import binding '${alias}'`, span, "E0404");
          ok = false;
          continue;
        }
        seenLocalNames.add(alias);

        bindings.push({
          kind: "namespace",
          alias,
          modulePath: resolved,
          span: decl.span,
        });
      } else {
        for (const spec of decl.clause.specifiers) {
          if (seenLocalNames.has(spec.localName.name)) {
            diagnostics.error(
              `Duplicate import binding '${spec.localName.name}'`,
              spec.localName.span,
              "E0404",
            );
            ok = false;
            continue;
          }
          seenLocalNames.add(spec.localName.name);

          bindings.push({
            kind: "named",
            exportName: spec.importedName.name,
            localName: spec.localName.name,
            modulePath: resolved,
            specifier: decl.source.value,
            span: spec.span,
          });
        }
      }
    }

    visiting.delete(absolutePath);

    const module: ResolvedModule = {
      path: absolutePath,
      source,
      ast,
      moduleId: moduleIdForStdPath(absolutePath) ?? moduleIdFromPath(absolutePath),
      isEntry,
      imports: bindings,
    };
    parsed.set(absolutePath, module);
    order.push(absolutePath);
    return ok;
  }

  const success = visit(absoluteEntry, true) && !diagnostics.hasErrors;

  const modules = order
    .map((p) => parsed.get(p)!)
    .sort((a, b) => {
      if (a.isEntry) return -1;
      if (b.isEntry) return 1;
      return 0;
    });

  return { modules, success };
}
