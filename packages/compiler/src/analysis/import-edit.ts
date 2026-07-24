import type { ImportDeclaration, Program } from "../ast/nodes.js";
import type { SourceSpan } from "../diagnostics/diagnostic.js";

export interface ImportTextEdit {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
  /** Local name bound by this import (may be an alias). Set for add-import edits. */
  readonly localName?: string;
}

export interface ComputeNamedImportEditOptions {
  /** Local names already bound in the module (imports + declarations). */
  readonly occupiedNames?: ReadonlySet<string>;
}

/**
 * Compute a text edit that adds `exportName` via a named import from
 * `moduleSpecifier`, merging into an existing named import when possible.
 * When `exportName` conflicts with an occupied local name, uses `as Alias`.
 */
export function computeNamedImportEdit(
  source: string,
  ast: Program | undefined,
  moduleSpecifier: string,
  exportName: string,
  options: ComputeNamedImportEditOptions = {},
): ImportTextEdit | null {
  const localName = pickLocalImportName(
    exportName,
    options.occupiedNames ?? collectOccupiedNames(ast),
  );
  const specifierText =
    localName === exportName ? exportName : `${exportName} as ${localName}`;

  if (ast) {
    for (const decl of ast.body) {
      if (decl.kind !== "ImportDeclaration") {
        continue;
      }
      if (decl.source.value !== moduleSpecifier) {
        continue;
      }
      if (decl.clause.kind !== "NamedImports") {
        continue;
      }
      const already = decl.clause.specifiers.some(
        (s) =>
          s.importedName.name === exportName || s.localName.name === localName,
      );
      if (already) {
        return null;
      }
      const merged = mergeIntoNamedImport(source, decl, specifierText, localName);
      return merged;
    }
  }

  const insertOffset = importInsertOffset(source, ast);
  const line = `import { ${specifierText} } from "${moduleSpecifier}";\n`;
  return {
    startOffset: insertOffset,
    endOffset: insertOffset,
    newText: line,
    localName,
  };
}

function pickLocalImportName(
  exportName: string,
  occupied: ReadonlySet<string>,
): string {
  if (!occupied.has(exportName)) {
    return exportName;
  }
  let n = 2;
  while (occupied.has(`${exportName}${n}`)) {
    n += 1;
  }
  return `${exportName}${n}`;
}

function collectOccupiedNames(ast: Program | undefined): Set<string> {
  const names = new Set<string>();
  if (!ast) {
    return names;
  }
  for (const decl of ast.body) {
    if (decl.kind === "ImportDeclaration") {
      if (decl.clause.kind === "NamespaceImport") {
        if (decl.clause.localName) {
          names.add(decl.clause.localName.name);
        }
      } else {
        for (const spec of decl.clause.specifiers) {
          names.add(spec.localName.name);
        }
      }
      continue;
    }
    if (
      decl.kind === "FunctionDeclaration" ||
      decl.kind === "StructDeclaration" ||
      decl.kind === "EnumDeclaration" ||
      decl.kind === "ClassDeclaration" ||
      decl.kind === "InterfaceDeclaration" ||
      decl.kind === "TypeAliasDeclaration" ||
      decl.kind === "ModuleVariableDeclaration"
    ) {
      names.add(decl.name.name);
    }
  }
  return names;
}

function mergeIntoNamedImport(
  source: string,
  decl: ImportDeclaration,
  specifierText: string,
  localName: string,
): ImportTextEdit | null {
  if (decl.clause.kind !== "NamedImports") {
    return null;
  }
  const specs = decl.clause.specifiers;
  if (specs.length === 0) {
    const newText = `import { ${specifierText} } from "${decl.source.value}";`;
    return {
      startOffset: decl.span.start.offset,
      endOffset: decl.span.end.offset,
      newText,
      localName,
    };
  }

  const last = specs[specs.length - 1]!;
  const insertAt = last.span.end.offset;
  return {
    startOffset: insertAt,
    endOffset: insertAt,
    newText: `, ${specifierText}`,
    localName,
  };
}

function importInsertOffset(source: string, ast: Program | undefined): number {
  if (ast) {
    let lastImportEnd = 0;
    let sawImport = false;
    for (const decl of ast.body) {
      if (decl.kind === "ImportDeclaration") {
        lastImportEnd = decl.span.end.offset;
        sawImport = true;
      } else if (sawImport) {
        break;
      }
    }
    if (sawImport) {
      let offset = lastImportEnd;
      if (source[offset] === "\r") {
        offset += 1;
      }
      if (source[offset] === "\n") {
        offset += 1;
      }
      return offset;
    }
  }

  let offset = 0;
  if (source.startsWith("#!")) {
    const nl = source.indexOf("\n");
    offset = nl >= 0 ? nl + 1 : source.length;
  }
  return offset;
}

export function offsetToPosition(
  source: string,
  offset: number,
): { line: number; character: number } {
  let line = 0;
  let character = 0;
  const clamped = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < clamped; i += 1) {
    if (source[i] === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return { line, character };
}

export type { SourceSpan };
