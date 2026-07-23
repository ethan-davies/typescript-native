import type {
  ExportAllFromDeclaration,
  ExportNamedFromDeclaration,
  Program,
  TopLevelDeclaration,
} from "../ast/nodes.js";
import type {
  DiagnosticCollector,
  SourceSpan,
} from "../diagnostics/diagnostic.js";

export type ExportKind =
  | "function"
  | "struct"
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "value";

/**
 * Formal export table entry — the authoritative source for import validation.
 */
export interface ExportEntry {
  readonly name: string;
  readonly kind: ExportKind;
  /** Path of the module that originally declared the symbol. */
  readonly sourceModulePath: string;
  /** Local name in the defining module (before any re-export rename). */
  readonly originalName: string;
  readonly span: SourceSpan;
}

export type ExportTable = ReadonlyMap<string, ExportEntry>;

export interface ModuleForExports {
  readonly path: string;
  readonly ast: Program;
  /** Absolute paths of modules referenced by re-exports. */
  readonly reexportSources: readonly {
    readonly specifier: string;
    readonly path: string;
    readonly span: SourceSpan;
    readonly kind: "named" | "all";
    readonly decl: ExportNamedFromDeclaration | ExportAllFromDeclaration;
  }[];
}

function kindFromDecl(decl: TopLevelDeclaration): ExportKind | null {
  switch (decl.kind) {
    case "FunctionDeclaration":
      return "function";
    case "StructDeclaration":
      return "struct";
    case "ClassDeclaration":
      return "class";
    case "InterfaceDeclaration":
      return "interface";
    case "EnumDeclaration":
      return "enum";
    case "TypeAliasDeclaration":
      return "type";
    case "ModuleVariableDeclaration":
      return "value";
    default:
      return null;
  }
}

function localExportEntries(
  mod: ModuleForExports,
  diagnostics: DiagnosticCollector,
): { entries: Map<string, ExportEntry>; privateNames: Set<string> } {
  const entries = new Map<string, ExportEntry>();
  const privateNames = new Set<string>();
  const seenExported = new Map<string, SourceSpan>();

  for (const decl of mod.ast.body) {
    const kind = kindFromDecl(decl);
    if (
      kind === null ||
      !(
        decl.kind === "FunctionDeclaration" ||
        decl.kind === "StructDeclaration" ||
        decl.kind === "EnumDeclaration" ||
        decl.kind === "ClassDeclaration" ||
        decl.kind === "InterfaceDeclaration" ||
        decl.kind === "TypeAliasDeclaration" ||
        decl.kind === "ModuleVariableDeclaration"
      )
    ) {
      continue;
    }

    const name = decl.name.name;
    if (!decl.exported) {
      privateNames.add(name);
      continue;
    }

    const prev = seenExported.get(name);
    if (prev) {
      diagnostics.error(
        `Module exports "${name}" more than once.`,
        decl.name.span,
        "E0413",
      );
      continue;
    }
    seenExported.set(name, decl.name.span);
    entries.set(name, {
      name,
      kind,
      sourceModulePath: mod.path,
      originalName: name,
      span: decl.name.span,
    });
  }

  return { entries, privateNames };
}

/**
 * Build formal export tables for every module, resolving re-exports.
 * Detects re-export cycles and duplicate export names.
 */
