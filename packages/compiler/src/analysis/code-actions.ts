import type {
  ImportDeclaration,
  ImportSpecifier,
  Program,
} from "../ast/nodes.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { ExportIndexEntry } from "./query.js";
import {
  computeNamedImportEdit,
  type ImportTextEdit,
} from "./import-edit.js";
import type { SemanticModel } from "./semantic.js";

export type CodeActionKind =
  | "quickfix"
  | "quickfix.import"
  | "source.organizeImports";

export interface CodeActionEdit {
  readonly file: string;
  readonly edits: readonly ImportTextEdit[];
}

export interface CodeActionInfo {
  readonly title: string;
  readonly kind: CodeActionKind;
  readonly edits: readonly CodeActionEdit[];
  readonly isPreferred?: boolean;
}

export interface CodeActionsOptions {
  readonly diagnostics?: readonly Diagnostic[];
  readonly exportIndex?: readonly ExportIndexEntry[];
  /** Only offer actions overlapping this range (offsets). */
  readonly rangeStart?: number;
  readonly rangeEnd?: number;
}

/**
 * Collect code actions for a file: add missing import, remove unused import,
 * and organize imports.
 */
export function codeActionsAt(
  model: SemanticModel,
  file: string,
  source: string,
  options: CodeActionsOptions = {},
): CodeActionInfo[] {
  const mod = model.modules.find((m) => m.path === file);
  const actions: CodeActionInfo[] = [];
  const diagnostics = options.diagnostics ?? [];

  // Add missing import for unresolved names.
  if (options.exportIndex) {
    for (const d of diagnostics) {
      if (d.file && d.file !== file) {
        continue;
      }
      if (d.code !== "E0304" && d.code !== "E0307" && d.code !== "E0104") {
        continue;
      }
      const name = extractQuotedName(d.message);
      if (!name) {
        continue;
      }
      const matches = options.exportIndex.filter((e) => e.name === name);
      if (matches.length === 0) {
        continue;
      }
      // Ambiguous: offer one action per provider.
      for (const match of matches) {
        const edit = computeNamedImportEdit(
          source,
          mod?.ast,
          match.moduleSpecifier,
          match.exportName,
        );
        if (!edit) {
          continue;
        }
        actions.push({
          title: `Import '${match.exportName}' from "${match.moduleSpecifier}"`,
          kind: "quickfix.import",
          isPreferred: matches.length === 1,
          edits: [{ file, edits: [edit] }],
        });
      }
    }
  }

  // Remove unused import (E0412).
  for (const d of diagnostics) {
    if (d.file && d.file !== file) {
      continue;
    }
    if (d.code !== "E0412" || !d.span) {
      continue;
    }
    const name = extractQuotedName(d.message);
    if (!name || !mod?.ast) {
      continue;
    }
    const edit = removeNamedImportEdit(source, mod.ast, name);
    if (!edit) {
      continue;
    }
    actions.push({
      title: `Remove unused import '${name}'`,
      kind: "quickfix",
      isPreferred: true,
      edits: [{ file, edits: [edit] }],
    });
  }

  // Organize imports (always available when there are imports).
  if (mod?.ast) {
    const organize = organizeImportsEdits(source, mod.ast, diagnostics, file);
    if (organize.length > 0) {
      actions.push({
        title: "Organize imports",
        kind: "source.organizeImports",
        edits: [{ file, edits: organize }],
      });
    }
  }

  return actions;
}

