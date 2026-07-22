import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { DiagnosticCollector } from "../diagnostics/diagnostic.js";
import type { ModuleImportBinding, ReadFileFn, ResolvedModule } from "./resolve.js";
import { resolveModules } from "./resolve.js";

export type PreludePathsFn = () => readonly string[];

let preludePathsProvider: PreludePathsFn | null = null;

/** Injected by the compiler package after optional `@typescript-native/std` resolve. */
export function setPreludePathsProvider(provider: PreludePathsFn | null): void {
  preludePathsProvider = provider;
}

export function getPreludeModulePaths(): readonly string[] {
  if (!preludePathsProvider) {
    return [];
  }
  try {
    return preludePathsProvider();
  } catch {
    return [];
  }
}

/**
 * Load prelude modules and attach synthetic named-import bindings so every user
 * module sees prelude exports as local names / extension methods.
 *
 * Prelude files are always read from the real filesystem (not the optional
 * compileFile readFile override), so virtual test filesystems still get the stdlib.
 */
export function loadPreludeModules(
  diagnostics: DiagnosticCollector,
  _readFile?: ReadFileFn,
): ResolvedModule[] {
  const paths = getPreludeModulePaths();
  if (paths.length === 0) {
    return [];
  }

  const readPrelude: ReadFileFn = (p) => readFileSync(p, "utf8");
  const loaded: ResolvedModule[] = [];
  for (const preludePath of paths) {
    const result = resolveModules(preludePath, readPrelude, diagnostics);
    if (!result.success) {
      continue;
    }
    for (const mod of result.modules) {
      if (!loaded.some((m) => m.path === mod.path)) {
        const base = basename(mod.path, ".tsn");
        const moduleId = mod.path.includes("prelude")
          ? `std_prelude_${base}`
          : mod.moduleId;
        // Prelude modules are never the program entry.
        loaded.push({ ...mod, isEntry: false, moduleId });
      }
    }
  }
  return loaded;
}

/** Build named-import bindings that pull every export from prelude modules into a user module. */
export function preludeImportBindings(
  preludeModules: readonly ResolvedModule[],
  userModulePath: string,
): ModuleImportBinding[] {
  const bindings: ModuleImportBinding[] = [];
  const span = {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 1, offset: 0 },
  };

  for (const mod of preludeModules) {
    if (mod.path === userModulePath) {
      continue;
    }
    const base = basename(mod.path, ".tsn");
    for (const decl of mod.ast.body) {
      if (
        !(
          decl.kind === "FunctionDeclaration" ||
          decl.kind === "StructDeclaration" ||
          decl.kind === "EnumDeclaration" ||
          decl.kind === "ClassDeclaration" ||
          decl.kind === "InterfaceDeclaration" ||
          decl.kind === "TypeAliasDeclaration"
        ) ||
        !decl.exported
      ) {
        continue;
      }

      // Extension methods may share names across prelude files (e.g. string/array
      // `indexOf`). Bind them under unique locals so both stay in the extension
      // registry; resolution still uses the original export name via the sig.
      const isExtension =
        decl.kind === "FunctionDeclaration" && decl.params[0]?.isReceiver === true;
      const localName = isExtension
        ? `__prelude_ext_${base}_${decl.name.name}`
        : decl.name.name;

      bindings.push({
        kind: "named",
        exportName: decl.name.name,
        localName,
        modulePath: mod.path,
        specifier: `std/prelude/${base}`,
        span,
      });
    }
  }
  return bindings;
}

/**
 * Merge prelude modules into a compilation unit and inject prelude imports into
 * every non-prelude module (and the synthetic single-file module).
 */
export function attachPrelude(
  userModules: readonly ResolvedModule[],
  diagnostics: DiagnosticCollector,
  readFile?: ReadFileFn,
): ResolvedModule[] {
  const prelude = loadPreludeModules(diagnostics, readFile);
  if (prelude.length === 0) {
    return [...userModules];
  }

  const preludePaths = new Set(prelude.map((m) => m.path));
  const merged: ResolvedModule[] = [];
  const seen = new Set<string>();

  for (const mod of prelude) {
    if (!seen.has(mod.path)) {
      merged.push(mod);
      seen.add(mod.path);
    }
  }

  for (const mod of userModules) {
    if (seen.has(mod.path)) {
      continue;
    }
    if (preludePaths.has(mod.path)) {
      merged.push(mod);
      seen.add(mod.path);
      continue;
    }
    const extraImports = preludeImportBindings(prelude, mod.path);
    const userLocals = new Set<string>();
    for (const binding of mod.imports) {
      if (binding.kind === "named") {
        userLocals.add(binding.localName);
      } else {
        userLocals.add(binding.alias);
      }
    }
    for (const decl of mod.ast.body) {
      if (
        decl.kind === "FunctionDeclaration" ||
        decl.kind === "StructDeclaration" ||
        decl.kind === "EnumDeclaration" ||
        decl.kind === "ClassDeclaration" ||
        decl.kind === "InterfaceDeclaration" ||
        decl.kind === "TypeAliasDeclaration"
      ) {
        userLocals.add(decl.name.name);
      }
    }
    // User locals shadow prelude APIs by export name (e.g. a local `sort`).
    // Extension bindings use unique locals so string/array `indexOf` can coexist.
    const filtered = extraImports.filter(
      (b) =>
        b.kind === "named" &&
        !userLocals.has(b.exportName) &&
        !userLocals.has(b.localName),
    );
    merged.push({
      ...mod,
      imports: [...mod.imports, ...filtered],
    });
    seen.add(mod.path);
  }

  return merged;
}