export function buildExportTables(
  modules: readonly ModuleForExports[],
  diagnostics: DiagnosticCollector,
): Map<string, ExportTable> {
  const byPath = new Map(modules.map((m) => [m.path, m]));
  const visiting = new Set<string>();
  const visitStack: string[] = [];
  const pathToTable = new Map<string, Map<string, ExportEntry>>();
  const result = new Map<string, ExportTable>();

  function buildOne(modulePath: string): Map<string, ExportEntry> {
    const cached = pathToTable.get(modulePath);
    if (cached) {
      return cached;
    }
    if (visiting.has(modulePath)) {
      const start = visitStack.indexOf(modulePath);
      const cycle =
        start >= 0
          ? [...visitStack.slice(start), modulePath]
          : [modulePath];
      diagnostics.setFile(modulePath);
      diagnostics.error(
        `Circular re-export detected: ${cycle.join(" → ")}`,
        {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
        "E0412",
      );
      const empty = new Map<string, ExportEntry>();
      pathToTable.set(modulePath, empty);
      return empty;
    }

    const mod = byPath.get(modulePath);
    if (!mod) {
      const empty = new Map<string, ExportEntry>();
      pathToTable.set(modulePath, empty);
      return empty;
    }

    visiting.add(modulePath);
    visitStack.push(modulePath);
    diagnostics.setFile(modulePath);

    const { entries, privateNames } = localExportEntries(mod, diagnostics);

    for (const re of mod.reexportSources) {
      const sourceTable = buildOne(re.path);

      if (re.kind === "named" && re.decl.kind === "ExportNamedFromDeclaration") {
        for (const spec of re.decl.specifiers) {
          const sourceEntry = sourceTable.get(spec.importedName.name);
          if (!sourceEntry) {
            diagnostics.error(
              `Module "${re.specifier}" does not export "${spec.importedName.name}".`,
              spec.importedName.span,
              "E0408",
            );
            continue;
          }
          const exportName = spec.exportName.name;
          if (entries.has(exportName)) {
            diagnostics.error(
              `Re-exported symbol "${exportName}" conflicts with another export.`,
              spec.exportName.span,
              "E0414",
            );
            continue;
          }
          entries.set(exportName, {
            name: exportName,
            kind: sourceEntry.kind,
            sourceModulePath: sourceEntry.sourceModulePath,
            originalName: sourceEntry.originalName,
            span: spec.span,
          });
        }
      } else if (re.kind === "all") {
        for (const [name, sourceEntry] of sourceTable) {
          if (entries.has(name)) {
            diagnostics.error(
              `Re-exported symbol "${name}" conflicts with another export.`,
              re.span,
              "E0414",
            );
            continue;
          }
          entries.set(name, {
            name,
            kind: sourceEntry.kind,
            sourceModulePath: sourceEntry.sourceModulePath,
            originalName: sourceEntry.originalName,
            span: re.span,
          });
        }
      }
    }

    void privateNames;
    visiting.delete(modulePath);
    visitStack.pop();
    pathToTable.set(modulePath, entries);
    return entries;
  }

  for (const mod of modules) {
    result.set(mod.path, buildOne(mod.path));
  }

  return result;
}

/** Collect re-export source specifiers from a program AST. */
export function collectReExportSpecifiers(ast: Program): readonly {
  specifier: string;
  span: SourceSpan;
  kind: "named" | "all";
  decl: ExportNamedFromDeclaration | ExportAllFromDeclaration;
}[] {
  const out: {
    specifier: string;
    span: SourceSpan;
    kind: "named" | "all";
    decl: ExportNamedFromDeclaration | ExportAllFromDeclaration;
  }[] = [];
  for (const decl of ast.body) {
    if (decl.kind === "ExportNamedFromDeclaration") {
      out.push({
        specifier: decl.source.value,
        span: decl.source.span,
        kind: "named",
        decl,
      });
    } else if (decl.kind === "ExportAllFromDeclaration") {
      out.push({
        specifier: decl.source.value,
        span: decl.source.span,
        kind: "all",
        decl,
      });
    }
  }
  return out;
}

export function isReExportDecl(
  decl: TopLevelDeclaration,
): decl is ExportNamedFromDeclaration | ExportAllFromDeclaration {
  return (
    decl.kind === "ExportNamedFromDeclaration" ||
    decl.kind === "ExportAllFromDeclaration"
  );
}

/** True when `name` is declared in the AST but not exported. */
export function hasPrivateDeclarationInAst(
  ast: Program,
  name: string,
): boolean {
  for (const decl of ast.body) {
    if (
      (decl.kind === "FunctionDeclaration" ||
        decl.kind === "StructDeclaration" ||
        decl.kind === "EnumDeclaration" ||
        decl.kind === "ClassDeclaration" ||
        decl.kind === "InterfaceDeclaration" ||
        decl.kind === "TypeAliasDeclaration" ||
        decl.kind === "ModuleVariableDeclaration") &&
      decl.name.name === name
    ) {
      return !decl.exported;
    }
  }
  return false;
}