function extractQuotedName(message: string): string | null {
  const m =
    message.match(/'([^']+)'/) ??
    message.match(/`([^`]+)`/) ??
    message.match(/"([^"]+)"/);
  return m?.[1] ?? null;
}

/**
 * Remove a single named import local (or whole import if it becomes empty).
 */
export function removeNamedImportEdit(
  source: string,
  ast: Program,
  localName: string,
): ImportTextEdit | null {
  for (const decl of ast.body) {
    if (decl.kind !== "ImportDeclaration") {
      continue;
    }
    if (decl.clause.kind === "NamespaceImport") {
      if (decl.clause.localName?.name === localName) {
        return removeWholeImport(source, decl);
      }
      continue;
    }
    const specs = decl.clause.specifiers;
    const idx = specs.findIndex((s) => s.localName.name === localName);
    if (idx < 0) {
      continue;
    }
    if (specs.length === 1) {
      return removeWholeImport(source, decl);
    }
    return removeSpecifierFromImport(source, decl, specs, idx);
  }
  return null;
}

function removeWholeImport(
  source: string,
  decl: ImportDeclaration,
): ImportTextEdit {
  let end = decl.span.end.offset;
  if (source[end] === "\r") {
    end += 1;
  }
  if (source[end] === "\n") {
    end += 1;
  }
  return {
    startOffset: decl.span.start.offset,
    endOffset: end,
    newText: "",
  };
}

function removeSpecifierFromImport(
  source: string,
  decl: ImportDeclaration,
  specs: ImportSpecifier[],
  idx: number,
): ImportTextEdit {
  const target = specs[idx]!;
  let start = target.span.start.offset;
  let end = target.span.end.offset;

  if (idx > 0) {
    // Remove preceding comma / whitespace.
    const prev = specs[idx - 1]!;
    start = prev.span.end.offset;
    // Include comma after prev through target
    end = target.span.end.offset;
  } else {
    // First specifier — remove through following comma.
    const next = specs[idx + 1]!;
    end = next.span.start.offset;
    // Trim trailing whitespace between removed region start and next
    while (end > start && /\s/.test(source[end - 1]!)) {
      // keep
      break;
    }
  }

  // Expand to include comma characters adjacent to the specifier.
  if (idx > 0) {
    // from after previous specifier: skip whitespace+comma before target already in range
  } else if (idx < specs.length - 1) {
    // include comma after first specifier
    let i = end;
    while (i < source.length && /\s/.test(source[i]!)) {
      i += 1;
    }
    if (source[i] === ",") {
      i += 1;
      while (i < source.length && /\s/.test(source[i]!)) {
        i += 1;
      }
      end = i;
    }
  }

  return {
    startOffset: start,
    endOffset: end,
    newText: "",
  };
}

/**
 * Organize imports: remove unused, dedupe, merge same-module named imports, sort.
 * Returns a single replacement edit covering the import block when changes are needed.
 */
export function organizeImportsEdits(
  source: string,
  ast: Program,
  diagnostics: readonly Diagnostic[],
  file: string,
): ImportTextEdit[] {
  const unused = new Set<string>();
  for (const d of diagnostics) {
    if (d.code === "E0412" && (!d.file || d.file === file)) {
      const name = extractQuotedName(d.message);
      if (name) {
        unused.add(name);
      }
    }
  }

  const imports = ast.body.filter(
    (d): d is ImportDeclaration => d.kind === "ImportDeclaration",
  );
  if (imports.length === 0) {
    return [];
  }

  type NamedGroup = {
    specifier: string;
    names: Map<string, string>; // local -> imported
  };
  const sideEffects: string[] = [];
  const namespaces: { alias: string; specifier: string }[] = [];
  const named = new Map<string, NamedGroup>();

  for (const decl of imports) {
    const specifier = decl.source.value;
    if (decl.clause.kind === "NamespaceImport") {
      // Side-effect style without binding isn't represented; namespace always has alias.
      const alias = decl.clause.localName?.name;
      if (alias && !unused.has(alias)) {
        namespaces.push({ alias, specifier });
      }
      continue;
    }
    // Empty named imports aren't typical; treat as side-effect if somehow empty.
    if (decl.clause.specifiers.length === 0) {
      sideEffects.push(specifier);
      continue;
    }
    let group = named.get(specifier);
    if (!group) {
      group = { specifier, names: new Map() };
      named.set(specifier, group);
    }
    for (const spec of decl.clause.specifiers) {
      const local = spec.localName.name;
      if (unused.has(local)) {
        continue;
      }
      // First wins for duplicates.
      if (!group.names.has(local)) {
        group.names.set(local, spec.importedName.name);
      }
    }
  }

  // Drop empty named groups after unused removal.
  for (const [spec, group] of [...named.entries()]) {
    if (group.names.size === 0) {
      named.delete(spec);
    }
  }

  const lines: string[] = [];
  for (const specifier of [...new Set(sideEffects)].sort()) {
    lines.push(`import "${specifier}";`);
  }
  for (const ns of namespaces.sort((a, b) =>
    a.specifier.localeCompare(b.specifier),
  )) {
    lines.push(`import * as ${ns.alias} from "${ns.specifier}";`);
  }
  const namedSpecs = [...named.values()].sort((a, b) =>
    a.specifier.localeCompare(b.specifier),
  );
  for (const group of namedSpecs) {
    const parts = [...group.names.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([local, imported]) =>
        local === imported ? imported : `${imported} as ${local}`,
      );
    lines.push(`import { ${parts.join(", ")} } from "${group.specifier}";`);
  }

  const organized = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const first = imports[0]!;
  const last = imports[imports.length - 1]!;
  let end = last.span.end.offset;
  if (source[end] === "\r") {
    end += 1;
  }
  if (source[end] === "\n") {
    end += 1;
  }
  const current = source.slice(first.span.start.offset, end);
  if (current === organized) {
    return [];
  }
  return [
    {
      startOffset: first.span.start.offset,
      endOffset: end,
      newText: organized,
    },
  ];
}
